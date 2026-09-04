import { randomUUID } from 'node:crypto';

import bcrypt from 'bcryptjs';
import type { RowDataPacket } from 'mysql2/promise';

import type { AppConfig } from './config.js';
import type { Database } from './db.js';
import { AppError, profileSyncError } from './errors.js';
import {
  currentBillingPeriod,
  effectiveAvailableAmount,
  quotaSnapshot,
} from './quota.js';
import { decryptJson, encryptJson, maskConfig } from './security.js';
import { StudioConnectionService } from './studio-connections.js';
import type { Actor, ResourceConfig } from './types.js';
import type { StudioDeploymentProfile } from './studio-client.js';

interface GroupRow extends RowDataPacket {
  config_group_id: string;
  account_id: string;
  connection_id: string;
  project_id: string;
  connection_name?: string;
  connection_app_id?: string;
  name: string;
  status: string;
  current_version: number;
  monthly_limit: string | null;
  reserved_amount: string | null;
  actual_amount: string | null;
  is_default: number;
  project_level_sharing: number;
}

interface VersionRow extends RowDataPacket {
  version: number;
  encrypted_config: string;
  masked_config: ResourceConfig;
}

interface RegistrationRow extends RowDataPacket {
  status: string;
}

interface UserIdRow extends RowDataPacket {
  user_id: string;
  login_name: string;
}

interface SubaccountRow extends RowDataPacket {
  user_id: string;
  login_name: string;
  display_name: string;
  status: string;
  config_group_id: string | null;
  config_group_name: string | null;
  profile_sync_version: number | null;
  profile_sync_error_code: string | null;
  profile_sync_error_message: string | null;
  profile_sync_request_id: string | null;
  current_version: number | null;
  monthly_limit: string | null;
  group_monthly_limit: string | null;
  user_reserved_amount: string | null;
  user_actual_amount: string | null;
  group_reserved_amount: string | null;
  group_actual_amount: string | null;
  password_cipher: string | null;
  created_at: Date;
}

interface SubaccountStatusRow extends RowDataPacket {
  role: string;
  status: string;
  config_group_id: string | null;
  profile_sync_version: number | null;
  group_status: string | null;
  current_version: number | null;
}

interface EditableSubaccountRow extends RowDataPacket {
  role: string;
  login_name: string;
}

interface ProfileTargetRow extends RowDataPacket {
  role: string;
  status: string;
  login_name: string;
  config_group_id: string | null;
  connection_id: string | null;
  project_id: string | null;
  current_version: number | null;
  encrypted_config: string | null;
  project_level_sharing?: number | null;
}

function groupId(): string {
  return `grp_${randomUUID().replaceAll('-', '')}`;
}

function userId(): string {
  return `usr_${randomUUID().replaceAll('-', '')}`;
}

function effectiveResourceConfig(
  resourceConfig: ResourceConfig,
  deployment: StudioDeploymentProfile,
): ResourceConfig {
  const required = ['lasApiKey', 'arkApiKey', 'tosBucketName'] as const;
  for (const field of required) {
    if (!resourceConfig[field]?.trim()) {
      throw new AppError(`资源配置缺少必填项: ${field}`, 400, 'RESOURCE_CONFIG_INCOMPLETE');
    }
  }
  return {
    ...resourceConfig,
    lasApiKey: resourceConfig.lasApiKey?.trim(),
    arkApiKey: resourceConfig.arkApiKey?.trim(),
    tosBucketName: resourceConfig.tosBucketName?.trim(),
    region: deployment.region,
    tosRegion: deployment.tosRegion,
  };
}

export class ConfigGroupService {
  constructor(
    private readonly database: Database,
    private readonly config: AppConfig,
    private readonly studioConnections: StudioConnectionService,
  ) {}

