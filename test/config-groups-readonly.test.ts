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

function subaccountService(existingGroupIds: string[]) {
  const config = loadConfig({
    ...baseEnv,
    STUDIO_LOGIN_READONLY_CONFIG_GROUP_PROJECT_IDS: 'locked_project_alpha,locked_project_beta',
  });
  const groups = [
    { config_group_id: 'grp-locked', project_id: 'locked_project_alpha' },
    { config_group_id: 'grp-other-locked', project_id: 'locked_project_beta' },
    { config_group_id: 'grp-editable', project_id: 'editable_project' },
  ].map(group => ({
    ...group,
    connection_id: 'conn-1',
    current_version: 1,
    version: 1,
    encrypted_config: encryptJson({ lasApiKey: 'las-secret' }, config.encryptionKey),
  }));
  const query = async <T extends RowDataPacket>(sql: string, params: readonly unknown[] = []): Promise<T[]> => {
    let rows: Array<Record<string, unknown>> = [];
    if (sql.includes('FROM users')) rows = [{ role: 'SUBACCOUNT', login_name: 'existing-user' }];
    if (sql.includes('FROM studio_registrations')) rows = [{ status: 'READY' }];
    if (sql.includes('FROM config_groups')) {
      const ids = sql.includes('IN (') ? params.slice(1) : [params[0]];
      rows = groups.filter(group => ids.includes(group.config_group_id));
    }
    if (sql.includes('FROM user_config_group_bindings')) {
      rows = sql.includes('COUNT(*)') ? [{ failed: 0 }] : existingGroupIds.map(configGroupId => ({
        config_group_id: configGroupId,
        profile_sync_version: 1,
        profile_sync_error_code: null,
      }));
    }
    return rows as T[];
  };
  const execute = vi.fn<Database['execute']>(async () => executeResult);
  const database: Database = {
    query,
    execute,
    transaction: async work => work({ query, execute }),
    close: async () => undefined,
  };
  const connections = { upsertUserProfile: vi.fn(), deleteUserProfile: vi.fn(async () => undefined) };
  const service = new ConfigGroupService(database, config, connections as unknown as StudioConnectionService);
  return { service, execute, connections };
}

