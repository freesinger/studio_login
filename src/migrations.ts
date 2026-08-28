import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

import mysql, { type RowDataPacket } from 'mysql2/promise';

import type { AppConfig } from './config.js';
import {
  findDatabaseSchemaIssues,
  incompatibleSchemaError,
  managedDatabaseTables,
  type DatabaseColumnInfo,
} from './database-schema.js';

interface MigrationRow extends RowDataPacket {
  version: string;
}

interface TableRow extends RowDataPacket {
  tableName: string;
}

interface ColumnRow extends RowDataPacket, DatabaseColumnInfo {}

export async function migrateDatabase(config: AppConfig): Promise<void> {
  const connection = await mysql.createConnection({
    uri: config.STUDIO_LOGIN_DATABASE_URL.replace(/^mysql2:/, 'mysql:'),
    timezone: 'Z',
    multipleStatements: true,
  });
  try {
    const [existingRows] = await connection.query<TableRow[]>(
      `SELECT TABLE_NAME AS tableName
         FROM information_schema.tables
        WHERE table_schema = DATABASE()`,
    );
    const existingManagedTables = existingRows
      .map(row => row.tableName)
      .filter(table => managedDatabaseTables.includes(table));
    if (!existingManagedTables.includes('schema_migrations') && existingManagedTables.length > 0) {
      throw incompatibleSchemaError([
        `目标库在首次迁移前已存在同名表 ${existingManagedTables.sort().join(', ')}`,
      ]);
    }

    await connection.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version VARCHAR(64) NOT NULL PRIMARY KEY,
        applied_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `);
    const [appliedRows] = await connection.query<MigrationRow[]>('SELECT version FROM schema_migrations');
    const applied = new Set(appliedRows.map(row => row.version));
    const schemaDir = path.resolve('sql/schema');
    const files = (await readdir(schemaDir)).filter(file => file.endsWith('.sql')).sort();
    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = await readFile(path.join(schemaDir, file), 'utf8');
      await connection.beginTransaction();
      try {
        await connection.query(sql);
        await connection.execute('INSERT INTO schema_migrations (version) VALUES (?)', [file]);
        await connection.commit();
      } catch (error) {
        await connection.rollback();
        throw error;
      }
    }
    const [columnRows] = await connection.query<ColumnRow[]>(
      `SELECT TABLE_NAME AS tableName, COLUMN_NAME AS columnName
         FROM information_schema.columns
        WHERE table_schema = DATABASE()`,
    );
    const issues = findDatabaseSchemaIssues(columnRows);
    if (issues.length > 0) throw incompatibleSchemaError(issues);
  } finally {
    await connection.end();
  }
}