  async create(input: {
    accountId: string;
    connectionId: string;
    projectId: string;
    resourceConfig: ResourceConfig;
    monthlyLimit: string | null;
    isDefault: boolean;
    projectLevelSharing: boolean;
    actor: Actor;
  }): Promise<{ configGroupId: string; version: number; status: string }> {
    await this.requireStudioReady(input.accountId, input.connectionId);
    const deployment = await this.studioConnections.deploymentProfile(
      input.accountId,
      input.connectionId,
    );
    const resourceConfig = effectiveResourceConfig(input.resourceConfig, deployment);
    const id = groupId();
    await this.database.transaction(async tx => {
      if (input.isDefault) {
        await tx.execute('UPDATE config_groups SET is_default = FALSE WHERE account_id = ?', [input.accountId]);
      }
      await tx.execute(
        `INSERT INTO config_groups
          (config_group_id, account_id, connection_id, project_id, name, status,
           current_version, monthly_limit, is_default, project_level_sharing)
         VALUES (?, ?, ?, ?, ?, 'DRAFT', 0, ?, ?, ?)`,
        [
          id,
          input.accountId,
          input.connectionId,
          input.projectId.trim(),
          input.projectId.trim(),
          input.monthlyLimit,
          input.isDefault,
          input.projectLevelSharing,
        ],
      );
      await tx.execute(
        `INSERT INTO config_group_versions
          (config_group_id, version, encrypted_config, masked_config, created_by)
         VALUES (?, 1, ?, ?, ?)`,
        [
          id,
          encryptJson(resourceConfig, this.config.encryptionKey),
          JSON.stringify(maskConfig(resourceConfig)),
          input.actor.userId,
        ],
      );
    });
    return { configGroupId: id, version: 1, status: 'DRAFT' };
  }

  async createVersion(input: {
    accountId: string;
    configGroupId: string;
    connectionId?: string;
    projectId?: string;
    resourceConfig: ResourceConfig;
    monthlyLimit?: string | null;
    projectLevelSharing?: boolean;
    actor: Actor;
  }): Promise<{ version: number }> {
    return this.database.transaction(async tx => {
      const groups = await tx.query<GroupRow>(
        'SELECT * FROM config_groups WHERE config_group_id = ? AND account_id = ? FOR UPDATE',
        [input.configGroupId, input.accountId],
      );
      const group = groups[0];
      if (!group || group.status === 'DELETED') {
        throw new AppError('配置组不存在', 404, 'CONFIG_GROUP_NOT_FOUND');
      }
      const connectionId = input.connectionId ?? group.connection_id;
      const projectId = input.projectId?.trim() ?? group.project_id;
      if (connectionId !== group.connection_id || projectId !== group.project_id) {
        const users = await tx.query<{ count: number } & RowDataPacket>(
          `SELECT COUNT(*) AS count FROM users
            WHERE config_group_id = ? AND status <> 'DELETED'`,
          [input.configGroupId],
        );
        if (Number(users[0]?.count) > 0) {
          throw new AppError(
            '配置组仍有关联子账号，不能切换 Studio 连接或 Project',
            409,
            'CONFIG_GROUP_BINDING_IN_USE',
          );
        }
      }
      await this.requireStudioReady(input.accountId, connectionId);
      const deployment = await this.studioConnections.deploymentProfile(
        input.accountId,
        connectionId,
      );
      const versions = await tx.query<VersionRow>(
        `SELECT version, encrypted_config, masked_config
           FROM config_group_versions
          WHERE config_group_id = ?
          ORDER BY version DESC LIMIT 1
          FOR UPDATE`,
        [input.configGroupId],
      );
      const previous = versions[0];
      if (!previous) throw new AppError('配置组版本不存在', 409, 'CONFIG_VERSION_NOT_FOUND');
      const version = Number(previous.version) + 1;
      const resourceConfig = effectiveResourceConfig({
        ...decryptJson<ResourceConfig>(previous.encrypted_config, this.config.encryptionKey),
        ...input.resourceConfig,
      }, deployment);
      await tx.execute(
        `INSERT INTO config_group_versions
          (config_group_id, version, encrypted_config, masked_config, created_by)
         VALUES (?, ?, ?, ?, ?)`,
        [
          input.configGroupId,
          version,
          encryptJson(resourceConfig, this.config.encryptionKey),
          JSON.stringify(maskConfig(resourceConfig)),
          input.actor.userId,
        ],
      );
      await tx.execute(
        `UPDATE config_groups
            SET status = 'DRAFT', connection_id = ?, project_id = ?,
                monthly_limit = COALESCE(?, monthly_limit),
                project_level_sharing = COALESCE(?, project_level_sharing)
          WHERE config_group_id = ?`,
        [
          connectionId,
          projectId,
          input.monthlyLimit ?? null,
          input.projectLevelSharing ?? null,
          input.configGroupId,
        ],
      );
      return { version };
    });
  }

