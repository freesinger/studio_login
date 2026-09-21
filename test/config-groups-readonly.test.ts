import { describe, expect, it, vi } from 'vitest';

import { ConfigGroupService } from '../src/config-groups.js';
import { loadConfig } from '../src/config.js';
import type { Database, DatabaseExecutor, ResultSetHeader, RowDataPacket } from '../src/db.js';
import { encryptJson } from '../src/security.js';
import type { StudioConnectionService } from '../src/studio-connections.js';

const executeResult = {
  affectedRows: 1,
  changedRows: 1,
  fieldCount: 0,
  info: '',
  insertId: 0,
  serverStatus: 2,
  warningStatus: 0,
} as ResultSetHeader;

const baseEnv = {
  APP_ENV: 'test',
  STUDIO_LOGIN_LOG_LEVEL: 'silent',
  STUDIO_LOGIN_DATABASE_URL: 'mysql://root@127.0.0.1:3307/unused',
  STUDIO_LOGIN_ACCOUNT_ID: 'studio',
  STUDIO_LOGIN_ADMIN_USERNAME: 'admin',
  STUDIO_LOGIN_ADMIN_PASSWORD: 'test-password-123',
  LAS_STUDIO_INTEGRATION_TOKEN: 'test-integration-token-01234567890123',
};

function databaseWithGroups(rows: Array<Record<string, unknown>>): Database {
  const query = async <T extends RowDataPacket>(sql: string): Promise<T[]> => {
    if (sql.includes('FROM config_groups')) return rows as T[];
    if (sql.includes('FROM config_group_versions')) return [] as T[];
    return [] as T[];
  };
  const execute = async (): Promise<ResultSetHeader> => executeResult;
  return {
    query,
    execute,
    transaction: async <T>(work: (tx: DatabaseExecutor) => Promise<T>) => work({
      query,
      execute,
    }),
    close: vi.fn(async () => undefined),
  } as unknown as Database;
}

function serviceWithRows(rows: Array<Record<string, unknown>>) {
  const config = loadConfig({
    ...baseEnv,
    STUDIO_LOGIN_READONLY_CONFIG_GROUP_PROJECT_IDS: 'locked_project_alpha,locked_project_beta',
  });
  return new ConfigGroupService(
    databaseWithGroups(rows),
    config,
    {} as StudioConnectionService,
  );
}

describe('read-only config groups', () => {
  it('rejects creation for configured read-only Projects', async () => {
    await expect(serviceWithRows([]).create({
      accountId: 'acc_demo',
      connectionId: 'conn-1',
      projectId: 'locked_project_beta',
      resourceConfig: {
        lasApiKey: 'las-secret',
        arkApiKey: 'ark-secret',
        tosBucketName: 'bucket',
      },
      monthlyLimit: null,
      isDefault: false,
      projectLevelSharing: true,
      actor: {
        userId: 'admin', accountId: 'acc_demo', loginName: 'admin', displayName: 'Admin', role: 'SYSTEM_ADMIN',
      },
    })).rejects.toMatchObject({ code: 'CONFIG_GROUP_READ_ONLY', statusCode: 403 });
  });

  it('flags groups whose Project ID is configured as read-only', async () => {
    const [item] = await serviceWithRows([{
      config_group_id: 'grp-1',
      account_id: 'acc_demo',
      connection_id: 'conn-1',
      project_id: 'locked_project_alpha',
      name: 'locked_project_alpha',
      status: 'AVAILABLE',
      current_version: 1,
      monthly_limit: null,
      is_default: 0,
      project_level_sharing: 0,
      reserved_amount: null,
      actual_amount: null,
    }]).list('acc_demo') as Array<{ readOnly: boolean }>;

    expect(item?.readOnly).toBe(true);
  });

  it('rejects updates, publishes, and deletes for configured read-only projects', async () => {
    const config = loadConfig({
      ...baseEnv,
      STUDIO_LOGIN_READONLY_CONFIG_GROUP_PROJECT_IDS: 'locked_project_alpha,locked_project_beta',
    });
    const encrypted = encryptJson({
      lasApiKey: 'las-secret',
      arkApiKey: 'ark-secret',
      tosBucketName: 'bucket',
    }, config.encryptionKey);
    const service = new ConfigGroupService(
      databaseWithGroups([{
        config_group_id: 'grp-1',
        account_id: 'acc_demo',
        connection_id: 'conn-1',
        project_id: 'locked_project_alpha',
        name: 'locked_project_alpha',
        status: 'AVAILABLE',
        current_version: 1,
        monthly_limit: null,
        is_default: 0,
        project_level_sharing: 0,
        encrypted_config: encrypted,
      }]),
      config,
      {} as StudioConnectionService,
    );

    await expect(service.createVersion({
      accountId: 'acc_demo',
      configGroupId: 'grp-1',
      resourceConfig: {},
      monthlyLimit: null,
      actor: {
        userId: 'admin', accountId: 'acc_demo', loginName: 'admin', displayName: 'Admin', role: 'SYSTEM_ADMIN',
      },
    })).rejects.toMatchObject({ code: 'CONFIG_GROUP_READ_ONLY', statusCode: 403 });
    await expect(service.publish({ accountId: 'acc_demo', configGroupId: 'grp-1' }))
      .rejects.toMatchObject({ code: 'CONFIG_GROUP_READ_ONLY', statusCode: 403 });
    await expect(service.deleteGroup({ accountId: 'acc_demo', configGroupId: 'grp-1' }))
      .rejects.toMatchObject({ code: 'CONFIG_GROUP_READ_ONLY', statusCode: 403 });
  });
});
