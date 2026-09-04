import { describe, expect, it } from 'vitest';

import { tokenUsageSummary } from '../src/model-usage.js';

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