  async save(input: {
    accountId: string;
    configGroupId: string;
    connectionId?: string;
    projectId?: string;
    resourceConfig: ResourceConfig;
    monthlyLimit: string | null;
    projectLevelSharing?: boolean;
    actor: Actor;
  }): Promise<{ version: number; synced: number; failed: number }> {
    await this.createVersion(input);
    await this.database.execute(
      `UPDATE config_groups
          SET name = project_id, monthly_limit = ?,
              project_level_sharing = COALESCE(?, project_level_sharing)
        WHERE config_group_id = ? AND account_id = ?`,
      [
        input.monthlyLimit,
        input.projectLevelSharing ?? null,
        input.configGroupId,
        input.accountId,
      ],
    );
    return this.publish(input);
  }

  async list(accountId: string): Promise<unknown[]> {
    const billingPeriod = currentBillingPeriod();
    const groups = await this.database.query<GroupRow>(
      `SELECT g.config_group_id, g.account_id, g.connection_id, g.project_id, g.name,
              g.status, g.current_version, g.monthly_limit, g.is_default,
              g.project_level_sharing,
              r.name AS connection_name, r.app_id AS connection_app_id,
              p.reserved_amount, p.actual_amount
         FROM config_groups g
         JOIN studio_registrations r ON r.connection_id = g.connection_id
         LEFT JOIN period_usage p
           ON p.app_id = r.app_id
          AND p.subject_type = 'CONFIG_GROUP'
          AND p.subject_id = g.config_group_id
          AND p.billing_period = ?
        WHERE g.account_id = ? AND g.status <> 'DELETED'
        ORDER BY g.created_at`,
      [billingPeriod, accountId],
    );
    const result: unknown[] = [];
    for (const group of groups) {
      const versions = await this.database.query<VersionRow>(
        `SELECT version, encrypted_config, masked_config
           FROM config_group_versions
          WHERE config_group_id = ?
          ORDER BY version DESC LIMIT 1`,
        [group.config_group_id],
      );
      const failedUsers = await this.database.query<{
        user_id: string;
        login_name: string;
        display_name: string;
        profile_sync_error_code: string | null;
        profile_sync_error_message: string | null;
        profile_sync_request_id: string | null;
      } & RowDataPacket>(
        `SELECT user_id, login_name, display_name, profile_sync_error_code,
                profile_sync_error_message, profile_sync_request_id
           FROM users
          WHERE config_group_id = ? AND profile_sync_error_code IS NOT NULL
          ORDER BY created_at, user_id`,
        [group.config_group_id],
      );
      result.push({
        configGroupId: group.config_group_id,
        connectionId: group.connection_id,
        connectionName: group.connection_name,
        appId: group.connection_app_id,
        projectId: group.project_id,
        name: group.name,
        status: group.status,
        currentVersion: Number(group.current_version),
        latestVersion: versions[0]?.version ?? 0,
        monthlyLimit: group.monthly_limit,
        billingPeriod,
        quota: quotaSnapshot(
          group.monthly_limit,
          group.actual_amount,
          group.reserved_amount,
        ),
        isDefault: Boolean(group.is_default),
        projectLevelSharing: Boolean(group.project_level_sharing),
        failedCount: failedUsers.length,
        failedUsers: failedUsers.map(user => ({
          userId: user.user_id,
          loginName: user.login_name,
          displayName: user.display_name,
          errorCode: user.profile_sync_error_code,
          errorMessage: user.profile_sync_error_message,
          requestId: user.profile_sync_request_id,
        })),
        config: versions[0]
          ? decryptJson<ResourceConfig>(versions[0].encrypted_config, this.config.encryptionKey)
          : {},
      });
    }
    return result;
  }

