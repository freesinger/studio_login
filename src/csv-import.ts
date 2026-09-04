import { parse } from 'csv-parse/sync';
import { ZodError } from 'zod';

import { AppError } from './errors.js';

export interface CsvImportItem {
  row: number;
  success: boolean;
  message: string;
}

export interface CsvImportResult {
  total: number;
  succeeded: number;
  failed: number;
  items: CsvImportItem[];
}

export function parseCsvRecords(csv: string): Record<string, string>[] {
  let rows: Record<string, string>[];
  try {
    rows = parse(csv, {
      bom: true,
      columns: true,
      relax_column_count: false,
      skip_empty_lines: true,
      trim: true,
    }) as Record<string, string>[];
  } catch {
    throw new AppError('CSV 格式不合法，请使用下载的模板', 400, 'INVALID_CSV');
  }
  if (rows.length === 0) {
    throw new AppError('CSV 没有可导入的数据行', 400, 'EMPTY_CSV');
  }
  if (rows.length > 100) {
    throw new AppError('单次最多导入 100 行', 400, 'CSV_ROW_LIMIT_EXCEEDED');
  }
  return rows;
}

export async function importCsvRows(
  rows: readonly Record<string, string>[],
  work: (row: Record<string, string>) => Promise<string>,
): Promise<CsvImportResult> {
  const items: CsvImportItem[] = [];
  const concurrency = 5;
  for (let offset = 0; offset < rows.length; offset += concurrency) {
    const batch = rows.slice(offset, offset + concurrency);
    const results = await Promise.all(batch.map(async (row, index) => {
      const rowNumber = offset + index + 2;
      try {
        return { row: rowNumber, success: true, message: await work(row) };
      } catch (error) {
        return { row: rowNumber, success: false, message: importErrorMessage(error) };
      }
    }));
    items.push(...results);
  }
  const succeeded = items.filter(item => item.success).length;
  return {
    total: items.length,
    succeeded,
    failed: items.length - succeeded,
    items,
  };
}

function importErrorMessage(error: unknown): string {
  if (error instanceof ZodError) {
    return error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('；');
  }
  if (error instanceof AppError) return error.message;
  if ((error as { code?: string }).code === 'ER_DUP_ENTRY') return '记录已存在';
  return '导入失败';
}
