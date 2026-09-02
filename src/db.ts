import mysql, {
  type Pool,
  type PoolConnection,
  type ResultSetHeader,
  type RowDataPacket,
} from 'mysql2/promise';

import type { AppConfig } from './config.js';
import {
  findDatabaseSchemaIssues,
  incompatibleSchemaError,
  type DatabaseColumnInfo,
} from './database-schema.js';

export type { ResultSetHeader, RowDataPacket };

export interface DatabaseExecutor {
  query<T extends RowDataPacket>(sql: string, params?: readonly unknown[]): Promise<T[]>;
  execute(sql: string, params?: readonly unknown[]): Promise<ResultSetHeader>;
}

export interface Database extends DatabaseExecutor {
  transaction<T>(work: (tx: DatabaseExecutor) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

function executor(connection: Pool | PoolConnection): DatabaseExecutor {
  return {
    async query<T extends RowDataPacket>(sql: string, params: readonly unknown[] = []): Promise<T[]> {
      const [rows] = await connection.query<T[]>(sql, [...params] as never[]);
      return rows;
    },
    async execute(sql: string, params: readonly unknown[] = []): Promise<ResultSetHeader> {
      const [result] = await connection.execute<ResultSetHeader>(sql, [...params] as never[]);
      return result;
    },
  };
}

export function createDatabase(config: AppConfig): Database {
  const url = new URL(config.STUDIO_LOGIN_DATABASE_URL);
  const databaseName = url.pathname.slice(1);
  if (!databaseName) throw new Error('STUDIO_LOGIN_DATABASE_URL 必须包含数据库名');

  const pool = mysql.createPool({
    uri: config.STUDIO_LOGIN_DATABASE_URL.replace(/^mysql2:/, 'mysql:'),
    connectionLimit: config.STUDIO_LOGIN_DB_CONNECTION_LIMIT,
    timezone: '+08:00',
    charset: 'utf8mb4',
    decimalNumbers: false,
  });
  const base = executor(pool);

  return {
    ...base,
    async transaction<T>(work: (tx: DatabaseExecutor) => Promise<T>): Promise<T> {
      const connection = await pool.getConnection();
      try {
        await connection.beginTransaction();
        const result = await work(executor(connection));
        await connection.commit();
        return result;
      } catch (error) {
        await connection.rollback();
        throw error;
      } finally {
        connection.release();
      }
    },
    async close(): Promise<void> {
      await pool.end();
    },
  };
}

interface ColumnRow extends RowDataPacket, DatabaseColumnInfo {}

export async function checkDatabase(database: Database): Promise<void> {
  await database.query<RowDataPacket>('SELECT 1 AS ok');
  const rows = await database.query<ColumnRow>(
    `SELECT TABLE_NAME AS tableName, COLUMN_NAME AS columnName
       FROM information_schema.columns
      WHERE table_schema = DATABASE()`,
  );
  const issues = findDatabaseSchemaIssues(rows);
  if (issues.length > 0) throw incompatibleSchemaError(issues);
}
