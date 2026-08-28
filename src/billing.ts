import { randomUUID } from 'node:crypto';

import { Decimal } from 'decimal.js';
import type { RowDataPacket } from 'mysql2/promise';

import type { Database, DatabaseExecutor } from './db.js';
import { AppError } from './errors.js';
import type { Actor } from './types.js';

export interface BaselineItemInput {
  BillingItemId: string;
  Unit: string;
  Usage: number | string;
  ModelId?: string;
}

export interface BaselinePrecheckInput {
  RequestId: string;
  UserId: string;
  Items: BaselineItemInput[];
}

export interface BaselineCallbackInput extends BaselinePrecheckInput {
  Status: 'SUCCEEDED' | 'FAILED' | 'CANCELLED';
}

interface PriceRow extends RowDataPacket {
  billing_item_id: string;
  unit: string;
  customer_unit_price: string;
  cost_unit_price: string;
}

interface AdminPriceRow extends RowDataPacket {
  app_id: string;
  billing_item_id: string;
  unit: string;
  customer_unit_price: string;
  cost_unit_price: string;
  enabled: number;
  updated_at: Date;
}

interface BillingUserRow extends RowDataPacket {
  user_id: string;
  login_name: string;
  account_id: string;
  connection_app_id: string;
  status: string;
  config_group_id: string | null;
  profile_sync_version: number | null;
  monthly_limit: string | null;
  group_status: string | null;
  current_version: number | null;
  group_monthly_limit: string | null;
}

interface TaskRow extends RowDataPacket {
  task_id: string;
  connection_id: string;
  app_id: string;
  user_id: string;
  request_id: string;
  config_group_id: string;
  config_group_version: number;
  billing_period: string;
  status: string;
  estimated_amount: string;
  login_name?: string;
}

interface TaskItemRow extends RowDataPacket {
  billing_item_id: string;
  unit: string;
  customer_unit_price: string;
  cost_unit_price: string;
}

interface UsageRow extends RowDataPacket {
  subject_type: string;
  subject_id: string;
  reserved_amount: string;
  actual_amount: string;
}

interface PriceSnapshot {
  billingItemId: string;
  unit: string;
  estimatedUsage: Decimal;
  customerUnitPrice: Decimal;
  costUnitPrice: Decimal;
  estimatedAmount: Decimal;
  estimatedCost: Decimal;
}

function amount(value: Decimal): string {
  return value.toDecimalPlaces(6, Decimal.ROUND_HALF_UP).toFixed(6);
}

function usage(value: number | string): Decimal {
  const parsed = new Decimal(value);
  if (!parsed.isFinite() || parsed.lte(0)) {
    throw new AppError('Usage 必须大于 0', 400, 'INVALID_USAGE');
  }
  return parsed;
}

function billingPeriod(now = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(now);
  const year = parts.find(part => part.type === 'year')?.value;
  const month = parts.find(part => part.type === 'month')?.value;
  if (!year || !month) throw new Error('无法生成账期');
  return `${year}-${month}`;
}

async function resolvePrice(
  tx: DatabaseExecutor,
  appId: string,
  accountId: string,
  item: BaselineItemInput,
): Promise<PriceSnapshot> {
  const rows = await tx.query<PriceRow>(
    `SELECT billing_item_id, unit, customer_unit_price, cost_unit_price
       FROM operator_prices
      WHERE app_id IN (?, ?, '*')
        AND billing_item_id = ?
        AND unit = ?
        AND enabled = TRUE
      ORDER BY CASE WHEN app_id = ? THEN 0 WHEN app_id = ? THEN 1 ELSE 2 END
      LIMIT 1`,
    [appId, accountId, item.BillingItemId, item.Unit, appId, accountId],
  );
  const row = rows[0];
  if (!row) {
    throw new AppError(`未配置计费项: ${item.BillingItemId}/${item.Unit}`, 400, 'PRICE_NOT_FOUND');
  }
  const estimatedUsage = usage(item.Usage);
  const customerUnitPrice = new Decimal(row.customer_unit_price);
  const costUnitPrice = new Decimal(row.cost_unit_price);
  return {
    billingItemId: row.billing_item_id,
    unit: row.unit,
    estimatedUsage,
    customerUnitPrice,
    costUnitPrice,
    estimatedAmount: customerUnitPrice.mul(estimatedUsage),
    estimatedCost: costUnitPrice.mul(estimatedUsage),
  };
}

