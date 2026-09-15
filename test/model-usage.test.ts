import { describe, expect, it } from 'vitest';

import { ModelUsageService, tokenUsageSummary } from '../src/model-usage.js';
import type { Database } from '../src/db.js';

describe('token usage summary', () => {
  it('maps OpenAI Responses input, output and cached token fields', () => {
    expect(tokenUsageSummary({
      input_tokens: 43_495,
      input_tokens_details: { cached_tokens: 11_008 },
      output_tokens: 11,
      total_tokens: 43_506,
    })).toMatchObject({
      inputTokens: 43_495,
      outputTokens: 11,
      cachedTokens: 11_008,
      totalTokens: 43_506,
    });
  });

  it('maps Chat Completions prompt and completion fields to the same dimensions', () => {
    expect(tokenUsageSummary(JSON.stringify({
      prompt_tokens: 120,
      prompt_tokens_details: { cached_tokens: 40 },
      completion_tokens: 56,
      total_tokens: 176,
    }))).toMatchObject({
      inputTokens: 120,
      outputTokens: 56,
      cachedTokens: 40,
      totalTokens: 176,
    });
  });

  it('keeps partial image token usage available with missing dimensions omitted', () => {
    expect(tokenUsageSummary({
      output_tokens: 9_216,
      total_tokens: 9_216,
    })).toEqual({
      inputTokens: undefined,
      outputTokens: 9_216,
      totalTokens: 9_216,
      cachedTokens: undefined,
      audioTokens: undefined,
      reasoningTokens: undefined,
    });
  });
});

describe('model usage audit document', () => {
  it('returns task metadata and parsed audit payload', async () => {
    const database = {
      query: async () => [{
        taskId: 'task-1',
        requestId: 'request-1',
        status: 'SUCCEEDED',
        billingAuditPayload: JSON.stringify({
          version: 1,
          settlement: {
            source: 'callback',
            requestBody: { RequestId: 'request-1' },
          },
        }),
      }],
      execute: async () => ({ affectedRows: 0 }),
      transaction: async () => undefined,
      close: async () => undefined,
    } as unknown as Database;

    await expect(new ModelUsageService(database).auditDocument('account-1', 'task-1'))
      .resolves.toMatchObject({
        task: {
          taskId: 'task-1',
          requestId: 'request-1',
          status: 'SUCCEEDED',
        },
        audit: {
          version: 1,
          settlement: {
            source: 'callback',
            requestBody: { RequestId: 'request-1' },
          },
        },
      });
  });

  it('rejects tasks without an audit payload', async () => {
    const database = {
      query: async () => [{
        taskId: 'task-1',
        billingAuditPayload: null,
      }],
      execute: async () => ({ affectedRows: 0 }),
      transaction: async () => undefined,
      close: async () => undefined,
    } as unknown as Database;

    await expect(new ModelUsageService(database).auditDocument('account-1', 'task-1'))
      .rejects.toMatchObject({
        code: 'BILLING_AUDIT_NOT_AVAILABLE',
        statusCode: 404,
      });
  });
});
