import { randomUUID } from 'node:crypto';

import { Decimal } from 'decimal.js';
import type { RowDataPacket } from 'mysql2/promise';

import { formatMessage, translate, type Locale, type LocalizedMessage, message } from './i18n.js';
import type { Database, DatabaseExecutor } from './db.js';
import { AppError } from './errors.js';
import { noopLogger, type AppLogger } from './logging.js';
import { currentBillingPeriod } from './quota.js';
import { decryptJson } from './security.js';
import { DEFAULT_PRICES, type DefaultPrices } from './deployment.js';
import type { AppConfig } from './config.js';
import type { Actor, ResourceConfig } from './types.js';

export interface BaselineItemInput {
  BillingItemId: string;
  Unit: string;
  Usage: number | string;
  ModelId?: string;
  BillingContext?: string;
}

export interface BaselinePrecheckInput {
  RequestId: string;
  UserId: string;
  ProjectId?: string;
  Items: BaselineItemInput[];
}

export interface BaselineCallbackInput extends BaselinePrecheckInput {
  Status: 'SUCCEEDED' | 'FAILED' | 'CANCELLED';
}

interface PriceRow extends RowDataPacket {
  billing_item_id: string;
  unit: string;
  customer_unit_price: string;
  cost_unit_price: string;
  scope_type?: string;
}

interface AdminPriceRow extends RowDataPacket {
  scope_type: PriceScopeType;
  scope_id: string;
  scope_name: string | null;
  billing_item_id: string;
  unit: string;
  customer_unit_price: string;
  cost_unit_price: string;
  enabled: number;
  updated_at: Date;
}

interface BillingUserRow extends RowDataPacket {
  user_id: string;
  login_name: string;
  account_id: string;
  connection_app_id: string;
  status: string;
  config_group_id: string | null;
  project_id: string;
  profile_sync_version: number | null;
  monthly_limit: string | null;
  binding_monthly_limit: string | null;
  binding_profile_sync_version: number | null;
  group_status: string | null;
  current_version: number | null;
  group_monthly_limit: string | null;
  encrypted_config: string;
}

interface TaskRow extends RowDataPacket {
  task_id: string;
  connection_id: string;
  app_id: string;
  user_id: string;
  request_id: string;
  config_group_id: string;
  config_group_version: number;
  billing_period: string;
  status: string;
  estimated_amount: string;
  billing_audit_payload: string | Record<string, unknown> | null;
  login_name?: string;
}

interface TaskItemRow extends RowDataPacket {
  item_index: number;
  billing_item_id: string;
  model_id: string | null;
  unit: string;
  customer_unit_price: string;
  cost_unit_price: string;
  estimated_billing_context: string | Record<string, unknown> | null;
  actual_billing_context: string | Record<string, unknown> | null;
}

interface UsageRow extends RowDataPacket {
  subject_type: string;
  subject_id: string;
  reserved_amount: string;
  actual_amount: string;
}

interface PriceSnapshot {
  itemIndex: number;
  billingItemId: string;
  modelId: string | null;
  unit: string;
  estimatedUsage: Decimal;
  customerUnitPrice: Decimal;
  costUnitPrice: Decimal;
  estimatedAmount: Decimal;
  estimatedCost: Decimal;
}

interface LimitCheckContext {
  logger: AppLogger;
  requestId: string;
  connectionId: string;
  appId: string;
  loginName: string;
  userId: string;
  configGroupId: string;
  billingPeriod: string;
  subjectType: 'CONFIG_GROUP' | 'USER';
  label: string | LocalizedMessage;
}

export type PriceScopeType = 'CONFIG_GROUP' | 'PLATFORM';

export interface ReconciliationAudit {
  request: {
    method: 'POST';
    url: string;
    body: Record<string, unknown>;
  };
  response: {
    httpStatus: number | null;
    body: unknown;
  };
}