  private async latestVersion(configGroupId: string): Promise<VersionRow> {
    const versions = await this.database.query<VersionRow>(
      `SELECT version, encrypted_config, masked_config
         FROM config_group_versions
        WHERE config_group_id = ?
        ORDER BY version DESC LIMIT 1`,
      [configGroupId],
    );
    if (!versions[0]) throw new AppError('配置组版本不存在', 409, 'CONFIG_VERSION_NOT_FOUND');
    return versions[0];
  }

  private async requireStudioReady(accountId: string, connectionId: string): Promise<void> {
    const registrations = await this.database.query<RegistrationRow>(
      'SELECT status FROM studio_registrations WHERE account_id = ? AND connection_id = ?',
      [accountId, connectionId],
    );
    if (registrations[0]?.status !== 'READY') {
      throw new AppError('请先完成 Studio 注册', 409, 'STUDIO_NOT_REGISTERED');
    }
  }

  async publish(input: {
    accountId: string;
    configGroupId: string;
  }): Promise<{ version: number; synced: number; failed: number }> {
    const groups = await this.database.query<GroupRow>(
      'SELECT * FROM config_groups WHERE config_group_id = ? AND account_id = ?',
      [input.configGroupId, input.accountId],
    );
    const group = groups[0];
    if (!group || group.status === 'DELETED') {
      throw new AppError('配置组不存在', 404, 'CONFIG_GROUP_NOT_FOUND');
    }
    await this.requireStudioReady(input.accountId, group.connection_id);
    const version = await this.latestVersion(input.configGroupId);
    const resourceConfig = decryptJson<ResourceConfig>(version.encrypted_config, this.config.encryptionKey);
    await this.studioConnections.registerUsageEndpoint(
      input.accountId,
      group.connection_id,
      resourceConfig.lasApiKey ?? '',
    );
    await this.studioConnections.upsertProjectProfile(
      input.accountId,
      group.connection_id,
      group.project_id,
      resourceConfig,
      Boolean(group.project_level_sharing),
    );

    await this.database.execute(
      "UPDATE config_groups SET status = 'SYNCING' WHERE config_group_id = ?",
      [input.configGroupId],
    );
    const users = await this.database.query<UserIdRow>(
      `SELECT user_id, login_name FROM users
        WHERE account_id = ? AND config_group_id = ? AND status <> 'DELETED'`,
      [input.accountId, input.configGroupId],
    );
    let synced = 0;
    let failed = 0;
    for (const user of users) {
      try {
        await this.studioConnections.upsertUserProfile(
          input.accountId,
          group.connection_id,
          group.project_id,
          user.login_name,
          resourceConfig,
          Boolean(group.project_level_sharing),
        );
        await this.database.execute(
          `UPDATE users
              SET profile_sync_version = ?,
                  status = CASE WHEN status = 'DISABLED' THEN 'DISABLED' ELSE 'ACTIVE' END,
                  profile_sync_error_code = NULL, profile_sync_error_message = NULL,
                  profile_sync_request_id = NULL
            WHERE user_id = ?`,
          [version.version, user.user_id],
        );
        synced += 1;
      } catch (error) {
        const failure = profileSyncError(error);
        await this.database.execute(
          `UPDATE users
              SET status = CASE WHEN status = 'DISABLED' THEN 'DISABLED' ELSE 'SYNC_FAILED' END,
                  profile_sync_error_code = ?,
                  profile_sync_error_message = ?, profile_sync_request_id = ?
            WHERE user_id = ?`,
          [failure.code, failure.message, failure.requestId, user.user_id],
        );
        failed += 1;
      }
    }
    await this.database.execute(
      'UPDATE config_groups SET current_version = ?, status = ? WHERE config_group_id = ?',
      [version.version, failed === 0 ? 'AVAILABLE' : 'PARTIAL_FAILED', input.configGroupId],
    );
    return { version: version.version, synced, failed };
  }