async function lockUsage(
  tx: DatabaseExecutor,
  appId: string,
  groupId: string,
  userId: string,
  period: string,
): Promise<Map<string, UsageRow>> {
  const subjects = [
    { type: 'CONFIG_GROUP', id: groupId },
    { type: 'USER', id: userId },
  ];
  for (const subject of subjects) {
    await tx.execute(
      `INSERT IGNORE INTO period_usage
        (app_id, subject_type, subject_id, billing_period, reserved_amount, actual_amount)
       VALUES (?, ?, ?, ?, 0, 0)`,
      [appId, subject.type, subject.id, period],
    );
  }
  const rows = await tx.query<UsageRow>(
    `SELECT subject_type, subject_id, reserved_amount, actual_amount
       FROM period_usage
      WHERE app_id = ? AND billing_period = ?
        AND ((subject_type = 'CONFIG_GROUP' AND subject_id = ?)
          OR (subject_type = 'USER' AND subject_id = ?))
      ORDER BY subject_type, subject_id
      FOR UPDATE`,
    [appId, period, groupId, userId],
  );
  return new Map(rows.map(row => [`${row.subject_type}:${row.subject_id}`, row]));
}

function assertWithinLimit(
  row: UsageRow | undefined,
  estimate: Decimal,
  limit: string | null,
  label: string,
): void {
  if (!limit || !row) return;
  const occupied = new Decimal(row.actual_amount).plus(row.reserved_amount).plus(estimate);
  if (occupied.gt(limit)) {
    throw new AppError(`${label}月度额度不足`, 402, 'MONTHLY_LIMIT_EXCEEDED');
  }
}

export class BillingService {
  constructor(private readonly database: Database) {}

  async upsertPrice(input: {
    appId: string;
    billingItemId: string;
    unit: string;
    customerUnitPrice: string;
    costUnitPrice: string;
    actor: Actor;
  }): Promise<void> {
    new Decimal(input.customerUnitPrice);
    new Decimal(input.costUnitPrice);
    await this.database.execute(
      `INSERT INTO operator_prices
        (price_id, app_id, billing_item_id, unit, customer_unit_price, cost_unit_price, enabled, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, TRUE, ?)
       ON DUPLICATE KEY UPDATE
         customer_unit_price = VALUES(customer_unit_price),
         cost_unit_price = VALUES(cost_unit_price),
         enabled = TRUE,
         updated_by = VALUES(updated_by)`,
      [
        `price_${randomUUID().replaceAll('-', '')}`,
        input.appId,
        input.billingItemId,
        input.unit,
        input.customerUnitPrice,
        input.costUnitPrice,
        input.actor.userId,
      ],
    );
  }

  async listPrices(appId: string): Promise<unknown[]> {
    const rows = await this.database.query<AdminPriceRow>(
      `SELECT app_id, billing_item_id, unit, customer_unit_price, cost_unit_price,
              enabled, updated_at
         FROM operator_prices
        WHERE app_id IN (?, '*')
        ORDER BY billing_item_id, unit, CASE WHEN app_id = ? THEN 0 ELSE 1 END`,
      [appId, appId],
    );
    return rows.map(row => ({
      appId: row.app_id,
      billingItemId: row.billing_item_id,
      unit: row.unit,
      customerUnitPrice: row.customer_unit_price,
      costUnitPrice: row.cost_unit_price,
      enabled: Boolean(row.enabled),
      updatedAt: row.updated_at,
    }));
  }

  async disablePrice(input: {
    appId: string;
    billingItemId: string;
    unit: string;
  }): Promise<void> {
    const result = await this.database.execute(
      `UPDATE operator_prices SET enabled = FALSE
        WHERE app_id = ? AND billing_item_id = ? AND unit = ?`,
      [input.appId, input.billingItemId, input.unit],
    );
    if (result.affectedRows !== 1) {
      throw new AppError('价格配置不存在', 404, 'PRICE_NOT_FOUND');
    }
  }