describe('read-only config groups', () => {
  it.each(['create', 'update'] as const)('%s rejects new read-only subaccount bindings before any write', async operation => {
    const database = databaseWithGroups([{
      config_group_id: 'grp-locked',
      project_id: 'locked_project_alpha',
      connection_id: 'conn-1',
      current_version: 1,
    }]);
    const query = database.query.bind(database);
    vi.spyOn(database, 'query').mockImplementation(async (sql, params) => {
      if (sql.includes('FROM users')) {
        return [{ role: 'SUBACCOUNT', login_name: 'existing-user' }] as RowDataPacket[];
      }
      return query(sql, params);
    });
    const execute = vi.spyOn(database, 'execute');
    const transaction = vi.spyOn(database, 'transaction');
    const config = loadConfig({
      ...baseEnv,
      STUDIO_LOGIN_READONLY_CONFIG_GROUP_PROJECT_IDS: 'locked_project_alpha',
    });
    const service = new ConfigGroupService(database, config, {} as StudioConnectionService);
    const input = {
      accountId: 'acc_demo',
      userId: 'usr-existing',
      loginName: 'new-user',
      displayName: 'Changed name',
      password: 'ChangedPassword123!',
      monthlyLimit: null,
    };
    for (const selection of [
      { configGroupId: 'grp-locked' },
      { configGroupBindings: [{ configGroupId: 'grp-locked', monthlyLimit: null, isDefault: true }] },
    ]) {
      await expect(operation === 'create'
        ? service.createSubaccount({ ...input, ...selection })
        : service.updateSubaccount({ ...input, ...selection }))
        .rejects.toMatchObject({ code: 'CONFIG_GROUP_READ_ONLY', statusCode: 403 });
    }
    expect(execute).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
  });

  it.each(['legacy', 'multiple'] as const)('allows editing an existing read-only binding using %s input', async format => {
    const { service, execute, connections } = subaccountService(['grp-locked']);
    const selection = format === 'legacy'
      ? { configGroupId: 'grp-locked' }
      : { configGroupBindings: [{ configGroupId: 'grp-locked', monthlyLimit: '200', isDefault: true }] };
    await expect(service.updateSubaccount({
      accountId: 'acc_demo',
      userId: 'usr-existing',
      displayName: 'Changed name',
      password: 'ChangedPassword123!',
      monthlyLimit: '200',
      ...selection,
    })).resolves.toMatchObject({ userId: 'usr-existing', status: 'ACTIVE' });
    expect(execute).toHaveBeenCalledWith(expect.stringContaining('SET display_name = ?'), [
      'Changed name', expect.any(String), expect.any(String), 'acc_demo', 'usr-existing',
    ]);
    expect(execute).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO user_config_group_bindings'), [
      'usr-existing', 'grp-locked', true, '200',
    ]);
    expect(connections.deleteUserProfile).not.toHaveBeenCalled();
  });

  it('allows migrating an existing user away from a read-only group', async () => {
    const { service, connections } = subaccountService(['grp-locked']);
    await expect(service.updateSubaccount({
      accountId: 'acc_demo', userId: 'usr-existing', displayName: 'Migrated user',
      configGroupId: 'grp-editable', monthlyLimit: null,
    })).resolves.toMatchObject({ status: 'ACTIVE' });
    expect(connections.deleteUserProfile).toHaveBeenCalledWith(
      'acc_demo', 'conn-1', 'locked_project_alpha', 'existing-user',
    );
    expect(connections.upsertUserProfile).toHaveBeenCalledWith(
      'acc_demo', 'conn-1', 'editable_project', 'existing-user', expect.any(Object), false,
    );
  });

  it('does not let an existing user add a different read-only group', async () => {
    const { service, execute } = subaccountService(['grp-locked']);
    await expect(service.updateSubaccount({
      accountId: 'acc_demo', userId: 'usr-existing', displayName: 'Existing user', monthlyLimit: null,
      configGroupBindings: [
        { configGroupId: 'grp-locked', monthlyLimit: null, isDefault: true },
        { configGroupId: 'grp-other-locked', monthlyLimit: null },
      ],
    })).rejects.toMatchObject({ code: 'CONFIG_GROUP_READ_ONLY', statusCode: 403 });
    expect(execute).not.toHaveBeenCalled();
  });

  it('does not let a migrated user move back to a read-only group', async () => {
    const { service, execute } = subaccountService(['grp-editable']);
    await expect(service.updateSubaccount({
      accountId: 'acc_demo', userId: 'usr-existing', displayName: 'Migrated user',
      configGroupId: 'grp-locked', monthlyLimit: null,
    })).rejects.toMatchObject({ code: 'CONFIG_GROUP_READ_ONLY', statusCode: 403 });
    expect(execute).not.toHaveBeenCalled();
  });

  it('rejects a read-only secondary binding even when the default group is editable', async () => {
    const service = serviceWithRows([
      { config_group_id: 'grp-editable', project_id: 'editable_project', current_version: 1 },
      { config_group_id: 'grp-locked', project_id: 'locked_project_beta', current_version: 1 },
    ]);
    await expect(service.createSubaccount({
      accountId: 'acc_demo',
      loginName: 'new-user',
      displayName: 'New user',
      password: 'NewPassword123!',
      monthlyLimit: null,
      configGroupBindings: [
        { configGroupId: 'grp-editable', monthlyLimit: null, isDefault: true },
        { configGroupId: 'grp-locked', monthlyLimit: null, isDefault: false },
      ],
    })).rejects.toMatchObject({ code: 'CONFIG_GROUP_READ_ONLY', statusCode: 403 });
  });

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