interface BillingAuditPayload {
  version: 1;
  settlement?: {
    source: 'callback' | 'reconciliation';
    requestBody: BaselineCallbackInput;
    responseBody: {
      code: 200;
      message: 'success';
      requestId: string;
    };
    recordedAt: string;
  };
  reconciliationQueries?: Array<ReconciliationAudit & {
    recordedAt: string;
  }>;
}

function amount(value: Decimal): string {
  return value.toDecimalPlaces(6, Decimal.ROUND_HALF_UP).toFixed(6);
}

function usage(value: number | string): Decimal {
  const parsed = new Decimal(value);
  if (!parsed.isFinite() || parsed.lte(0)) {
    throw new AppError(message('billing.invalidUsage'), 400, 'INVALID_USAGE');
  }
  return parsed;
}

function billingContext(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  try {
    return JSON.stringify(JSON.parse(trimmed));
  } catch {
    return JSON.stringify({ raw: trimmed.slice(0, 10_000) });
  }
}

function billingAuditPayload(value: unknown): BillingAuditPayload {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return { version: 1, ...value } as BillingAuditPayload;
  }
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return { version: 1, ...parsed } as BillingAuditPayload;
      }
    } catch {
      // Ignore malformed historical values and replace them with a valid audit document.
    }
  }
  return { version: 1 };
}

function billingContextObject(value: string | undefined): Record<string, unknown> | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function optionalText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function billingContextProjectId(item: BaselineItemInput): string | undefined {
  const context = billingContextObject(item.BillingContext);
  if (!context) return undefined;
  const extensions = [context.extensions, context.extentions]
    .find(value => value && typeof value === 'object' && !Array.isArray(value)) as Record<string, unknown> | undefined;
  const projectId = optionalText(extensions?.project_id) ?? optionalText(extensions?.projectId);
  if (projectId && projectId.length > 128) {
    throw new AppError(message('billing.projectIdTooLong'), 400, 'BILLING_PROJECT_INVALID');
  }
  return projectId;
}

export function baselineProjectId(input: Pick<BaselinePrecheckInput, 'Items' | 'ProjectId'>): string | undefined {
  const projectIds = new Set<string>();
  for (const item of input.Items ?? []) {
    const projectId = billingContextProjectId(item);
    if (projectId) projectIds.add(projectId);
  }
  if (projectIds.size > 1) {
    throw new AppError(message('billing.projectMismatch'), 400, 'BILLING_PROJECT_MISMATCH');
  }
  const [projectId] = projectIds;
  return projectId ?? optionalText(input.ProjectId);
}

async function resolvePrice(
  tx: DatabaseExecutor,
  configGroupId: string,
  item: BaselineItemInput,
  itemIndex: number,
  defaults: DefaultPrices,
): Promise<PriceSnapshot> {
  const rows = await tx.query<PriceRow>(
    `SELECT billing_item_id, unit, customer_unit_price, cost_unit_price
       FROM operator_prices
      WHERE ((scope_type = 'CONFIG_GROUP' AND scope_id = ?)
          OR (scope_type = 'PLATFORM' AND scope_id = '*'))
        AND billing_item_id = ?
        AND unit = ?
        AND enabled = TRUE
      ORDER BY CASE WHEN scope_type = 'CONFIG_GROUP' THEN 0 ELSE 1 END
      LIMIT 1`,
    [configGroupId, item.BillingItemId, item.Unit],
  );
  const row = rows[0] ?? {
    billing_item_id: item.BillingItemId,
    unit: item.Unit,
    customer_unit_price: defaults.customerUnitPrice,
    cost_unit_price: defaults.costUnitPrice,
    scope_type: 'BUILTIN_DEFAULT',
  };
  const estimatedUsage = usage(item.Usage);
  const customerUnitPrice = new Decimal(row.customer_unit_price);
  const costUnitPrice = new Decimal(row.cost_unit_price);
  return {
    itemIndex,
    billingItemId: row.billing_item_id,
    modelId: item.ModelId?.trim() || null,
    unit: row.unit,
    estimatedUsage,
    customerUnitPrice,
    costUnitPrice,
    estimatedAmount: customerUnitPrice.mul(estimatedUsage),
    estimatedCost: costUnitPrice.mul(estimatedUsage),
  };
}

