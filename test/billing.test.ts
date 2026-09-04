import { describe, expect, it, vi } from 'vitest';

import { BillingService, type BaselineCallbackInput } from '../src/billing.js';
import type { Database, DatabaseExecutor } from '../src/db.js';
import { AppError } from '../src/errors.js';
import type { AppLogger } from '../src/logging.js';

function databaseWithoutTasks(): Database {
  const executor: DatabaseExecutor = {
    query: async <T>() => [] as T[],
    execute: async () => ({ affectedRows: 0 }) as never,
  };
  return {
    ...executor,
    transaction: async work => work(executor),
    close: async () => undefined,
  };
}

function callback(status: BaselineCallbackInput['Status']): BaselineCallbackInput {
  return {
    RequestId: 'request-without-precheck',
    UserId: 'worker',
    Status: status,
    Items: [{
      BillingItemId: 'las_llm_seed-2.0-lite',
      Unit: 'request',
      Usage: 0,
    }],
  };
}

describe('BillingService callback', () => {
  it.each(['FAILED', 'CANCELLED'] as const)(
    'treats a missing task as idempotent for %s callbacks',
    async status => {
      const logger = {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      } satisfies AppLogger;
      const service = new BillingService(databaseWithoutTasks(), logger);

      await expect(service.callback(
        'connection-1',
        'app-1',
        callback(status),
      )).resolves.toBeUndefined();

      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'billing_actual_callback_ignored_without_precheck',
          requestId: 'request-without-precheck',
          status,
        }),
        expect.any(String),
      );
    },
  );

  it('still rejects a successful callback when precheck did not create a task', async () => {
    const service = new BillingService(databaseWithoutTasks());

    await expect(service.callback(
      'connection-1',
      'app-1',
      callback('SUCCEEDED'),
    )).rejects.toMatchObject({
      code: 'TASK_NOT_FOUND',
      statusCode: 404,
    } satisfies Partial<AppError>);
  });
});
