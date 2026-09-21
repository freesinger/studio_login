import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

import mysql, { type RowDataPacket } from 'mysql2/promise';

import { translate } from './i18n.js';
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

const priceFormulaMigration = '012_billing_context_price_formula.sql';
const taskItemFormulaMigration = '013_task_item_formula_snapshots.sql';

interface CompatibilityColumn {
  tableName: 'operator_prices' | 'studio_task_items';
  columnName: string;
  addColumnSql: string;
}

const operatorPriceFormulaColumns: CompatibilityColumn[] = [
  {
    tableName: 'operator_prices',
    columnName: 'customer_price_formula',
    addColumnSql: 'ALTER TABLE operator_prices ADD COLUMN customer_price_formula TEXT NULL AFTER customer_unit_price',
  },
  {
    tableName: 'operator_prices',
    columnName: 'cost_price_formula',
    addColumnSql: 'ALTER TABLE operator_prices ADD COLUMN cost_price_formula TEXT NULL AFTER cost_unit_price',
  },
];

const taskItemFormulaColumns: CompatibilityColumn[] = [
  {
    tableName: 'studio_task_items',
    columnName: 'customer_price_formula',
    addColumnSql: 'ALTER TABLE studio_task_items ADD COLUMN customer_price_formula TEXT NULL AFTER customer_unit_price',
  },
  {
    tableName: 'studio_task_items',
    columnName: 'cost_price_formula',
    addColumnSql: 'ALTER TABLE studio_task_items ADD COLUMN cost_price_formula TEXT NULL AFTER cost_unit_price',
  },
  {
    tableName: 'studio_task_items',
    columnName: 'estimated_customer_amount',
    addColumnSql: 'ALTER TABLE studio_task_items ADD COLUMN estimated_customer_amount DECIMAL(20,6) NULL AFTER cost_price_formula',
  },
  {
    tableName: 'studio_task_items',
    columnName: 'actual_customer_amount',
    addColumnSql: 'ALTER TABLE studio_task_items ADD COLUMN actual_customer_amount DECIMAL(20,6) NULL AFTER estimated_customer_amount',
  },
  {
    tableName: 'studio_task_items',
    columnName: 'estimated_cost_amount',
    addColumnSql: 'ALTER TABLE studio_task_items ADD COLUMN estimated_cost_amount DECIMAL(20,6) NULL AFTER actual_customer_amount',
  },
  {
    tableName: 'studio_task_items',
    columnName: 'actual_cost_amount',
    addColumnSql: 'ALTER TABLE studio_task_items ADD COLUMN actual_cost_amount DECIMAL(20,6) NULL AFTER estimated_cost_amount',
  },
];

async function repairFormulaMigrationCompatibility(
  connection: mysql.Connection,
  applied: Set<string>,
): Promise<void> {
  const [columnRows] = await connection.query<ColumnRow[]>(
    `SELECT TABLE_NAME AS tableName, COLUMN_NAME AS columnName
       FROM information_schema.columns
      WHERE table_schema = DATABASE()
        AND table_name IN ('operator_prices', 'studio_task_items')`,
  );
  const tableColumns = new Map<string, Set<string>>();
  for (const row of columnRows) {
    const columns = tableColumns.get(row.tableName) ?? new Set<string>();
    columns.add(row.columnName);
    tableColumns.set(row.tableName, columns);
  }

  const operatorColumns = tableColumns.get('operator_prices');
  if (operatorColumns) {
    const hasAnyFormulaColumn = operatorPriceFormulaColumns
      .some(column => operatorColumns.has(column.columnName));
    if (applied.has(priceFormulaMigration) || hasAnyFormulaColumn) {
      await addMissingColumns(connection, operatorColumns, operatorPriceFormulaColumns);
      if (!applied.has(priceFormulaMigration)) {
        await connection.execute('INSERT IGNORE INTO schema_migrations (version) VALUES (?)', [priceFormulaMigration]);
        applied.add(priceFormulaMigration);
      }
    }
  }

  const taskItemColumns = tableColumns.get('studio_task_items');
  if (taskItemColumns) {
    const hasAnyFormulaColumn = taskItemFormulaColumns
      .some(column => taskItemColumns.has(column.columnName));
    if (applied.has(taskItemFormulaMigration) || hasAnyFormulaColumn) {
      await addMissingColumns(connection, taskItemColumns, taskItemFormulaColumns);
      if (!applied.has(taskItemFormulaMigration)) {
        await connection.execute('INSERT IGNORE INTO schema_migrations (version) VALUES (?)', [taskItemFormulaMigration]);
        applied.add(taskItemFormulaMigration);
      }
    }
  }
}

async function addMissingColumns(
  connection: mysql.Connection,
  existingColumns: Set<string>,
  columns: readonly CompatibilityColumn[],
): Promise<void> {
  for (const column of columns) {
    if (existingColumns.has(column.columnName)) continue;
    await connection.query(column.addColumnSql);
    existingColumns.add(column.columnName);
  }
}

export async function migrateDatabase(config: AppConfig): Promise<void> {
  const connection = await mysql.createConnection({
    uri: config.STUDIO_LOGIN_DATABASE_URL.replace(/^mysql2:/, 'mysql:'),
    timezone: '+08:00',
    multipleStatements: true,
  });
  try {
    await connection.query("SET time_zone = '+08:00'");
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
        translate('startup.existingTables', 'zh-CN', { tables: existingManagedTables.sort().join(', ') }),
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
    await repairFormulaMigrationCompatibility(connection, applied);
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
