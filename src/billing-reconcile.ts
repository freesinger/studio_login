import type { RowDataPacket } from 'mysql2/promise';

import { BillingService, type BaselineCallbackInput } from './billing.js';
import type { AppConfig } from './config.js';
import type { Database } from './db.js';
import { noopLogger, type AppLogger } from './logging.js';
import { StudioConnectionService } from './studio-connections.js';

interface RunningTaskRow extends RowDataPacket {
  task_id: string;
  connection_id: string;
  app_id: string;
  user_id: string;
  login_name: string;
  request_id: string;
}

interface RemoteUsageItem {
  BillingItemId: string;
  Unit: string;
  Usage: number | string;
  ModelId?: string;
}

interface RemoteUsageRequest {
  RequestId: string;
  UserId: string;
  Status: 'PROCESSING' | 'SUCCEEDED' | 'FAILED';
  Items: RemoteUsageItem[];
}

export interface BillingReconcileResult {
  scanned: number;
  settled: number;
  skipped: number;
  failed: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function parseRemoteUsage(payload: unknown, requestId: string): RemoteUsageRequest | null {
  if (!isRecord(payload) || !Array.isArray(payload.Requests)) return null;
  const remote = payload.Requests.find(item => isRecord(item) && readString(item.RequestId) === requestId);
  if (!isRecord(remote)) return null;
  const status = readString(remote.Status);
  if (!['PROCESSING', 'SUCCEEDED', 'FAILED'].includes(status)) {
    throw new Error('Studio 返回了不支持的用量状态');
  }
  const items = Array.isArray(remote.Items) ? remote.Items.map(item => {
    if (!isRecord(item)) throw new Error('Studio 返回了非法的用量明细');
    const billingItemId = readString(item.BillingItemId);
    const unit = readString(item.Unit);
    const usage = item.Usage;
    if (!billingItemId || !unit || (typeof usage !== 'number' && typeof usage !== 'string')) {
      throw new Error('Studio 返回了非法的用量明细');
    }
    const modelId = readString(item.ModelId);
    return {
      BillingItemId: billingItemId,
      Unit: unit,
      Usage: usage,
      ...(modelId ? { ModelId: modelId } : {}),
    };
  }) : [];
  if (status === 'SUCCEEDED' && items.length === 0) {
    throw new Error('Studio 成功用量缺少计费明细');
  }
  return {
    RequestId: requestId,
    UserId: readString(remote.UserId),
    Status: status as RemoteUsageRequest['Status'],
    Items: items,
  };
}

export class BillingReconciler {
  constructor(
    private readonly database: Database,
    private readonly connections: StudioConnectionService,
    private readonly billing: BillingService,
    private readonly logger: AppLogger = noopLogger,
  ) {}

  async reconcile(input: { olderThanMinutes: number; limit: number }): Promise<BillingReconcileResult> {
    const cutoff = new Date(Date.now() - input.olderThanMinutes * 60_000);
    const rows = await this.database.query<RunningTaskRow>(
      `SELECT t.task_id, t.connection_id, t.app_id, t.user_id, u.login_name, t.request_id
         FROM studio_tasks t
         JOIN users u ON u.user_id = t.user_id
        WHERE t.status = 'RUNNING' AND t.created_at <= ?
        ORDER BY t.created_at ASC, t.task_id ASC
        LIMIT ?`,
      [cutoff, input.limit],
    );
    const result: BillingReconcileResult = { scanned: rows.length, settled: 0, skipped: 0, failed: 0 };
    const targets = new Map<string, Awaited<ReturnType<StudioConnectionService['usageQueryTarget']>>>();

    for (const task of rows) {
      try {
        const targetKey = `${task.connection_id}\0${task.request_id}`;
        let target = targets.get(targetKey);
        if (!target) {
          target = await this.connections.usageQueryTarget(
            task.connection_id,
            task.app_id,
            task.user_id,
            task.request_id,
          );
          targets.set(targetKey, target);
        }
        const response = await fetch(`${target.studioBaseUrl}/api/v1/open/usage/get`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-app-id': target.appId,
            'x-las-api-key': target.lasApiKey,
          },
          body: JSON.stringify({ RequestIds: [task.request_id] }),
          signal: AbortSignal.timeout(5_000),
        });
        if (!response.ok) throw new Error(`Studio 用量查询失败: HTTP ${response.status}`);
        const remote = parseRemoteUsage(await response.json(), task.request_id);
        if (!remote || remote.Status === 'PROCESSING') {
          result.skipped += 1;
          this.logger.debug({
            event: 'billing_reconcile_item_skipped',
            appId: task.app_id,
            requestId: task.request_id,
            status: remote?.Status ?? 'NOT_FOUND',
          }, 'Billing reconciliation item is not settled');
          continue;
        }
        if (remote.UserId && remote.UserId !== task.login_name) {
          throw new Error('Studio 用量 UserId 与本地任务不匹配');
        }
        const callback: BaselineCallbackInput = {
          RequestId: task.request_id,
          UserId: task.login_name,
          Status: remote.Status,
          Items: remote.Items,
        };
        await this.billing.callback(task.connection_id, task.app_id, callback);
        result.settled += 1;
        this.logger.info({
          event: 'billing_reconcile_item_settled',
          appId: task.app_id,
          requestId: task.request_id,
          status: remote.Status,
          userId: task.login_name,
        }, 'Billing reconciliation item settled');
      } catch (error) {
        result.failed += 1;
        this.logger.warn({
          err: error,
          event: 'billing_reconcile_item_failed',
          appId: task.app_id,
          requestId: task.request_id,
          userId: task.login_name,
        }, 'Billing reconciliation item failed');
      }
    }
    return result;
  }
}

export function startBillingReconcileScheduler(input: {
  config: AppConfig;
  reconciler: BillingReconciler;
  logger?: AppLogger;
}): () => void {
  const logger = input.logger ?? noopLogger;
  let timer: NodeJS.Timeout | undefined;
  let running = false;
  let stopped = false;
  const schedule = (delay: number): void => {
    if (!stopped) timer = setTimeout(() => void run(), delay);
  };
  const run = async (): Promise<void> => {
    if (running || stopped) return;
    running = true;
    try {
      const result = await input.reconciler.reconcile({
        olderThanMinutes: input.config.STUDIO_LOGIN_RECONCILE_OLDER_THAN_MINUTES,
        limit: input.config.STUDIO_LOGIN_RECONCILE_BATCH_SIZE,
      });
      if (result.scanned > 0) logger.info({
        event: 'billing_reconcile_completed',
        ...result,
      }, 'Billing reconciliation batch completed');
    } catch (error) {
      logger.error({
        err: error,
        event: 'billing_reconcile_failed',
      }, 'Billing reconciliation batch failed');
    } finally {
      running = false;
      schedule(input.config.STUDIO_LOGIN_RECONCILE_INTERVAL_SECONDS * 1_000);
    }
  };
  schedule(Math.min(5_000, input.config.STUDIO_LOGIN_RECONCILE_INTERVAL_SECONDS * 1_000));
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
