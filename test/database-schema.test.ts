import { describe, expect, it } from 'vitest';

import {
  findDatabaseSchemaIssues,
  requiredDatabaseColumns,
} from '../src/database-schema.js';

function validColumns() {
  return Object.entries(requiredDatabaseColumns).flatMap(([tableName, columns]) => (
    columns.map(columnName => ({ tableName, columnName }))
  ));
}

describe('database schema validation', () => {
  it('accepts the studio-login schema', () => {
    expect(findDatabaseSchemaIssues(validColumns())).toEqual([]);
  });

  it('reports a colliding sessions table before serving traffic', () => {
    const columns = validColumns().filter(column => (
      column.tableName !== 'sessions' || column.columnName === 'user_id'
    ));
    expect(findDatabaseSchemaIssues(columns)).toContain(
      'sessions 缺少列 token_hash, expires_at',
    );
  });
});