async function lockUsage(
  tx: DatabaseExecutor,
  appId: string,
  groupId: string,
  userSubjectId: string,
  period: string,
): Promise<Map<string, UsageRow>> {
  const subjects = [
    { type: 'CONFIG_GROUP', id: groupId },
    { type: 'USER_CONFIG_GROUP', id: userSubjectId },
  ];
  for (const subject of subjects) {
    await tx.execute(
      `INSERT IGNORE INTO period_usage
        (app_id, subject_type, subject_id, billing_period, reserved_amount, actual_amount)
       VALUES (?, ?, ?, ?, 0, 0)`,
      [appId, subject.type, subject.id, period],
    );
  }
  const rows = await tx.query<UsageRow>(
    `SELECT subject_type, subject_id, reserved_amount, actual_amount
       FROM period_usage
      WHERE app_id = ? AND billing_period = ?
        AND ((subject_type = 'CONFIG_GROUP' AND subject_id = ?)
          OR (subject_type = 'USER_CONFIG_GROUP' AND subject_id = ?))
      ORDER BY subject_type, subject_id
      FOR UPDATE`,
    [appId, period, groupId, userSubjectId],
  );
  return new Map(rows.map(row => [`${row.subject_type}:${row.subject_id}`, row]));
}

function assertWithinLimit(
  row: UsageRow | undefined,
  estimate: Decimal,
  limit: string | null,
  context: LimitCheckContext,
): void {
  if (!limit || !row) return;
  const actualAmount = new Decimal(row.actual_amount);
  const reservedAmount = new Decimal(row.reserved_amount);
  const limitAmount = new Decimal(limit);
  const occupiedBefore = actualAmount.plus(reservedAmount);
  const occupiedAfter = occupiedBefore.plus(estimate);
  if (occupiedAfter.gt(limitAmount)) {
    const details = {
      requestId: context.requestId,
      connectionId: context.connectionId,
      appId: context.appId,
      loginName: context.loginName,
      userId: context.userId,
      configGroupId: context.configGroupId,
      billingPeriod: context.billingPeriod,
      subjectType: context.subjectType,
      label: formatMessage(context.label, 'zh-CN'),
      limit: amount(limitAmount),
      actualAmount: amount(actualAmount),
      reservedAmount: amount(reservedAmount),
      occupiedBefore: amount(occupiedBefore),
      estimatedAmount: amount(estimate),
      occupiedAfter: amount(occupiedAfter),
      exceededBy: amount(occupiedAfter.minus(limitAmount)),
    };
    context.logger.warn({
      event: 'billing_limit_exceeded',
      ...details,
    }, 'Billing monthly limit exceeded');
    throw new AppError(message('quota.monthlyLimitExceeded', { subject: context.label }), 402, 'MONTHLY_LIMIT_EXCEEDED', details);
  }
}

export class BillingService {
  private readonly config?: AppConfig;
  private readonly logger: AppLogger;

  constructor(
    private readonly database: Database,
    configOrLogger: AppConfig | AppLogger = noopLogger,
    logger?: AppLogger,
  ) {
    if ('encryptionKey' in configOrLogger) {
      this.config = configOrLogger;
      this.logger = logger ?? noopLogger;
    } else {
      this.logger = configOrLogger;
    }
  }