  async createSubaccount(input: {
    accountId: string;
    loginName: string;
    displayName: string;
    password: string;
    configGroupId: string;
    monthlyLimit: string | null;
  }): Promise<{ userId: string; status: string }> {
    const groups = await this.database.query<GroupRow>(
      `SELECT * FROM config_groups
        WHERE config_group_id = ? AND account_id = ? AND status = 'AVAILABLE'`,
      [input.configGroupId, input.accountId],
    );
    const group = groups[0];
    if (!group || Number(group.current_version) <= 0) {
      throw new AppError('配置组未发布', 409, 'CONFIG_GROUP_NOT_AVAILABLE');
    }
    await this.requireStudioReady(input.accountId, group.connection_id);
    const versions = await this.database.query<VersionRow>(
      `SELECT version, encrypted_config, masked_config
         FROM config_group_versions
        WHERE config_group_id = ? AND version = ?`,
      [input.configGroupId, group.current_version],
    );
    const version = versions[0];
    if (!version) throw new AppError('配置组生效版本不存在', 409, 'CONFIG_VERSION_NOT_FOUND');

    const id = userId();
    const passwordHash = await bcrypt.hash(input.password, 12);
    const passwordCipher = encryptJson(input.password, this.config.encryptionKey);
    await this.database.execute(
      `INSERT INTO users
        (user_id, account_id, login_name, display_name, password_hash, password_cipher, role, status,
         config_group_id, profile_sync_version, monthly_limit)
       VALUES (?, ?, ?, ?, ?, ?, 'SUBACCOUNT', 'PROVISIONING', ?, NULL, ?)`,
      [
        id,
        input.accountId,
        input.loginName.trim(),
        input.displayName.trim(),
        passwordHash,
        passwordCipher,
        input.configGroupId,
        input.monthlyLimit,
      ],
    );
    try {
      const resourceConfig = decryptJson<ResourceConfig>(
        version.encrypted_config,
        this.config.encryptionKey,
      );
      await this.studioConnections.upsertProjectProfile(
        input.accountId,
        group.connection_id,
        group.project_id,
        resourceConfig,
        Boolean(group.project_level_sharing),
      );
      await this.studioConnections.upsertUserProfile(
        input.accountId,
        group.connection_id,
        group.project_id,
        input.loginName.trim(),
        resourceConfig,
        Boolean(group.project_level_sharing),
      );
      await this.database.execute(
        `UPDATE users
            SET status = CASE WHEN status = 'DISABLED' THEN 'DISABLED' ELSE 'ACTIVE' END,
                profile_sync_version = ?,
                profile_sync_error_code = NULL, profile_sync_error_message = NULL,
                profile_sync_request_id = NULL
          WHERE user_id = ?`,
        [version.version, id],
      );
      return { userId: id, status: 'ACTIVE' };
    } catch (error) {
      const failure = profileSyncError(error);
      await this.database.execute(
        `UPDATE users
            SET status = CASE WHEN status = 'DISABLED' THEN 'DISABLED' ELSE 'SYNC_FAILED' END,
                profile_sync_error_code = ?,
                profile_sync_error_message = ?, profile_sync_request_id = ?
          WHERE user_id = ?`,
        [failure.code, failure.message, failure.requestId, id],
      );
      throw new AppError(
        `子账号已创建，但同步 Studio 失败: ${failure.message}`,
        502,
        'PROFILE_SYNC_FAILED',
      );
    }
  }

  async resolveAvailableGroupId(accountId: string, nameOrId: string): Promise<string> {
    const groups = await this.database.query<GroupRow>(
      `SELECT * FROM config_groups
        WHERE account_id = ? AND (config_group_id = ? OR name = ?)
          AND status IN ('AVAILABLE', 'PARTIAL_FAILED')
        LIMIT 1`,
      [accountId, nameOrId.trim(), nameOrId.trim()],
    );
    if (!groups[0]) {
      throw new AppError(`配置组不可用: ${nameOrId}`, 400, 'CONFIG_GROUP_NOT_AVAILABLE');
    }
    return groups[0].config_group_id;
  }

