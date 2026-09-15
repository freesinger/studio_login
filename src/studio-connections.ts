import { message } from './i18n.js';
import type { LocalizedMessage } from './i18n.js';
import { randomUUID, timingSafeEqual } from 'node:crypto';

import type { RowDataPacket } from 'mysql2/promise';

import type { AppConfig } from './config.js';
import type { Database, DatabaseExecutor } from './db.js';
import { AppError, asErrorMessage } from './errors.js';
import { decryptJson, encryptJson } from './security.js';
import {
  StudioAdminClient,
  type StudioConnection,
  type StudioBillingCatalogItem,
  type StudioDeploymentProfile,
} from './studio-client.js';
import type { Actor, ResourceConfig } from './types.js';

interface ConnectionRow extends RowDataPacket {
  account_id: string;
  connection_id: string;
  name: string;
  is_default: number;
  app_id: string;
  status: string;
  studio_base_url: string | null;
  callback_base_url: string | null;
  integration_token_cipher: string | null;
  ticket_url: string;
  estimate_url: string;
  actual_url: string;
  billing_catalog_json: string | StudioBillingCatalogItem[] | null;
}

export interface BillingCatalogItem extends StudioBillingCatalogItem {
  connectionNames: string[];
}

export interface StudioConnectionView {
  accountId: string;
  connectionId: string;
  name: string;
  isDefault: boolean;
  appId: string;
  status: string;
  studioBaseUrl: string;
  callbackBaseUrl: string;
  tokenConfigured: boolean;
  region: string | null;
  tosRegion: string | null;
}

export interface StudioUsageQueryTarget {
  studioBaseUrl: string;
  lasApiKey: string;
  appId: string;
}

type ReadyConnectionRow = ConnectionRow & {
  studio_base_url: string;
  integration_token_cipher: string;
};

function normalizeBaseUrl(value: string, field: string | LocalizedMessage, production: boolean): string {
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw new AppError(message('connections.invalidUrl', { field: field }), 400, 'INVALID_STUDIO_URL');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)
      || parsed.username || parsed.password || parsed.hash || parsed.search) {
    throw new AppError(message('connections.invalidBaseUrl', { field: field }), 400, 'INVALID_STUDIO_URL');
  }
  if (production && parsed.protocol !== 'https:') {
    throw new AppError(message('connections.httpsRequired', { field: field }), 400, 'INVALID_STUDIO_URL');
  }
  if (production && isPrivateHost(parsed.hostname)) {
    throw new AppError(message('connections.publicUrlRequired', { field: field }), 400, 'INVALID_STUDIO_URL');
  }
  return parsed.toString().replace(/\/$/, '');
}