  async upsertPrice(input: {
    accountId: string;
    scopeType: PriceScopeType;
    scopeId: string;
    billingItemId: string;
    unit: string;
    customerUnitPrice: string;
    costUnitPrice: string;
    actor: Actor;
  }): Promise<void> {
    new Decimal(input.customerUnitPrice);
    new Decimal(input.costUnitPrice);
    if (input.scopeType === 'PLATFORM') {
      if (input.scopeId !== '*') {
        throw new AppError(message('pricing.invalidPlatformScope'), 400, 'INVALID_PRICE_SCOPE');
      }
    } else {
      const groups = await this.database.query<RowDataPacket>(
        `SELECT config_group_id
           FROM config_groups
          WHERE config_group_id = ? AND account_id = ? AND status <> 'DELETED'
          LIMIT 1`,
        [input.scopeId, input.accountId],
      );
      if (!groups[0]) {
        throw new AppError(message('pricing.groupUnavailable'), 400, 'CONFIG_GROUP_NOT_AVAILABLE');
      }
    }
    await this.database.execute(
      `INSERT INTO operator_prices
        (price_id, scope_type, scope_id, billing_item_id, unit,
         customer_unit_price, cost_unit_price, enabled, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, TRUE, ?)
       ON DUPLICATE KEY UPDATE
         customer_unit_price = VALUES(customer_unit_price),
         cost_unit_price = VALUES(cost_unit_price),
         enabled = TRUE,
         updated_by = VALUES(updated_by)`,
      [
        `price_${randomUUID().replaceAll('-', '')}`,
        input.scopeType,
        input.scopeId,
        input.billingItemId,
        input.unit,
        input.customerUnitPrice,
        input.costUnitPrice,
        input.actor.userId,
      ],
    );
  }

  async listPrices(
    accountId: string,
    scopeType: PriceScopeType,
    scopeId: string,
    locale: Locale = 'zh-CN',
  ): Promise<{ scopeName: string; items: unknown[] }> {
    let scopeName = translate('pricing.platformDefault', locale);
    if (scopeType === 'PLATFORM') {
      if (scopeId !== '*') {
        throw new AppError(message('pricing.invalidPlatformScope'), 400, 'INVALID_PRICE_SCOPE');
      }
    } else {
      const groups = await this.database.query<{ name: string } & RowDataPacket>(
        `SELECT name
           FROM config_groups
          WHERE config_group_id = ? AND account_id = ? AND status <> 'DELETED'
          LIMIT 1`,
        [scopeId, accountId],
      );
      if (!groups[0]) {
        throw new AppError(message('pricing.groupUnavailable'), 400, 'CONFIG_GROUP_NOT_AVAILABLE');
      }
      scopeName = groups[0].name;
    }
    const rows = await this.database.query<AdminPriceRow>(
      `SELECT p.scope_type, p.scope_id, g.name AS scope_name,
              p.billing_item_id, p.unit, p.customer_unit_price, p.cost_unit_price,
              p.enabled, p.updated_at
         FROM operator_prices p
         LEFT JOIN config_groups g
           ON p.scope_type = 'CONFIG_GROUP' AND g.config_group_id = p.scope_id
        WHERE p.scope_type = ? AND p.scope_id = ?
        ORDER BY p.billing_item_id, p.unit`,
      [scopeType, scopeId],
    );
    return {
      scopeName,
      items: rows.map(row => ({
        scopeType: row.scope_type,
        scopeId: row.scope_id,
        scopeName: row.scope_type === 'PLATFORM' ? translate('pricing.platformDefault', locale) : row.scope_name,
        billingItemId: row.billing_item_id,
        unit: row.unit,
        customerUnitPrice: row.customer_unit_price,
        costUnitPrice: row.cost_unit_price,
        enabled: Boolean(row.enabled),
        updatedAt: row.updated_at,
      })),
    };
  }

  async disablePrice(input: {
    accountId: string;
    scopeType: PriceScopeType;
    scopeId: string;
    billingItemId: string;
    unit: string;
  }): Promise<void> {
    if (input.scopeType === 'CONFIG_GROUP') {
      const groups = await this.database.query<RowDataPacket>(
        `SELECT config_group_id
           FROM config_groups
          WHERE config_group_id = ? AND account_id = ? AND status <> 'DELETED'
          LIMIT 1`,
        [input.scopeId, input.accountId],
      );
      if (!groups[0]) {
        throw new AppError(message('pricing.groupUnavailable'), 400, 'CONFIG_GROUP_NOT_AVAILABLE');
      }
    } else if (input.scopeId !== '*') {
      throw new AppError(message('pricing.invalidPlatformScope'), 400, 'INVALID_PRICE_SCOPE');
    }
    const result = await this.database.execute(
      `UPDATE operator_prices SET enabled = FALSE
        WHERE scope_type = ? AND scope_id = ? AND billing_item_id = ? AND unit = ?`,
      [input.scopeType, input.scopeId, input.billingItemId, input.unit],
    );
    if (result.affectedRows !== 1) {
      throw new AppError(message('pricing.notFound'), 404, 'PRICE_NOT_FOUND');
    }
  }