  async listSubaccounts(accountId: string): Promise<unknown[]> {
    const billingPeriod = currentBillingPeriod();
    const rows = await this.database.query<SubaccountRow>(
      `SELECT u.user_id, u.login_name, u.display_name, u.status, u.config_group_id,
              g.name AS config_group_name, u.profile_sync_version, g.current_version,
              u.profile_sync_error_code, u.profile_sync_error_message,
              u.profile_sync_request_id, u.monthly_limit,
              g.monthly_limit AS group_monthly_limit,
              up.reserved_amount AS user_reserved_amount,
              up.actual_amount AS user_actual_amount,
              gp.reserved_amount AS group_reserved_amount,
              gp.actual_amount AS group_actual_amount,
              u.password_cipher, u.created_at
         FROM users u
         LEFT JOIN config_groups g ON g.config_group_id = u.config_group_id
         LEFT JOIN studio_registrations r ON r.connection_id = g.connection_id
         LEFT JOIN period_usage up
           ON up.app_id = r.app_id
          AND up.subject_type = 'USER'
          AND up.subject_id = u.user_id
          AND up.billing_period = ?
         LEFT JOIN period_usage gp
           ON gp.app_id = r.app_id
          AND gp.subject_type = 'CONFIG_GROUP'
          AND gp.subject_id = g.config_group_id
          AND gp.billing_period = ?
        WHERE u.account_id = ? AND u.role = 'SUBACCOUNT' AND u.status <> 'DELETED'
        ORDER BY u.created_at DESC`,
      [billingPeriod, billingPeriod, accountId],
    );
    return rows.map(row => {
      const quota = quotaSnapshot(
        row.monthly_limit,
        row.user_actual_amount,
        row.user_reserved_amount,
      );
      const groupQuota = quotaSnapshot(
        row.group_monthly_limit,
        row.group_actual_amount,
        row.group_reserved_amount,
      );
      return {
        userId: row.user_id,
        loginName: row.login_name,
        displayName: row.display_name,
        status: row.status,
        configGroupId: row.config_group_id,
        configGroupName: row.config_group_name,
        profileSyncVersion: row.profile_sync_version,
        currentVersion: row.current_version,
        profileSyncErrorCode: row.profile_sync_error_code,
        profileSyncErrorMessage: row.profile_sync_error_message,
        profileSyncRequestId: row.profile_sync_request_id,
        monthlyLimit: row.monthly_limit,
        groupMonthlyLimit: row.group_monthly_limit,
        billingPeriod,
        quota: {
          ...quota,
          effectiveAvailableAmount: effectiveAvailableAmount(
            quota.availableAmount,
            groupQuota.availableAmount,
          ),
        },
        groupQuota,
        password: row.password_cipher
          ? decryptJson<string>(row.password_cipher, this.config.encryptionKey)
          : null,
        createdAt: row.created_at,
      };
    });
  }

  async setSubaccountStatus(input: {
    accountId: string;
    userId: string;
    status: 'ACTIVE' | 'DISABLED';
  }): Promise<{ userId: string; status: string }> {
    await this.database.transaction(async tx => {
      const rows = await tx.query<SubaccountStatusRow>(
        `SELECT u.role, u.status, u.config_group_id, u.profile_sync_version,
                g.status AS group_status, g.current_version
           FROM users u
           LEFT JOIN config_groups g ON g.config_group_id = u.config_group_id
          WHERE u.account_id = ? AND u.user_id = ?
          FOR UPDATE`,
        [input.accountId, input.userId],
      );
      const user = rows[0];
      if (!user || user.role !== 'SUBACCOUNT') {
        throw new AppError('子账号不存在', 404, 'SUBACCOUNT_NOT_FOUND');
      }
      if (user.status === 'DELETED') {
        throw new AppError('已删除的子账号不能恢复', 409, 'SUBACCOUNT_DELETED');
      }
      if (input.status === 'ACTIVE' && (
        !user.config_group_id
        || !['AVAILABLE', 'PARTIAL_FAILED'].includes(user.group_status ?? '')
        || Number(user.profile_sync_version) !== Number(user.current_version)
      )) {
        throw new AppError('资源配置未就绪，无法恢复账号', 409, 'PROFILE_NOT_SYNCED');
      }
      await tx.execute('UPDATE users SET status = ? WHERE user_id = ?', [input.status, input.userId]);
      if (input.status === 'DISABLED') {
        await tx.execute('DELETE FROM sessions WHERE user_id = ?', [input.userId]);
      }
    });
    return { userId: input.userId, status: input.status };
  }

