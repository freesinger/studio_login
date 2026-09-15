import { describe, expect, it, vi } from 'vitest';

import { baselineProjectId, BillingService, type BaselineCallbackInput } from '../src/billing.js';
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

describe('baselineProjectId', () => {
  it('prefers BillingContext extensions project id over the legacy top-level field', () => {
    expect(baselineProjectId({
      ProjectId: 'top-level-project',
      Items: [{
        BillingItemId: 'las_llm_seed-2.0-lite',
        Unit: 'request',
        Usage: 1,
        BillingContext: JSON.stringify({
          extensions: {
            project_id: 'extension-project',
          },
        }),
      }],
    })).toBe('extension-project');
  });

  it('keeps legacy top-level ProjectId as a fallback', () => {
    expect(baselineProjectId({
      ProjectId: 'top-level-project',
      Items: [{
        BillingItemId: 'las_llm_seed-2.0-lite',
        Unit: 'request',
        Usage: 1,
      }],
    })).toBe('top-level-project');
  });

  it('rejects inconsistent project ids across item BillingContext extensions', () => {
    expect(() => baselineProjectId({
      Items: [
        {
          BillingItemId: 'las_llm_seed-2.0-lite',
          Unit: 'request',
          Usage: 1,
          BillingContext: '{"extensions":{"project_id":"project-a"}}',
        },
        {
          BillingItemId: 'las_llm_seed-2.0-pro',
          Unit: 'request',
          Usage: 1,
          BillingContext: '{"extensions":{"project_id":"project-b"}}',
        },
      ],
    })).toThrow('BillingContext.extensions.project_id 不一致');
  });
});
