import { parse } from 'csv-parse/sync';
import { ZodError } from 'zod';

import { message, formatMessage, formatValidationIssues, translate, type Locale, type LocalizedMessage } from './i18n.js';
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
      relax_column_count: true,
      skip_empty_lines: true,
      trim: true,
    }) as Record<string, string>[];
  } catch {
    throw new AppError(message('csv.invalidFormat'), 400, 'INVALID_CSV');
  }
  if (rows.length === 0) {
    throw new AppError(message('csv.empty'), 400, 'EMPTY_CSV');
  }
  if (rows.length > 100) {
    throw new AppError(message('csv.rowLimit'), 400, 'CSV_ROW_LIMIT_EXCEEDED');
  }
  return rows;
}

export async function importCsvRows(
  rows: readonly Record<string, string>[],
  work: (row: Record<string, string>) => Promise<string | LocalizedMessage>,
  locale: Locale = 'zh-CN',
): Promise<CsvImportResult> {
  const items: CsvImportItem[] = [];
  const concurrency = 5;
  for (let offset = 0; offset < rows.length; offset += concurrency) {
    const batch = rows.slice(offset, offset + concurrency);
    const results = await Promise.all(batch.map(async (row, index) => {
      const rowNumber = offset + index + 2;
      try {
        return { row: rowNumber, success: true, message: formatMessage(await work(row), locale) };
      } catch (error) {
        return { row: rowNumber, success: false, message: importErrorMessage(error, locale) };
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

function importErrorMessage(error: unknown, locale: Locale): string {
  if (error instanceof ZodError) {
    const issues = formatValidationIssues(error.issues, locale);
    return issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join(locale === 'en' ? '; ' : '；');
  }
  if (error instanceof AppError) return error.localize(locale);
  if ((error as { code?: string }).code === 'ER_DUP_ENTRY') return translate('csv.recordExists', locale);
  return translate('csv.failed', locale);
}