  async updateSubaccount(input: {
    accountId: string;
    userId: string;
    displayName: string;
    password?: string;
    configGroupId: string;
    monthlyLimit: string | null;
  }): Promise<{ userId: string; status: string }> {
    const users = await this.database.query<EditableSubaccountRow>(
      `SELECT role, login_name FROM users
        WHERE account_id = ? AND user_id = ? AND status <> 'DELETED'`,
      [input.accountId, input.userId],
    );
    if (!users[0] || users[0].role !== 'SUBACCOUNT') {
      throw new AppError('子账号不存在', 404, 'SUBACCOUNT_NOT_FOUND');
    }
    const groups = await this.database.query<GroupRow>(
      `SELECT * FROM config_groups
        WHERE config_group_id = ? AND account_id = ? AND status IN ('AVAILABLE', 'PARTIAL_FAILED')`,
      [input.configGroupId, input.accountId],
    );
    const group = groups[0];
    if (!group || Number(group.current_version) <= 0) {
      throw new AppError('配置组不可用', 409, 'CONFIG_GROUP_NOT_AVAILABLE');
    }
    await this.requireStudioReady(input.accountId, group.connection_id);
    const versions = await this.database.query<VersionRow>(
      `SELECT version, encrypted_config, masked_config
         FROM config_group_versions
        WHERE config_group_id = ? AND version = ?`,
      [input.configGroupId, group.current_version],
    );
    const version = versions[0];
    if (!version) throw new AppError('配置组生效版本不存在', 409, 'CONFIG_VERSION_NOT_FOUND');

    const resourceConfig = decryptJson<ResourceConfig>(
      version.encrypted_config,
      this.config.encryptionKey,
    );
    await this.studioConnections.upsertProjectProfile(
      input.accountId,
      group.connection_id,
      group.project_id,
      resourceConfig,
      Boolean(group.project_level_sharing),
    );
    await this.studioConnections.upsertUserProfile(
      input.accountId,
      group.connection_id,
      group.project_id,
      users[0].login_name,
      resourceConfig,
      Boolean(group.project_level_sharing),
    );
    const passwordHash = input.password ? await bcrypt.hash(input.password, 12) : null;
    const passwordCipher = input.password
      ? encryptJson(input.password, this.config.encryptionKey)
      : null;
    await this.database.transaction(async tx => {
      await tx.execute(
        `UPDATE users
            SET display_name = ?, config_group_id = ?, profile_sync_version = ?, monthly_limit = ?,
                password_hash = COALESCE(?, password_hash),
                password_cipher = COALESCE(?, password_cipher), status = 'ACTIVE',
                profile_sync_error_code = NULL, profile_sync_error_message = NULL,
                profile_sync_request_id = NULL
          WHERE account_id = ? AND user_id = ?`,
        [input.displayName.trim(), input.configGroupId, version.version, input.monthlyLimit,
          passwordHash, passwordCipher, input.accountId, input.userId],
      );
      if (passwordHash) {
        await tx.execute('DELETE FROM sessions WHERE user_id = ?', [input.userId]);
      }
    });
    return { userId: input.userId, status: 'ACTIVE' };
  }