function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;
  if (host === '::1' || host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe8')) return true;
  const parts = host.split('.').map(Number);
  if (parts.length !== 4 || parts.some(value => !Number.isInteger(value))) return false;
  const [a, b] = parts as [number, number, number, number];
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

function join(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/$/, '')}${path}`;
}

function callbackUrl(
  baseUrl: string,
  path: string,
  connectionId: string,
  appId?: string,
): string {
  const url = new URL(join(baseUrl, path));
  url.searchParams.set('connection_id', connectionId);
  if (appId) url.searchParams.set('app_id', appId);
  return url.toString();
}

function equalSecret(expected: string, supplied: string): boolean {
  const left = Buffer.from(expected);
  const right = Buffer.from(supplied);
  return left.length === right.length && timingSafeEqual(left, right);
}

export class StudioConnectionService {
  constructor(
    private readonly database: Database,
    private readonly config: AppConfig,
    private readonly studioClient: StudioAdminClient,
  ) {}

  async get(accountId: string): Promise<StudioConnectionView | null> {
    const row = await this.findDefaultByAccountId(accountId);
    if (!row) return null;
    const view = this.toView(row);
    if (row.status !== 'READY' || !row.studio_base_url || !row.integration_token_cipher) {
      return view;
    }
    try {
      const deployment = await this.studioClient.getDeploymentProfile(
        this.connectionFromRow(row),
        row.app_id,
      );
      return { ...view, region: deployment.region, tosRegion: deployment.tosRegion };
    } catch {
      return view;
    }
  }

  async list(accountId: string): Promise<StudioConnectionView[]> {
    const rows = await this.database.query<ConnectionRow>(
      `SELECT * FROM studio_registrations
        WHERE account_id = ? AND status <> 'DELETED'
        ORDER BY is_default DESC, created_at, connection_id`,
      [accountId],
    );
    return Promise.all(rows.map(row => this.viewWithDeployment(row)));
  }

  async save(input: {
    accountId: string;
    studioBaseUrl: string;
    callbackBaseUrl: string;
    integrationToken?: string;
    actor: Actor;
  }): Promise<StudioConnectionView> {
    const production = this.config.APP_ENV === 'production';
    const studioBaseUrl = normalizeBaseUrl(input.studioBaseUrl, message('connections.studioUrlLabel'), production);
    const callbackBaseUrl = normalizeBaseUrl(input.callbackBaseUrl, message('connections.callbackUrlLabel'), production);
    const existing = await this.findDefaultByAccountId(input.accountId);
    const appId = this.config.STUDIO_LOGIN_ACCOUNT_ID;
    const connectionId = existing?.connection_id ?? input.accountId;
    const token = (input.integrationToken ?? this.config.LAS_STUDIO_INTEGRATION_TOKEN).trim();
    if (!existing?.integration_token_cipher && !token) {
      throw new AppError(message('connections.tokenRequired'), 400, 'INTEGRATION_TOKEN_REQUIRED');
    }
    if (token && token.length < 32) {
      throw new AppError(message('connections.tokenTooShort'), 400, 'INTEGRATION_TOKEN_TOO_SHORT');
    }

    const ticketUrl = callbackUrl(
      callbackBaseUrl,
      '/api/internal/studio/tickets/verify',
      connectionId,
      appId,
    );
    const estimateUrl = callbackUrl(
      callbackBaseUrl,
      '/api/studio/baseline/tasks',
      connectionId,
    );
    const actualUrl = callbackUrl(
      callbackBaseUrl,
      '/api/studio/baseline/tasks/callback',
      connectionId,
    );
    const encryptedToken = token
      ? encryptJson(token, this.config.encryptionKey)
      : existing?.integration_token_cipher;

    await this.database.transaction(async tx => {
      await this.lockAccount(tx, input.accountId);
      await this.assertStudioInstanceAvailable(
        tx,
        input.accountId,
        studioBaseUrl,
        existing?.connection_id,
      );
      await tx.execute(
        `INSERT INTO studio_registrations
          (account_id, connection_id, name, is_default, app_id, status,
           studio_base_url, callback_base_url, integration_token_cipher,
           ticket_url, estimate_url, actual_url, registered_by)
         VALUES (?, ?, '默认连接', TRUE, ?, 'CONFIGURED', ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           is_default = TRUE, status = 'CONFIGURED', studio_base_url = VALUES(studio_base_url),
           callback_base_url = VALUES(callback_base_url),
           integration_token_cipher = VALUES(integration_token_cipher),
           ticket_url = VALUES(ticket_url), estimate_url = VALUES(estimate_url),
           actual_url = VALUES(actual_url), registered_by = VALUES(registered_by), last_error = NULL`,
        [input.accountId, connectionId, appId,
          studioBaseUrl, callbackBaseUrl, encryptedToken,
          ticketUrl, estimateUrl, actualUrl, input.actor.userId],
      );
    });
    const saved = await this.findDefaultByAccountId(input.accountId);
    if (!saved) throw new AppError(message('connections.saveFailed'), 500, 'STUDIO_CONFIG_SAVE_FAILED');
    return this.toView(saved);
  }

  async create(input: {
    accountId: string;
    name: string;
    studioBaseUrl: string;
    callbackBaseUrl: string;
    actor: Actor;
  }): Promise<StudioConnectionView> {
    const connectionId = `conn_${randomUUID().replaceAll('-', '')}`;
    const isDefault = !(await this.findDefaultByAccountId(input.accountId));
    await this.saveNamed({
      ...input,
      connectionId,
      integrationToken: this.config.LAS_STUDIO_INTEGRATION_TOKEN,
      isDefault,
    });
    await this.registerById(input.accountId, connectionId, input.actor);
    return this.requireView(input.accountId, connectionId);
  }

  async update(input: {
    accountId: string;
    connectionId: string;
    name: string;
    studioBaseUrl: string;
    callbackBaseUrl: string;
    actor: Actor;
  }): Promise<StudioConnectionView> {
    await this.saveNamed({
      ...input,
      integrationToken: this.config.LAS_STUDIO_INTEGRATION_TOKEN,
      isDefault: Boolean((await this.findById(input.accountId, input.connectionId))?.is_default),
    });
    await this.registerById(input.accountId, input.connectionId, input.actor);
    return this.requireView(input.accountId, input.connectionId);
  }

  private async saveNamed(input: {
    accountId: string;
    connectionId: string;
    name: string;
    studioBaseUrl: string;
    callbackBaseUrl: string;
    integrationToken: string;
    isDefault: boolean;
    actor: Actor;
  }): Promise<void> {
    const production = this.config.APP_ENV === 'production';
    const studioBaseUrl = normalizeBaseUrl(input.studioBaseUrl, message('connections.studioUrlLabel'), production);
    const callbackBaseUrl = normalizeBaseUrl(input.callbackBaseUrl, message('connections.callbackUrlLabel'), production);
    const existing = await this.findById(input.accountId, input.connectionId);
    const appId = this.config.STUDIO_LOGIN_ACCOUNT_ID;
    const name = input.name.trim();
    if (!name) {
      throw new AppError(message('connections.nameRequired'), 400, 'CONNECTION_NAME_REQUIRED');
    }
    const ticketUrl = callbackUrl(
      callbackBaseUrl,
      '/api/internal/studio/tickets/verify',
      input.connectionId,
      appId,
    );
    const values = [
      name,
      studioBaseUrl,
      callbackBaseUrl,
      encryptJson(input.integrationToken, this.config.encryptionKey),
      ticketUrl,
      callbackUrl(callbackBaseUrl, '/api/studio/baseline/tasks', input.connectionId),
      callbackUrl(callbackBaseUrl, '/api/studio/baseline/tasks/callback', input.connectionId),
      input.actor.userId,
    ];
    await this.database.transaction(async tx => {
      await this.lockAccount(tx, input.accountId);
      await this.assertStudioInstanceAvailable(
        tx,
        input.accountId,
        studioBaseUrl,
        input.connectionId,
      );
      if (existing) {
        const result = await tx.execute(
          `UPDATE studio_registrations
              SET name = ?, is_default = ?, status = 'CONFIGURED', studio_base_url = ?,
                  callback_base_url = ?, integration_token_cipher = ?, ticket_url = ?,
                  estimate_url = ?, actual_url = ?, registered_by = ?, last_error = NULL
            WHERE account_id = ? AND connection_id = ?`,
          [name, input.isDefault, ...values.slice(1), input.accountId, input.connectionId],
        );
        if (result.affectedRows !== 1) {
          throw new AppError(message('connections.notFound'), 404, 'STUDIO_CONNECTION_NOT_FOUND');
        }
        return;
      }
      await tx.execute(
        `INSERT INTO studio_registrations
          (account_id, connection_id, name, is_default, app_id, status,
           studio_base_url, callback_base_url, integration_token_cipher,
           ticket_url, estimate_url, actual_url, registered_by)
         VALUES (?, ?, ?, ?, ?, 'CONFIGURED', ?, ?, ?, ?, ?, ?, ?)`,
        [
          input.accountId,
          input.connectionId,
          name,
          input.isDefault,
          appId,
          ...values.slice(1),
        ],
      );
    });
  }

  async register(accountId: string, actor: Actor): Promise<{
    accountId: string;
    appId: string;
    status: string;
    idempotent: boolean;
  }> {
    const row = await this.findDefaultByAccountId(accountId);
    if (!row) throw new AppError(message('connections.notFound'), 404, 'STUDIO_CONNECTION_NOT_FOUND');
    return this.registerById(accountId, row.connection_id, actor);
  }

  async registerById(accountId: string, connectionId: string, actor: Actor): Promise<{
    accountId: string;
    appId: string;
    status: string;
    idempotent: boolean;
  }> {
    const claim = await this.database.transaction(async tx => {
      const rows = await tx.query<ConnectionRow>(
        'SELECT * FROM studio_registrations WHERE account_id = ? AND connection_id = ? FOR UPDATE',
        [accountId, connectionId],
      );
      const row = rows[0];
      if (!row?.studio_base_url || !row.callback_base_url || !row.integration_token_cipher) {
        throw new AppError(message('connections.setupRequired'), 409, 'STUDIO_NOT_CONFIGURED');
      }
      if (row.status === 'PENDING') {
        throw new AppError(message('connections.registrationInProgress'), 409, 'REGISTRATION_IN_PROGRESS');
      }
      await tx.execute(
        "UPDATE studio_registrations SET status = 'PENDING', registered_by = ?, last_error = NULL WHERE connection_id = ?",
        [actor.userId, connectionId],
      );
      return row;
    });
    const connection = this.connectionFromRow(claim);
    try {
      await this.studioClient.registerApplication(connection, {
        appId: claim.app_id,
        ticketUrl: claim.ticket_url,
      });
      await this.registerUsageEndpointsForCurrentGroups(connection, claim);
      await this.refreshBillingCatalogRow(claim).catch(async error => {
        await this.database.execute(
          'UPDATE studio_registrations SET billing_catalog_error = ? WHERE connection_id = ?',
          [asErrorMessage(error).slice(0, 512), connectionId],
        );
      });
      await this.database.execute(
        "UPDATE studio_registrations SET status = 'READY', last_error = NULL WHERE connection_id = ?",
        [connectionId],
      );
      return { accountId, appId: claim.app_id, status: 'READY', idempotent: false };
    } catch (error) {
      await this.database.execute(
        "UPDATE studio_registrations SET status = 'FAILED', last_error = ? WHERE connection_id = ?",
        [asErrorMessage(error).slice(0, 512), connectionId],
      );
      throw error;
    }
  }

  async upsertUserProfile(
    accountId: string,
    connectionId: string,
    projectId: string,
    userId: string,
    resourceConfig: ResourceConfig,
    projectLevelSharing: boolean,
  ): Promise<void> {
    const row = await this.requireReadyRowById(accountId, connectionId);
    const connection = this.connectionFromRow(row);
    await this.studioClient.upsertUserProfile(connection, {
      appId: row.app_id,
      projectId,
      userId,
      projectLevelSharing,
      config: resourceConfig,
    });
  }

  async upsertProjectProfile(
    accountId: string,
    connectionId: string,
    projectId: string,
    resourceConfig: ResourceConfig,
    projectLevelSharing: boolean,
  ): Promise<void> {
    const row = await this.requireReadyRowById(accountId, connectionId);
    const connection = this.connectionFromRow(row);
    await this.studioClient.upsertProjectProfile(connection, {
      appId: row.app_id,
      projectId,
      projectLevelSharing,
      config: resourceConfig,
    });
  }

  async deleteUserProfile(
    accountId: string,
    connectionId: string,
    projectId: string,
    userId: string,
  ): Promise<void> {
    const row = await this.requireReadyRowById(accountId, connectionId);
    await this.studioClient.deleteUserProfile(this.connectionFromRow(row), {
      appId: row.app_id,
      projectId,
      userId,
    });
  }

  async deploymentProfile(accountId: string, connectionId?: string): Promise<StudioDeploymentProfile> {
    const row = connectionId
      ? await this.requireReadyRowById(accountId, connectionId)
      : await this.requireReadyRow(accountId);
    return this.studioClient.getDeploymentProfile(this.connectionFromRow(row), row.app_id);
  }

  async resourceProfile(
    accountId: string,
    connectionId: string,
    projectId: string,
  ): Promise<ResourceConfig> {
    const row = await this.requireReadyRowById(accountId, connectionId);
    return this.studioClient.getResourceProfile(this.connectionFromRow(row), {
      appId: row.app_id,
      projectId,
    });
  }

  async billingCatalog(accountId: string): Promise<BillingCatalogItem[]> {
    const rows = await this.database.query<ConnectionRow>(
      `SELECT * FROM studio_registrations
        WHERE account_id = ? AND status = 'READY'
        ORDER BY name, connection_id`,
      [accountId],
    );
    for (const row of rows) {
      await this.refreshBillingCatalogRow(row).catch(async error => {
        await this.database.execute(
          'UPDATE studio_registrations SET billing_catalog_error = ? WHERE connection_id = ?',
          [asErrorMessage(error).slice(0, 512), row.connection_id],
        );
      });
    }
    const refreshed = await this.database.query<ConnectionRow>(
      `SELECT * FROM studio_registrations
        WHERE account_id = ? AND status = 'READY'
        ORDER BY name, connection_id`,
      [accountId],
    );
    const merged = new Map<string, BillingCatalogItem>();
    for (const row of refreshed) {
      for (const item of this.catalogFromRow(row)) {
        const key = `${item.billingItemId}\u0000${item.unit}`;
        const current = merged.get(key) ?? {
          ...item,
          operatorIds: [],
          connectionNames: [],
        };
        current.operatorIds = [...new Set([...current.operatorIds, ...item.operatorIds])].sort();
        current.connectionNames.push(row.name);
        merged.set(key, current);
      }
    }
    if (rows.length > 0 && merged.size === 0) {
      throw new AppError(message('studio.billingCatalogUnavailable'), 502, 'STUDIO_BILLING_CATALOG_UNAVAILABLE');
    }
    return [...merged.values()].sort((left, right) =>
      left.billingItemId.localeCompare(right.billingItemId) || left.unit.localeCompare(right.unit));
  }

  async assertBillingCatalogItem(accountId: string, billingItemId: string, unit: string): Promise<void> {
    const catalog = await this.billingCatalog(accountId);
    if (!catalog.some(item => item.billingItemId === billingItemId && item.unit === unit)) {
      throw new AppError(message('studio.billingItemUnsupported'), 400, 'BILLING_ITEM_NOT_SUPPORTED');
    }
  }

  async assertConnectionBillingCatalogItems(
    connectionId: string,
    appId: string,
    items: Array<{ BillingItemId: string; Unit: string }>,
  ): Promise<void> {
    const row = await this.requireReadyRowByAppId(appId, connectionId);
    await this.refreshBillingCatalogRow(row).catch(() => undefined);
    const refreshed = await this.requireReadyRowByAppId(appId, connectionId);
    const supported = new Set(this.catalogFromRow(refreshed)
      .map(item => `${item.billingItemId}\u0000${item.unit}`));
    for (const item of items) {
      if (!supported.has(`${item.BillingItemId}\u0000${item.Unit}`)) {
        throw new AppError(
          message('studio.unsupportedBillingItem', { billingItemId: item.BillingItemId, unit: item.Unit }),
          400,
          'BILLING_ITEM_NOT_SUPPORTED',
        );
      }
    }
  }

  async registerUsageEndpoint(accountId: string, connectionId: string, lasApiKey: string): Promise<void> {
    const normalizedApiKey = lasApiKey.trim();
    if (!normalizedApiKey) {
      throw new AppError(message('groups.lasKeyRequired'), 400, 'LAS_API_KEY_REQUIRED');
    }
    const row = await this.requireReadyRowById(accountId, connectionId);
    await this.registerUsageEndpointForRow(this.connectionFromRow(row), row, normalizedApiKey);
  }

  async verifyCallbackToken(
    connectionId: string,
    appId: string,
    supplied: string,
    loginName: string,
    requestId?: string,
  ): Promise<boolean> {
    if (!connectionId || appId !== this.config.STUDIO_LOGIN_ACCOUNT_ID || !supplied || !loginName) {
      return false;
    }
    const lasApiKey = requestId
      ? await this.resourceLasApiKeyForTaskByLoginName(connectionId, appId, loginName, requestId)
        ?? await this.resourceLasApiKeyForUser(connectionId, appId, loginName)
      : await this.resourceLasApiKeyForUser(connectionId, appId, loginName);
    if (!lasApiKey) return false;
    return equalSecret(lasApiKey, supplied.trim());
  }

  async usageQueryTarget(
    connectionId: string,
    appId: string,
    userId: string,
    requestId: string,
  ): Promise<StudioUsageQueryTarget> {
    const row = await this.requireReadyRowByAppId(appId, connectionId);
    const lasApiKey = await this.resourceLasApiKeyForTask(connectionId, appId, userId, requestId);
    if (!lasApiKey) {
      throw new AppError(message('studio.usageKeyNotReady'), 409, 'STUDIO_USAGE_QUERY_NOT_READY');
    }
    return {
      studioBaseUrl: row.studio_base_url,
      lasApiKey,
      appId: row.app_id,
    };
  }

  async entryConnection(accountId: string, connectionId: string): Promise<{
    studioBaseUrl: string;
    appId: string;
  }> {
    const row = await this.findById(accountId, connectionId);
    if (!row?.studio_base_url || row.status !== 'READY') {
      throw new AppError(message('studio.notReady'), 409, 'STUDIO_LOGIN_NOT_READY');
    }
    return { studioBaseUrl: row.studio_base_url, appId: row.app_id };
  }

  async accountIdForAppId(appId: string): Promise<string | null> {
    const rows = await this.database.query<{ account_id: string } & RowDataPacket>(
      `SELECT account_id FROM studio_registrations
        WHERE app_id = ? AND status <> 'DELETED' LIMIT 1`,
      [appId],
    );
    return rows[0]?.account_id ?? null;
  }

  async delete(accountId: string, connectionId: string): Promise<{ status: string }> {
    const row = await this.findById(accountId, connectionId);
    if (!row) {
      throw new AppError(message('connections.notFound'), 404, 'STUDIO_CONNECTION_NOT_FOUND');
    }
    if (row.status === 'DELETED') return { status: 'DELETED' };
    const refs = await this.database.query<{ count: number } & RowDataPacket>(
      `SELECT COUNT(*) AS count FROM config_groups
        WHERE connection_id = ? AND status <> 'DELETED'`,
      [connectionId],
    );
    if (Number(refs[0]?.count) > 0) {
      throw new AppError(message('connections.inUse'), 409, 'STUDIO_CONNECTION_IN_USE');
    }
    try {
      const sibling = row.studio_base_url
        ? await this.findByStudioBaseUrl(accountId, row.studio_base_url, connectionId)
        : undefined;
      if (!sibling) {
        await this.studioClient.unregisterApplication(this.connectionFromRow(row), row.app_id);
      }
      await this.database.transaction(async tx => {
        await tx.execute(
          `UPDATE studio_registrations
              SET status = 'DELETED', is_default = FALSE,
                  integration_token_cipher = NULL, last_error = NULL
            WHERE connection_id = ?`,
          [connectionId],
        );
        if (row.is_default) {
          const replacements = await tx.query<ConnectionRow>(
            `SELECT * FROM studio_registrations
              WHERE account_id = ? AND status <> 'DELETED'
              ORDER BY created_at, connection_id LIMIT 1
              FOR UPDATE`,
            [accountId],
          );
          if (replacements[0]) {
            await tx.execute(
              'UPDATE studio_registrations SET is_default = TRUE WHERE connection_id = ?',
              [replacements[0].connection_id],
            );
          }
        }
      });
      return { status: 'DELETED' };
    } catch (error) {
      await this.database.execute(
        "UPDATE studio_registrations SET status = 'DELETE_FAILED', last_error = ? WHERE connection_id = ?",
        [asErrorMessage(error).slice(0, 512), connectionId],
      );
      throw error;
    }
  }

  private async requireReadyRow(accountId: string): Promise<ReadyConnectionRow> {
    const row = await this.findDefaultByAccountId(accountId);
    if (!row || row.status !== 'READY') {
      throw new AppError(message('connections.registrationRequired'), 409, 'STUDIO_NOT_REGISTERED');
    }
    if (!row.studio_base_url || !row.integration_token_cipher) {
      throw new AppError(message('connections.incomplete'), 409, 'STUDIO_NOT_CONFIGURED');
    }
    return row as ReadyConnectionRow;
  }

  private async requireReadyRowById(
    accountId: string,
    connectionId: string,
  ): Promise<ReadyConnectionRow> {
    const row = await this.findById(accountId, connectionId);
    if (!row || row.status !== 'READY') {
      throw new AppError(message('connections.registrationRequired'), 409, 'STUDIO_NOT_REGISTERED');
    }
    if (!row.studio_base_url || !row.integration_token_cipher) {
      throw new AppError(message('connections.incomplete'), 409, 'STUDIO_NOT_CONFIGURED');
    }
    return row as ReadyConnectionRow;
  }

  private async requireReadyRowByAppId(
    appId: string,
    connectionId: string,
  ): Promise<ReadyConnectionRow> {
    const rows = await this.database.query<ConnectionRow>(
      `SELECT * FROM studio_registrations
        WHERE app_id = ? AND connection_id = ? AND status <> 'DELETED' LIMIT 1`,
      [appId, connectionId],
    );
    const row = rows[0];
    if (!row || row.status !== 'READY' || !row.studio_base_url || !row.integration_token_cipher) {
      throw new AppError(message('studio.usageConnectionNotReady'), 409, 'STUDIO_USAGE_QUERY_NOT_READY');
    }
    return row as ReadyConnectionRow;
  }

  private async registerUsageEndpointsForCurrentGroups(
    connection: StudioConnection,
    row: ConnectionRow,
  ): Promise<void> {
    const rows = await this.database.query<{ encrypted_config: string } & RowDataPacket>(
      `SELECT v.encrypted_config
         FROM config_groups g
         JOIN config_group_versions v ON v.config_group_id = g.config_group_id
          AND v.version = g.current_version
        WHERE g.account_id = ? AND g.connection_id = ?
          AND g.status IN ('AVAILABLE', 'PARTIAL_FAILED')`,
      [row.account_id, row.connection_id],
    );
    const apiKeys = new Set<string>();
    for (const current of rows) {
      const lasApiKey = decryptJson<ResourceConfig>(
        current.encrypted_config,
        this.config.encryptionKey,
      ).lasApiKey?.trim();
      if (lasApiKey) apiKeys.add(lasApiKey);
    }
    for (const lasApiKey of apiKeys) {
      await this.registerUsageEndpointForRow(connection, row, lasApiKey);
    }
  }

  private async refreshBillingCatalogRow(row: ConnectionRow): Promise<void> {
    const items = await this.studioClient.getBillingCatalog(this.connectionFromRow(row), row.app_id);
    await this.database.execute(
      `UPDATE studio_registrations
          SET billing_catalog_json = ?, billing_catalog_synced_at = CURRENT_TIMESTAMP(3),
              billing_catalog_error = NULL
        WHERE connection_id = ?`,
      [JSON.stringify(items), row.connection_id],
    );
  }

  private catalogFromRow(row: ConnectionRow): StudioBillingCatalogItem[] {
    if (!row.billing_catalog_json) return [];
    try {
      const parsed = typeof row.billing_catalog_json === 'string'
        ? JSON.parse(row.billing_catalog_json) as unknown
        : row.billing_catalog_json;
      return Array.isArray(parsed) ? parsed as StudioBillingCatalogItem[] : [];
    } catch {
      return [];
    }
  }

  private async registerUsageEndpointForRow(
    connection: StudioConnection,
    row: ConnectionRow,
    lasApiKey: string,
  ): Promise<void> {
    await this.studioClient.registerUsageEndpoint(connection, {
      appId: row.app_id,
      estimateUrl: row.estimate_url,
      actualUrl: row.actual_url,
      lasApiKey,
    });
  }

  private async resourceLasApiKeyForUser(
    connectionId: string,
    appId: string,
    loginName: string,
  ): Promise<string | null> {
    return this.resourceLasApiKeyFromQuery(
      `SELECT v.encrypted_config
         FROM users u
         JOIN user_config_group_bindings b ON b.user_id = u.user_id
         JOIN config_groups g ON g.config_group_id = b.config_group_id AND g.account_id = u.account_id
         JOIN studio_registrations r ON r.connection_id = g.connection_id
         JOIN config_group_versions v ON v.config_group_id = g.config_group_id
          AND v.version = g.current_version
        WHERE r.connection_id = ? AND r.app_id = ? AND u.login_name = ? AND u.status = 'ACTIVE'
          AND g.status IN ('AVAILABLE', 'PARTIAL_FAILED')
        LIMIT 1`,
      [connectionId, appId, loginName],
    );
  }

  private async resourceLasApiKeyForTaskByLoginName(
    connectionId: string,
    appId: string,
    loginName: string,
    requestId: string,
  ): Promise<string | null> {
    return this.resourceLasApiKeyFromQuery(
      `SELECT v.encrypted_config
         FROM studio_tasks t
         JOIN users u ON u.user_id = t.user_id
         JOIN config_group_versions v ON v.config_group_id = t.config_group_id
          AND v.version = t.config_group_version
        WHERE t.connection_id = ? AND t.app_id = ? AND u.login_name = ? AND t.request_id = ?
        LIMIT 1`,
      [connectionId, appId, loginName, requestId],
    );
  }

  private async resourceLasApiKeyForTask(
    connectionId: string,
    appId: string,
    userId: string,
    requestId: string,
  ): Promise<string | null> {
    return this.resourceLasApiKeyFromQuery(
      `SELECT v.encrypted_config
         FROM studio_tasks t
         JOIN config_group_versions v ON v.config_group_id = t.config_group_id
          AND v.version = t.config_group_version
        WHERE t.connection_id = ? AND t.app_id = ? AND t.user_id = ? AND t.request_id = ?
        LIMIT 1`,
      [connectionId, appId, userId, requestId],
    );
  }

  private async resourceLasApiKeyFromQuery(sql: string, params: readonly unknown[]): Promise<string | null> {
    const rows = await this.database.query<{ encrypted_config: string } & RowDataPacket>(sql, params);
    const encrypted = rows[0]?.encrypted_config;
    if (!encrypted) return null;
    return decryptJson<ResourceConfig>(encrypted, this.config.encryptionKey).lasApiKey?.trim() ?? null;
  }

  private connectionFromRow(row: ConnectionRow): StudioConnection {
    if (!row.studio_base_url || !row.integration_token_cipher) {
      throw new AppError(message('connections.incomplete'), 409, 'STUDIO_NOT_CONFIGURED');
    }
    return {
      studioBaseUrl: row.studio_base_url,
      integrationToken: decryptJson<string>(row.integration_token_cipher, this.config.encryptionKey),
    };
  }

  private async findDefaultByAccountId(accountId: string): Promise<ConnectionRow | undefined> {
    const rows = await this.database.query<ConnectionRow>(
      `SELECT * FROM studio_registrations
        WHERE account_id = ? AND is_default = TRUE AND status <> 'DELETED' LIMIT 1`,
      [accountId],
    );
    return rows[0];
  }

  private async findById(accountId: string, connectionId: string): Promise<ConnectionRow | undefined> {
    const rows = await this.database.query<ConnectionRow>(
      'SELECT * FROM studio_registrations WHERE account_id = ? AND connection_id = ? LIMIT 1',
      [accountId, connectionId],
    );
    return rows[0];
  }

  private async lockAccount(executor: DatabaseExecutor, accountId: string): Promise<void> {
    await executor.query<RowDataPacket>(
      'SELECT account_id FROM accounts WHERE account_id = ? FOR UPDATE',
      [accountId],
    );
  }

  private async assertStudioInstanceAvailable(
    executor: DatabaseExecutor,
    accountId: string,
    studioBaseUrl: string,
    excludedConnectionId?: string,
  ): Promise<void> {
    const rows = await executor.query<ConnectionRow>(
      `SELECT * FROM studio_registrations
        WHERE account_id = ? AND studio_base_url = ? AND status <> 'DELETED'
          AND connection_id <> ?
        LIMIT 1`,
      [accountId, studioBaseUrl, excludedConnectionId ?? ''],
    );
    if (rows[0]) {
      throw new AppError(
        message('connections.instanceAlreadyRegistered', { name: rows[0].name }),
        409,
        'STUDIO_INSTANCE_ALREADY_REGISTERED',
      );
    }
  }

  private async findByStudioBaseUrl(
    accountId: string,
    studioBaseUrl: string,
    excludedConnectionId: string,
  ): Promise<ConnectionRow | undefined> {
    const rows = await this.database.query<ConnectionRow>(
      `SELECT * FROM studio_registrations
        WHERE account_id = ? AND studio_base_url = ? AND status <> 'DELETED'
          AND connection_id <> ?
        LIMIT 1`,
      [accountId, studioBaseUrl, excludedConnectionId],
    );
    return rows[0];
  }

  private async requireView(accountId: string, connectionId: string): Promise<StudioConnectionView> {
    const row = await this.findById(accountId, connectionId);
    if (!row) throw new AppError(message('connections.notFound'), 404, 'STUDIO_CONNECTION_NOT_FOUND');
    return this.toView(row);
  }

  private async viewWithDeployment(row: ConnectionRow): Promise<StudioConnectionView> {
    const view = this.toView(row);
    if (row.status !== 'READY' || !row.studio_base_url || !row.integration_token_cipher) {
      return view;
    }
    try {
      const deployment = await this.studioClient.getDeploymentProfile(
        this.connectionFromRow(row),
        row.app_id,
      );
      return { ...view, region: deployment.region, tosRegion: deployment.tosRegion };
    } catch {
      return view;
    }
  }

  private toView(row: ConnectionRow): StudioConnectionView {
    return {
      accountId: row.account_id,
      connectionId: row.connection_id,
      name: row.name,
      isDefault: Boolean(row.is_default),
      appId: row.app_id,
      status: row.status,
      studioBaseUrl: row.studio_base_url ?? '',
      callbackBaseUrl: row.callback_base_url ?? '',
      tokenConfigured: Boolean(row.integration_token_cipher),
      region: null,
      tosRegion: null,
    };
  }
}
