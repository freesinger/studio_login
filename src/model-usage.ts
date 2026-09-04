import type { RowDataPacket } from 'mysql2/promise';

import type { Database } from './db.js';
import { AppError } from './errors.js';

export type ModelUsageGroupBy = 'billingItem' | 'model' | 'configGroup' | 'subaccount' | 'unit' | 'status';

export interface ModelUsageQuery {
  accountId: string;
  startDate: string;
  endDate: string;
  mode: 'detail' | 'summary';
  groupBy: ModelUsageGroupBy;
  billingItemId?: string;
  modelId?: string;
  configGroupId?: string;
  userId?: string;
  status?: string;
  page: number;
  pageSize: number;
}

interface CountRow extends RowDataPacket { total: number }

export interface TokenUsageSummary {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cachedTokens?: number;
  audioTokens?: number;
  reasoningTokens?: number;
}

const groupColumns: Record<ModelUsageGroupBy, { id: string; name: string }> = {
  billingItem: { id: 'i.billing_item_id', name: 'i.billing_item_id' },
  model: { id: "COALESCE(i.model_id, '')", name: "COALESCE(i.model_id, '未上报')" },
  configGroup: { id: 't.config_group_id', name: 'g.name' },
  subaccount: { id: 't.user_id', name: 'u.display_name' },
  unit: { id: 'i.unit', name: 'i.unit' },
  status: { id: 'i.status', name: 'i.status' },
};

function dateRange(startDate: string, endDate: string): [Date, Date] {
  const start = new Date(`${startDate}T00:00:00+08:00`);
  const end = new Date(`${endDate}T00:00:00+08:00`);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end < start) {
    throw new AppError('统计日期范围不合法', 400, 'INVALID_DATE_RANGE');
  }
  const exclusiveEnd = new Date(end.getTime() + 86_400_000);
  if (exclusiveEnd.getTime() - start.getTime() > 90 * 86_400_000) {
    throw new AppError('统计日期范围不能超过 90 天', 400, 'DATE_RANGE_TOO_LARGE');
  }
  return [start, exclusiveEnd];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function numberField(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  const number = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(number) ? number : undefined;
}

function firstNumberField(
  record: Record<string, unknown>,
  ...keys: string[]
): number | undefined {
  for (const key of keys) {
    const value = numberField(record, key);
    if (value !== undefined) return value;
  }
  return undefined;
}

