import { translate } from './i18n.js';

export const requiredDatabaseColumns = {
  schema_migrations: ['version', 'applied_at'],
  system_state: ['id', 'initialized'],
  accounts: ['account_id', 'name', 'status'],
  users: [
    'user_id',
    'account_id',
    'login_name',
    'password_hash',
    'password_cipher',
    'role',
    'status',
    'profile_sync_error_code',
    'profile_sync_error_message',
    'profile_sync_request_id',
  ],
  sessions: ['token_hash', 'user_id', 'expires_at'],
  config_groups: [
    'config_group_id',
    'account_id',
    'connection_id',
    'project_id',
    'status',
    'current_version',
    'project_level_sharing',
  ],
  config_group_versions: ['config_group_id', 'version', 'encrypted_config', 'masked_config'],
  studio_registrations: [
    'account_id',
    'connection_id',
    'name',
    'is_default',
    'app_id',
    'status',
    'studio_base_url',
    'callback_base_url',
    'integration_token_cipher',
    'billing_catalog_json',
  ],
  studio_login_tickets: [
    'ticket_hash',
    'connection_id',
    'app_id',
    'user_id',
    'project_id',
    'expires_at',
    'consumed_at',
  ],
  operator_prices: [
    'price_id',
    'scope_type',
    'scope_id',
    'billing_item_id',
    'customer_unit_price',
    'cost_unit_price',
  ],
  studio_tasks: [
    'task_id',
    'connection_id',
    'app_id',
    'user_id',
    'request_id',
    'status',
    'billing_audit_payload',
    'last_reconcile_at',
    'last_reconcile_status',
    'last_reconcile_error',
    'reconcile_error_info',
    'reconcile_attempts',
    'next_reconcile_at',
  ],
  studio_task_items: [
    'task_id',
    'item_index',
    'billing_item_id',
    'model_id',
    'estimated_usage',
    'actual_usage',
    'estimated_billing_context',
    'actual_billing_context',
    'status',
  ],
  period_usage: ['app_id', 'subject_type', 'subject_id', 'billing_period', 'reserved_amount', 'actual_amount'],
  user_config_group_bindings: ['user_id', 'config_group_id', 'is_default', 'monthly_limit'],
  api_rate_limits: ['action', 'subject_key', 'window_started_at', 'request_count'],
} as const;

export const managedDatabaseTables = Object.keys(requiredDatabaseColumns);

export interface DatabaseColumnInfo {
  tableName: string;
  columnName: string;
}

export function findDatabaseSchemaIssues(columns: readonly DatabaseColumnInfo[]): string[] {
  const actual = new Map<string, Set<string>>();
  for (const column of columns) {
    const tableColumns = actual.get(column.tableName) ?? new Set<string>();
    tableColumns.add(column.columnName);
    actual.set(column.tableName, tableColumns);
  }

  const issues: string[] = [];
  for (const [tableName, requiredColumns] of Object.entries(requiredDatabaseColumns)) {
    const actualColumns = actual.get(tableName);
    if (!actualColumns) {
      issues.push(translate('startup.tableMissing', 'zh-CN', { table: tableName }));
      continue;
    }
    const missingColumns = requiredColumns.filter(column => !actualColumns.has(column));
    if (missingColumns.length > 0) {
      issues.push(translate('startup.columnsMissing', 'zh-CN', { table: tableName, columns: missingColumns.join(', ') }));
    }
  }
  return issues;
}

export function incompatibleSchemaError(issues: readonly string[]): Error {
  return new Error(
    translate('startup.incompatibleSchema', 'zh-CN', { details: issues.join('；') }),
  );
}