  async precheck(
    connectionId: string,
    appId: string,
    input: BaselinePrecheckInput,
    suppliedLasApiKey?: string,
  ): Promise<void> {
    const projectId = baselineProjectId(input);
    this.logger.info({
      event: 'billing_precheck_started',
      requestId: input.RequestId,
      connectionId,
      appId,
      loginName: input.UserId,
      projectId,
      itemCount: input.Items.length,
    }, 'Billing precheck started');
    await this.database.transaction(async tx => {
      const existing = await tx.query<TaskRow>(
        `SELECT t.*, u.login_name
           FROM studio_tasks t
           JOIN users u ON u.user_id = t.user_id
          WHERE t.connection_id = ? AND t.app_id = ? AND t.request_id = ?
          FOR UPDATE`,
        [connectionId, appId, input.RequestId],
      );
      if (existing[0]) {
        if (existing[0].login_name === input.UserId) return;
        throw new AppError(message('billing.requestIdConflict'), 409, 'REQUEST_ID_CONFLICT');
      }

      const candidates = await tx.query<BillingUserRow>(
        `SELECT u.user_id, u.login_name, u.account_id, u.status, b.config_group_id,
                u.profile_sync_version, u.monthly_limit,
                b.monthly_limit AS binding_monthly_limit,
                b.profile_sync_version AS binding_profile_sync_version,
                g.project_id, g.status AS group_status,
                g.current_version, g.monthly_limit AS group_monthly_limit,
                r.app_id AS connection_app_id, v.encrypted_config
           FROM users u
           JOIN user_config_group_bindings b ON b.user_id = u.user_id
           JOIN config_groups g ON g.config_group_id = b.config_group_id
           JOIN studio_registrations r ON r.connection_id = g.connection_id
           JOIN config_group_versions v ON v.config_group_id = g.config_group_id
            AND v.version = g.current_version
          WHERE r.connection_id = ? AND r.app_id = ? AND u.login_name = ?
          FOR UPDATE`,
        [connectionId, appId, input.UserId],
      );
      const matching = candidates.filter(candidate => {
        if (projectId) return candidate.project_id === projectId;
        if (!suppliedLasApiKey || !this.config) return true;
        const lasApiKey = decryptJson<ResourceConfig>(
          candidate.encrypted_config,
          this.config.encryptionKey,
        ).lasApiKey?.trim();
        return lasApiKey === suppliedLasApiKey.trim();
      });
      if (projectId && matching.length === 0) {
        throw new AppError(message('billing.projectNotBound'), 403, 'BILLING_PROJECT_NOT_BOUND');
      }
      if (matching.length > 1) {
        throw new AppError(
          message('billing.projectAmbiguous'),
          409,
          'BILLING_CONFIG_GROUP_AMBIGUOUS',
        );
      }
      const user = matching[0];
      if (!user || user.status !== 'ACTIVE') {
        throw new AppError(message('billing.userDisabled'), 403, 'BILLING_USER_DISABLED');
      }

      if (!user.config_group_id || !['AVAILABLE', 'PARTIAL_FAILED'].includes(user.group_status ?? '')) {
        throw new AppError(message('users.profileNotReady'), 409, 'PROFILE_NOT_SYNCED');
      }
      const configGroupId = user.config_group_id;

      const snapshots = await Promise.all(input.Items.map((item, index) =>
        resolvePrice(tx, configGroupId, item, index, this.config?.defaultPrices ?? DEFAULT_PRICES)));
      const estimatedAmount = Decimal.sum(...snapshots.map(item => item.estimatedAmount));
      const estimatedCost = Decimal.sum(...snapshots.map(item => item.estimatedCost));
      const period = currentBillingPeriod(new Date(), this.config?.timeZone);
      this.logger.info({
        event: 'billing_estimate_calculated',
        requestId: input.RequestId,
        connectionId,
        appId,
        loginName: user.login_name,
        userId: user.user_id,
        configGroupId,
        billingPeriod: period,
        estimatedAmount: amount(estimatedAmount),
        estimatedCost: amount(estimatedCost),
        items: snapshots.map(item => ({
          billingItemId: item.billingItemId,
          modelId: item.modelId,
          unit: item.unit,
          estimatedUsage: amount(item.estimatedUsage),
          customerUnitPrice: item.customerUnitPrice.toFixed(10),
          costUnitPrice: item.costUnitPrice.toFixed(10),
          estimatedAmount: amount(item.estimatedAmount),
          estimatedCost: amount(item.estimatedCost),
        })),
      }, 'Billing estimate calculated');
      const userSubjectId = `${user.user_id}:${configGroupId}`;
      const usageRows = await lockUsage(tx, appId, configGroupId, userSubjectId, period);
      assertWithinLimit(
        usageRows.get(`CONFIG_GROUP:${configGroupId}`),
        estimatedAmount,
        user.group_monthly_limit,
        {
          logger: this.logger,
          requestId: input.RequestId,
          connectionId,
          appId,
          loginName: user.login_name,
          userId: user.user_id,
          configGroupId,
          billingPeriod: period,
          subjectType: 'CONFIG_GROUP',
          label: message('common.resourceGroup'),
        },
      );
      assertWithinLimit(
        usageRows.get(`USER_CONFIG_GROUP:${userSubjectId}`),
        estimatedAmount,
        user.binding_monthly_limit,
        {
          logger: this.logger,
          requestId: input.RequestId,
          connectionId,
          appId,
          loginName: user.login_name,
          userId: user.user_id,
          configGroupId,
          billingPeriod: period,
          subjectType: 'USER',
          label: message('common.subaccount'),
        },
      );

      const taskId = `task_${randomUUID().replaceAll('-', '')}`;
      await tx.execute(
        `INSERT INTO studio_tasks
          (task_id, connection_id, app_id, user_id, request_id, config_group_id,
           config_group_version, billing_period, status, estimated_amount, estimated_cost)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'RUNNING', ?, ?)`,
        [
          taskId,
          connectionId,
          appId,
          user.user_id,
          input.RequestId,
          configGroupId,
          user.current_version,
          period,
          amount(estimatedAmount),
          amount(estimatedCost),
        ],
      );
      for (const item of snapshots) {
        const inputItem = input.Items[item.itemIndex];
        await tx.execute(
          `INSERT INTO studio_task_items
            (task_id, item_index, billing_item_id, model_id, unit, estimated_usage,
             customer_unit_price, cost_unit_price, estimated_billing_context)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            taskId,
            item.itemIndex,
            item.billingItemId,
            item.modelId,
            item.unit,
            amount(item.estimatedUsage),
            item.customerUnitPrice.toFixed(10),
            item.costUnitPrice.toFixed(10),
            billingContext(inputItem?.BillingContext),
          ],
        );
      }
      await tx.execute(
        `UPDATE period_usage
            SET reserved_amount = reserved_amount + ?
          WHERE app_id = ? AND billing_period = ?
            AND ((subject_type = 'CONFIG_GROUP' AND subject_id = ?)
              OR (subject_type = 'USER_CONFIG_GROUP' AND subject_id = ?))`,
        [amount(estimatedAmount), appId, period, configGroupId, userSubjectId],
      );
      this.logger.info({
        event: 'billing_precheck_reserved',
        requestId: input.RequestId,
        connectionId,
        appId,
        loginName: user.login_name,
        userId: user.user_id,
        configGroupId,
        billingPeriod: period,
        taskId,
        estimatedAmount: amount(estimatedAmount),
        estimatedCost: amount(estimatedCost),
      }, 'Billing precheck reserved amount');
    });
  }

  async callback(
    connectionId: string,
    appId: string,
    input: BaselineCallbackInput,
    reconciliationAudit?: ReconciliationAudit,
  ): Promise<void> {
    const projectId = baselineProjectId(input);
    this.logger.info({
      event: 'billing_actual_callback_started',
      requestId: input.RequestId,
      connectionId,
      appId,
      loginName: input.UserId,
      projectId,
      status: input.Status,
      itemCount: input.Items.length,
    }, 'Billing actual callback started');
    await this.database.transaction(async tx => {
      const tasks = await tx.query<TaskRow>(
        `SELECT t.*, u.login_name
           FROM studio_tasks t
           JOIN users u ON u.user_id = t.user_id
          WHERE t.connection_id = ? AND t.app_id = ? AND t.request_id = ?
          FOR UPDATE`,
        [connectionId, appId, input.RequestId],
      );
      const task = tasks[0];
      if (!task) {
        if (input.Status === 'FAILED' || input.Status === 'CANCELLED') {
          this.logger.info({
            event: 'billing_actual_callback_ignored_without_precheck',
            requestId: input.RequestId,
            connectionId,
            appId,
            loginName: input.UserId,
            status: input.Status,
          }, 'Billing failure callback ignored because precheck did not create a task');
          return;
        }
        throw new AppError(message('billing.taskNotFound'), 404, 'TASK_NOT_FOUND');
      }
      if (task.login_name !== input.UserId) {
        throw new AppError(message('billing.taskUserMismatch'), 409, 'TASK_ACTOR_MISMATCH');
      }
      if (task.status !== 'RUNNING') return;

      const storedItems = await tx.query<TaskItemRow>(
        'SELECT * FROM studio_task_items WHERE task_id = ? ORDER BY item_index FOR UPDATE',
        [task.task_id],
      );
      let actualAmount = new Decimal(0);
      let actualCost = new Decimal(0);
      if (input.Status === 'SUCCEEDED') {
        for (const stored of storedItems) {
          const actual = input.Items[Number(stored.item_index)];
          if (!actual) {
            throw new AppError(message('billing.callbackItemMissing', { billingItemId: stored.billing_item_id, index: stored.item_index }), 400, 'CALLBACK_ITEM_MISSING');
          }
          if (actual.BillingItemId !== stored.billing_item_id) {
            throw new AppError(message('billing.itemMismatch', { billingItemId: stored.billing_item_id, index: stored.item_index }), 400, 'BILLING_ITEM_MISMATCH');
          }
          if (actual.Unit !== stored.unit) {
            throw new AppError(message('billing.unitMismatch', { billingItemId: stored.billing_item_id }), 400, 'BILLING_UNIT_MISMATCH');
          }
          const actualUsage = usage(actual.Usage);
          actualAmount = actualAmount.plus(new Decimal(stored.customer_unit_price).mul(actualUsage));
          actualCost = actualCost.plus(new Decimal(stored.cost_unit_price).mul(actualUsage));
          await tx.execute(
            `UPDATE studio_task_items
                SET actual_usage = ?, model_id = COALESCE(?, model_id),
                    actual_billing_context = ?, status = 'SUCCEEDED'
              WHERE task_id = ? AND item_index = ?`,
            [
              amount(actualUsage),
              actual.ModelId?.trim() || null,
              billingContext(actual.BillingContext),
              task.task_id,
              stored.item_index,
            ],
          );
        }
      } else {
        await tx.execute(
          'UPDATE studio_task_items SET actual_usage = 0, status = ? WHERE task_id = ?',
          [input.Status, task.task_id],
        );
      }

      const userSubjectId = `${task.user_id}:${task.config_group_id}`;
      await lockUsage(tx, appId, task.config_group_id, userSubjectId, task.billing_period);
      await tx.execute(
        `UPDATE period_usage
            SET reserved_amount = GREATEST(reserved_amount - ?, 0),
                actual_amount = actual_amount + ?
          WHERE app_id = ? AND billing_period = ?
            AND ((subject_type = 'CONFIG_GROUP' AND subject_id = ?)
              OR (subject_type = 'USER_CONFIG_GROUP' AND subject_id = ?))`,
        [
          task.estimated_amount,
          amount(actualAmount),
          appId,
          task.billing_period,
          task.config_group_id,
          userSubjectId,
        ],
      );
      await tx.execute(
        `UPDATE studio_tasks
            SET status = ?, actual_amount = ?, actual_cost = ?,
                billing_audit_payload = ?, finished_at = CURRENT_TIMESTAMP(3)
          WHERE task_id = ?`,
        [
          input.Status,
          amount(actualAmount),
          amount(actualCost),
          JSON.stringify({
            ...billingAuditPayload(task.billing_audit_payload),
            settlement: {
              source: reconciliationAudit ? 'reconciliation' : 'callback',
              requestBody: input,
              responseBody: {
                code: 200,
                message: 'success',
                requestId: input.RequestId,
              },
              recordedAt: new Date().toISOString(),
            },
            ...(reconciliationAudit ? {
              reconciliationQueries: [
                ...(billingAuditPayload(task.billing_audit_payload).reconciliationQueries ?? []),
                {
                  ...reconciliationAudit,
                  recordedAt: new Date().toISOString(),
                },
              ],
            } : {}),
          } satisfies BillingAuditPayload),
          task.task_id,
        ],
      );
      this.logger.info({
        event: input.Status === 'SUCCEEDED' ? 'billing_actual_settled' : 'billing_actual_released',
        requestId: input.RequestId,
        connectionId,
        appId,
        loginName: task.login_name,
        userId: task.user_id,
        configGroupId: task.config_group_id,
        billingPeriod: task.billing_period,
        taskId: task.task_id,
        status: input.Status,
        estimatedAmount: task.estimated_amount,
        actualAmount: amount(actualAmount),
        actualCost: amount(actualCost),
      }, 'Billing actual callback completed');
    });
  }

  async billSummary(
    accountId: string,
    period: string,
    dimension: 'overall' | 'configGroup' | 'subaccount' = 'overall',
  ): Promise<unknown> {
    const dimensionSelect = dimension === 'configGroup'
      ? 't.config_group_id AS subject_id, g.name AS subject_name,'
      : dimension === 'subaccount'
        ? 't.user_id AS subject_id, u.display_name AS subject_name,'
        : '';
    const dimensionJoin = dimension === 'configGroup'
      ? 'LEFT JOIN config_groups g ON g.config_group_id = t.config_group_id'
      : dimension === 'subaccount'
        ? 'LEFT JOIN users u ON u.user_id = t.user_id'
        : '';
    const dimensionGroup = dimension === 'configGroup'
      ? 't.config_group_id, g.name, t.status'
      : dimension === 'subaccount'
        ? 't.user_id, u.display_name, t.status'
        : 't.status';
    const rows = await this.database.query<{
      status: string;
      task_count: number;
      customer_amount: string;
      cost_amount: string;
    } & RowDataPacket>(
      `SELECT ${dimensionSelect} t.status, COUNT(*) AS task_count,
              COALESCE(SUM(actual_amount), 0) AS customer_amount,
              COALESCE(SUM(actual_cost), 0) AS cost_amount
         FROM studio_tasks t
         JOIN studio_registrations r ON r.connection_id = t.connection_id
         ${dimensionJoin}
        WHERE r.account_id = ? AND t.billing_period = ?
        GROUP BY ${dimensionGroup} ORDER BY ${dimensionGroup}`,
      [accountId, period],
    );
    return { accountId, billingPeriod: period, dimension, items: rows };
  }
}