function parseBillingContext(value: unknown): Record<string, unknown> | null {
  if (!value) return null;
  if (isRecord(value)) return value;
  if (typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function tokenUsageSummary(value: unknown): TokenUsageSummary | null {
  const context = parseBillingContext(value);
  if (!context) return null;
  const inputDetails = isRecord(context.input_tokens_details)
    ? context.input_tokens_details
    : isRecord(context.prompt_tokens_details)
      ? context.prompt_tokens_details
      : {};
  const outputDetails = isRecord(context.output_tokens_details)
    ? context.output_tokens_details
    : isRecord(context.completion_tokens_details)
      ? context.completion_tokens_details
      : {};
  const summary: TokenUsageSummary = {
    inputTokens: firstNumberField(context, 'input_tokens', 'prompt_tokens'),
    outputTokens: firstNumberField(context, 'output_tokens', 'completion_tokens'),
    totalTokens: numberField(context, 'total_tokens'),
    cachedTokens: numberField(inputDetails, 'cached_tokens'),
    audioTokens: numberField(inputDetails, 'audio_tokens'),
    reasoningTokens: numberField(outputDetails, 'reasoning_tokens'),
  };
  return Object.values(summary).some(value => value !== undefined) ? summary : null;
}

function withUsageContext(row: RowDataPacket): RowDataPacket {
  const record = row as Record<string, unknown>;
  const context = record.actualBillingContext ?? record.estimatedBillingContext;
  const summary = tokenUsageSummary(context);
  if (summary) record.tokenUsage = summary;
  delete record.actualBillingContext;
  delete record.estimatedBillingContext;
  return row;
}

export class ModelUsageService {
  constructor(private readonly database: Database) {}

  async query(input: ModelUsageQuery, includeCost: boolean): Promise<unknown> {
    const [start, end] = dateRange(input.startDate, input.endDate);
    const where = [
      'r.account_id = ?',
      't.created_at >= ?',
      't.created_at < ?',
    ];
    const params: unknown[] = [input.accountId, start, end];
    const filters: Array<[string, unknown]> = [
      ['i.billing_item_id = ?', input.billingItemId],
      ['i.model_id = ?', input.modelId],
      ['t.config_group_id = ?', input.configGroupId],
      ['t.user_id = ?', input.userId],
      ['i.status = ?', input.status],
    ];
    for (const [clause, value] of filters) {
      if (value) {
        where.push(clause);
        params.push(value);
      }
    }
    const from = `FROM studio_task_items i
      JOIN studio_tasks t ON t.task_id = i.task_id
      JOIN studio_registrations r ON r.connection_id = t.connection_id
      JOIN config_groups g ON g.config_group_id = t.config_group_id
      JOIN users u ON u.user_id = t.user_id
      WHERE ${where.join(' AND ')}`;
    const usageExpression = 'COALESCE(i.actual_usage, i.estimated_usage)';
    const totals = (await this.database.query<RowDataPacket>(
      `SELECT COUNT(*) AS callCount,
              SUM(i.status = 'SUCCEEDED') AS successCount,
              SUM(i.status IN ('FAILED', 'CANCELLED')) AS failedCount,
              SUM(i.status = 'RUNNING') AS runningCount,
              COALESCE(SUM(${usageExpression} * i.customer_unit_price), 0) AS customerAmount,
              COALESCE(SUM(${usageExpression} * i.cost_unit_price), 0) AS costAmount
         ${from}`,
      params,
    ))[0] ?? {};
    const usageByUnit = await this.database.query<RowDataPacket>(
      `SELECT i.unit, COALESCE(SUM(${usageExpression}), 0) AS usageValue
         ${from}
        GROUP BY i.unit ORDER BY i.unit`,
      params,
    );
    const tokenRows = await this.database.query<RowDataPacket>(
      `SELECT COALESCE(SUM(CASE WHEN i.unit = 'token' THEN 0 ELSE CAST(COALESCE(
                JSON_UNQUOTE(JSON_EXTRACT(COALESCE(i.actual_billing_context, i.estimated_billing_context), '$.total_tokens')),
                '0') AS DECIMAL(20,6)) END), 0) AS usageValue
         ${from}`,
      params,
    );
    const tokenUsage = Number(tokenRows[0]?.usageValue ?? 0);
    if (tokenUsage > 0) {
      usageByUnit.push({ unit: 'token', usageValue: String(tokenUsage) } as RowDataPacket);
    }
    const offset = (input.page - 1) * input.pageSize;
    let items: RowDataPacket[];
    let total: number;
    if (input.mode === 'summary') {
      const group = groupColumns[input.groupBy];
      const countRows = await this.database.query<CountRow>(
        `SELECT COUNT(*) AS total FROM (
           SELECT 1 AS grouped_row ${from} GROUP BY ${group.id}, ${group.name}, i.unit
         ) grouped`,
        params,
      );
      total = Number(countRows[0]?.total ?? 0);
      items = await this.database.query<RowDataPacket>(
        `SELECT ${group.id} AS dimensionId, ${group.name} AS dimensionName, i.unit,
                COUNT(*) AS callCount,
                SUM(i.status = 'SUCCEEDED') AS successCount,
                SUM(i.status IN ('FAILED', 'CANCELLED')) AS failedCount,
                SUM(i.status = 'RUNNING') AS runningCount,
                COALESCE(SUM(${usageExpression}), 0) AS usageValue,
                COALESCE(SUM(${usageExpression} * i.customer_unit_price), 0) AS customerAmount,
                COALESCE(SUM(${usageExpression} * i.cost_unit_price), 0) AS costAmount
           ${from}
          GROUP BY ${group.id}, ${group.name}, i.unit
          ORDER BY callCount DESC, dimensionName, i.unit
          LIMIT ? OFFSET ?`,
        [...params, input.pageSize, offset],
      );
    } else {
      const countRows = await this.database.query<CountRow>(`SELECT COUNT(*) AS total ${from}`, params);
      total = Number(countRows[0]?.total ?? 0);
      items = await this.database.query<RowDataPacket>(
        `SELECT t.task_id AS taskId, t.request_id AS requestId, t.created_at AS createdAt,
                t.finished_at AS finishedAt, i.billing_item_id AS billingItemId,
                i.model_id AS modelId, i.unit, i.estimated_usage AS estimatedUsage,
                i.actual_usage AS actualUsage, i.status,
                TIMESTAMPDIFF(MINUTE, t.created_at, COALESCE(t.finished_at, UTC_TIMESTAMP())) AS runningMinutes,
                t.last_reconcile_at AS lastReconcileAt,
                t.last_reconcile_status AS lastReconcileStatus,
                t.reconcile_attempts AS reconcileAttempts,
                t.next_reconcile_at AS nextReconcileAt,
                i.estimated_billing_context AS estimatedBillingContext,
                i.actual_billing_context AS actualBillingContext,
                (${usageExpression} * i.customer_unit_price) AS customerAmount,
                (${usageExpression} * i.cost_unit_price) AS costAmount,
                t.config_group_id AS configGroupId, g.name AS configGroupName,
                t.user_id AS userId, u.login_name AS loginName, u.display_name AS displayName
           ${from}
          ORDER BY t.created_at DESC, t.task_id, i.billing_item_id
          LIMIT ? OFFSET ?`,
        [...params, input.pageSize, offset],
      );
    }
    const hideCost = (row: Record<string, unknown>): Record<string, unknown> => {
      if (includeCost) return row;
      const { costAmount: _costAmount, ...visible } = row;
      return visible;
    };
    return {
      mode: input.mode,
      groupBy: input.groupBy,
      page: input.page,
      pageSize: input.pageSize,
      total,
      totals: hideCost(totals),
      usageByUnit,
      items: items.map(withUsageContext).map(hideCost),
    };
  }
}