  async precheck(
    connectionId: string,
    appId: string,
    input: BaselinePrecheckInput,
  ): Promise<void> {
    const uniqueItems = new Set(input.Items.map(item => item.BillingItemId));
    if (uniqueItems.size !== input.Items.length) {
      throw new AppError('BillingItemId 不能重复', 400, 'DUPLICATE_BILLING_ITEM');
    }

    await this.database.transaction(async tx => {
      const existing = await tx.query<TaskRow>(
        `SELECT t.*, u.login_name
           FROM studio_tasks t
           JOIN users u ON u.user_id = t.user_id
          WHERE t.connection_id = ? AND t.app_id = ? AND t.request_id = ?
          FOR UPDATE`,
        [connectionId, appId, input.RequestId],
      );
      if (existing[0]) {
        if (existing[0].login_name === input.UserId) return;
        throw new AppError('RequestId 已被其他用户使用', 409, 'REQUEST_ID_CONFLICT');
      }

      const users = await tx.query<BillingUserRow>(
        `SELECT u.user_id, u.login_name, u.account_id, u.status, u.config_group_id,
                u.profile_sync_version, u.monthly_limit, g.status AS group_status,
                g.current_version, g.monthly_limit AS group_monthly_limit,
                r.app_id AS connection_app_id
           FROM users u
           LEFT JOIN config_groups g ON g.config_group_id = u.config_group_id
           LEFT JOIN studio_registrations r ON r.connection_id = g.connection_id
          WHERE r.connection_id = ? AND r.app_id = ? AND u.login_name = ?
          FOR UPDATE`,
        [connectionId, appId, input.UserId],
      );
      const user = users[0];
      if (!user || user.status !== 'ACTIVE') {
        throw new AppError('计费用户不存在或已停用', 403, 'BILLING_USER_DISABLED');
      }

      if (!user.config_group_id || !['AVAILABLE', 'PARTIAL_FAILED'].includes(user.group_status ?? '')
        || Number(user.profile_sync_version) !== Number(user.current_version)) {
        throw new AppError('用户资源配置未就绪', 409, 'PROFILE_NOT_SYNCED');
      }

      const snapshots: PriceSnapshot[] = [];
      for (const item of input.Items) {
        snapshots.push(await resolvePrice(tx, appId, user.account_id, item));
      }
      const estimatedAmount = Decimal.sum(...snapshots.map(item => item.estimatedAmount));
      const estimatedCost = Decimal.sum(...snapshots.map(item => item.estimatedCost));
      const period = billingPeriod();
      const usageRows = await lockUsage(tx, appId, user.config_group_id, user.user_id, period);
      assertWithinLimit(
        usageRows.get(`CONFIG_GROUP:${user.config_group_id}`),
        estimatedAmount,
        user.group_monthly_limit,
        '配置组',
      );
      assertWithinLimit(
        usageRows.get(`USER:${user.user_id}`),
        estimatedAmount,
        user.monthly_limit,
        '子账号',
      );

      const taskId = `task_${randomUUID().replaceAll('-', '')}`;
      await tx.execute(
        `INSERT INTO studio_tasks
          (task_id, connection_id, app_id, user_id, request_id, config_group_id,
           config_group_version, billing_period, status, estimated_amount, estimated_cost)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'RUNNING', ?, ?)`,
        [
          taskId,
          connectionId,
          appId,
          user.user_id,
          input.RequestId,
          user.config_group_id,
          user.current_version,
          period,
          amount(estimatedAmount),
          amount(estimatedCost),
        ],
      );
      for (const item of snapshots) {
        await tx.execute(
          `INSERT INTO studio_task_items
            (task_id, billing_item_id, unit, estimated_usage, customer_unit_price, cost_unit_price)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [
            taskId,
            item.billingItemId,
            item.unit,
            amount(item.estimatedUsage),
            item.customerUnitPrice.toFixed(8),
            item.costUnitPrice.toFixed(8),
          ],
        );
      }
      await tx.execute(
        `UPDATE period_usage
            SET reserved_amount = reserved_amount + ?
          WHERE app_id = ? AND billing_period = ?
            AND ((subject_type = 'CONFIG_GROUP' AND subject_id = ?)
              OR (subject_type = 'USER' AND subject_id = ?))`,
        [amount(estimatedAmount), appId, period, user.config_group_id, user.user_id],
      );
    });
  }

  async callback(
    connectionId: string,
    appId: string,
    input: BaselineCallbackInput,
  ): Promise<void> {
    await this.database.transaction(async tx => {
      const tasks = await tx.query<TaskRow>(
        `SELECT t.*, u.login_name
           FROM studio_tasks t
           JOIN users u ON u.user_id = t.user_id
          WHERE t.connection_id = ? AND t.app_id = ? AND t.request_id = ?
          FOR UPDATE`,
        [connectionId, appId, input.RequestId],
      );
      const task = tasks[0];
      if (!task) throw new AppError('计费任务不存在', 404, 'TASK_NOT_FOUND');
      if (task.login_name !== input.UserId) {
        throw new AppError('UserId 与原任务不匹配', 409, 'TASK_ACTOR_MISMATCH');
      }
      if (task.status !== 'RUNNING') return;

      const storedItems = await tx.query<TaskItemRow>(
        'SELECT * FROM studio_task_items WHERE task_id = ? FOR UPDATE',
        [task.task_id],
      );
      const callbackItems = new Map(input.Items.map(item => [item.BillingItemId, item]));
      let actualAmount = new Decimal(0);
      let actualCost = new Decimal(0);
      if (input.Status === 'SUCCEEDED') {
        for (const stored of storedItems) {
          const actual = callbackItems.get(stored.billing_item_id);
          if (!actual) {
            throw new AppError(`回调缺少计费项: ${stored.billing_item_id}`, 400, 'CALLBACK_ITEM_MISSING');
          }
          if (actual.Unit !== stored.unit) {
            throw new AppError(`计费单位不匹配: ${stored.billing_item_id}`, 400, 'BILLING_UNIT_MISMATCH');
          }
          const actualUsage = usage(actual.Usage);
          actualAmount = actualAmount.plus(new Decimal(stored.customer_unit_price).mul(actualUsage));
          actualCost = actualCost.plus(new Decimal(stored.cost_unit_price).mul(actualUsage));
          await tx.execute(
            `UPDATE studio_task_items
                SET actual_usage = ?, status = 'SUCCEEDED'
              WHERE task_id = ? AND billing_item_id = ?`,
            [amount(actualUsage), task.task_id, stored.billing_item_id],
          );
        }
      } else {
        await tx.execute(
          'UPDATE studio_task_items SET actual_usage = 0, status = ? WHERE task_id = ?',
          [input.Status, task.task_id],
        );
      }

      await lockUsage(tx, appId, task.config_group_id, task.user_id, task.billing_period);
      await tx.execute(
        `UPDATE period_usage
            SET reserved_amount = GREATEST(reserved_amount - ?, 0),
                actual_amount = actual_amount + ?
          WHERE app_id = ? AND billing_period = ?
            AND ((subject_type = 'CONFIG_GROUP' AND subject_id = ?)
              OR (subject_type = 'USER' AND subject_id = ?))`,
        [
          task.estimated_amount,
          amount(actualAmount),
          appId,
          task.billing_period,
          task.config_group_id,
          task.user_id,
        ],
      );
      await tx.execute(
        `UPDATE studio_tasks
            SET status = ?, actual_amount = ?, actual_cost = ?, finished_at = UTC_TIMESTAMP(3)
          WHERE task_id = ?`,
        [input.Status, amount(actualAmount), amount(actualCost), task.task_id],
      );
    });
  }

  async billSummary(
    accountId: string,
    period: string,
    dimension: 'overall' | 'configGroup' | 'subaccount' = 'overall',
  ): Promise<unknown> {
    const dimensionSelect = dimension === 'configGroup'
      ? 't.config_group_id AS subject_id, g.name AS subject_name,'
      : dimension === 'subaccount'
        ? 't.user_id AS subject_id, u.display_name AS subject_name,'
        : '';
    const dimensionJoin = dimension === 'configGroup'
      ? 'LEFT JOIN config_groups g ON g.config_group_id = t.config_group_id'
      : dimension === 'subaccount'
        ? 'LEFT JOIN users u ON u.user_id = t.user_id'
        : '';
    const dimensionGroup = dimension === 'configGroup'
      ? 't.config_group_id, g.name, t.status'
      : dimension === 'subaccount'
        ? 't.user_id, u.display_name, t.status'
        : 't.status';
    const rows = await this.database.query<{
      status: string;
      task_count: number;
      customer_amount: string;
      cost_amount: string;
    } & RowDataPacket>(
      `SELECT ${dimensionSelect} t.status, COUNT(*) AS task_count,
              COALESCE(SUM(actual_amount), 0) AS customer_amount,
              COALESCE(SUM(actual_cost), 0) AS cost_amount
         FROM studio_tasks t
         JOIN studio_registrations r ON r.connection_id = t.connection_id
         ${dimensionJoin}
        WHERE r.account_id = ? AND t.billing_period = ?
        GROUP BY ${dimensionGroup} ORDER BY ${dimensionGroup}`,
      [accountId, period],
    );
    return { accountId, billingPeriod: period, dimension, items: rows };
  }
}