  async retrySubaccount(input: {
    accountId: string;
    userId: string;
  }): Promise<{ userId: string; status: string }> {
    const rows = await this.database.query<ProfileTargetRow>(
      `SELECT u.role, u.status, u.login_name, u.config_group_id, g.connection_id, g.project_id,
              g.current_version, g.project_level_sharing, v.encrypted_config
         FROM users u
         LEFT JOIN config_groups g ON g.config_group_id = u.config_group_id
         LEFT JOIN config_group_versions v ON v.config_group_id = g.config_group_id
          AND v.version = g.current_version
        WHERE u.account_id = ? AND u.user_id = ?`,
      [input.accountId, input.userId],
    );
    const user = rows[0];
    if (!user || user.role !== 'SUBACCOUNT' || user.status === 'DELETED') {
      throw new AppError('子账号不存在', 404, 'SUBACCOUNT_NOT_FOUND');
    }
    if (!user.config_group_id || !user.connection_id || !user.project_id
        || !user.current_version || !user.encrypted_config) {
      throw new AppError('子账号配置组未就绪', 409, 'PROFILE_NOT_SYNCED');
    }
    try {
      const resourceConfig = decryptJson<ResourceConfig>(
        user.encrypted_config,
        this.config.encryptionKey,
      );
      await this.studioConnections.upsertProjectProfile(
        input.accountId,
        user.connection_id,
        user.project_id,
        resourceConfig,
        Boolean(user.project_level_sharing),
      );
      await this.studioConnections.upsertUserProfile(
        input.accountId,
        user.connection_id,
        user.project_id,
        user.login_name,
        resourceConfig,
        Boolean(user.project_level_sharing),
      );
      await this.database.execute(
        `UPDATE users
            SET status = 'ACTIVE', profile_sync_version = ?,
                profile_sync_error_code = NULL, profile_sync_error_message = NULL,
                profile_sync_request_id = NULL
          WHERE user_id = ?`,
        [user.current_version, input.userId],
      );
      return { userId: input.userId, status: 'ACTIVE' };
    } catch (error) {
      const failure = profileSyncError(error);
      await this.database.execute(
        `UPDATE users
            SET status = 'SYNC_FAILED', profile_sync_error_code = ?,
                profile_sync_error_message = ?, profile_sync_request_id = ?
          WHERE user_id = ?`,
        [failure.code, failure.message, failure.requestId, input.userId],
      );
      throw error;
    }
  }

  async deleteSubaccount(input: {
    accountId: string;
    userId: string;
  }): Promise<{ userId: string; status: string }> {
    const rows = await this.database.query<ProfileTargetRow>(
      `SELECT u.role, u.status, u.login_name, u.config_group_id, g.connection_id, g.project_id,
              g.current_version, NULL AS encrypted_config
         FROM users u
         LEFT JOIN config_groups g ON g.config_group_id = u.config_group_id
        WHERE u.account_id = ? AND u.user_id = ?`,
      [input.accountId, input.userId],
    );
    const user = rows[0];
    if (!user || user.role !== 'SUBACCOUNT' || user.status === 'DELETED') {
      throw new AppError('子账号不存在', 404, 'SUBACCOUNT_NOT_FOUND');
    }
    if (!user.connection_id || !user.project_id) {
      throw new AppError('子账号配置组未就绪', 409, 'PROFILE_NOT_SYNCED');
    }
    await this.studioConnections.deleteUserProfile(
      input.accountId,
      user.connection_id,
      user.project_id,
      user.login_name,
    );
    await this.database.transaction(async tx => {
      await tx.execute(
        `UPDATE users
            SET status = 'DELETED', profile_sync_error_code = NULL,
                profile_sync_error_message = NULL, profile_sync_request_id = NULL
          WHERE account_id = ? AND user_id = ?`,
        [input.accountId, input.userId],
      );
      await tx.execute('DELETE FROM sessions WHERE user_id = ?', [input.userId]);
    });
    return { userId: input.userId, status: 'DELETED' };
  }

  async deleteGroup(input: {
    accountId: string;
    configGroupId: string;
  }): Promise<{ configGroupId: string; status: string }> {
    const refs = await this.database.query<{ count: number } & RowDataPacket>(
      `SELECT COUNT(*) AS count FROM users
        WHERE account_id = ? AND config_group_id = ? AND status <> 'DELETED'`,
      [input.accountId, input.configGroupId],
    );
    if (Number(refs[0]?.count) > 0) {
      throw new AppError('配置组仍有关联的非删除用户', 409, 'CONFIG_GROUP_IN_USE');
    }
    const result = await this.database.execute(
      `UPDATE config_groups SET status = 'DELETED'
        WHERE account_id = ? AND config_group_id = ? AND status <> 'DELETED'`,
      [input.accountId, input.configGroupId],
    );
    if (result.affectedRows !== 1) {
      throw new AppError('配置组不存在', 404, 'CONFIG_GROUP_NOT_FOUND');
    }
    return { configGroupId: input.configGroupId, status: 'DELETED' };
  }
}
