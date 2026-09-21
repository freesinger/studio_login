import { describe, expect, it } from 'vitest';

import {
  evaluatePriceFormula,
  parseFormulaBillingContext,
  validatePriceFormula,
} from '../src/price-formula.js';
import { AppError } from '../src/errors.js';

const context = {
  total_tokens: 15958,
  prompt_tokens: 15116,
  completion_tokens: 842,
  prompt_tokens_details: {
    cached_tokens: 4920,
    audio_tokens: null,
  },
  completion_tokens_details: {
    reasoning_tokens: 0,
  },
};

describe('price formula', () => {
  it('evaluates formulas from BillingContext root fields without an a. prefix', () => {
    const result = evaluatePriceFormula(
      '(prompt_tokens - prompt_tokens_details.cached_tokens) * 0.002'
        + ' + prompt_tokens_details.cached_tokens * 0.0002'
        + ' + completion_tokens * 0.001',
      context,
    );

    expect(result.toFixed(6)).toBe('22.218000');
  });

  it('accepts the escaped BillingContext shape copied from a JSON response', () => {
    const wrapped = JSON.stringify({
      BillingContext: JSON.stringify(context),
    });

    expect(parseFormulaBillingContext(wrapped)).toEqual(context);
    expect(evaluatePriceFormula('total_tokens * 0.001', wrapped).toFixed(6))
      .toBe('15.958000');
  });

  it.each([
    'process.exit()',
    'constructor.constructor',
    'prompt_tokens ** 2',
    'prompt_tokens["value"]',
    'prompt_tokens = 1',
  ])('rejects unsafe or unsupported syntax: %s', formula => {
    expect(() => validatePriceFormula(formula)).toThrow(AppError);
  });

  it('rejects the legacy a. BillingContext prefix', () => {
    try {
      validatePriceFormula('a.prompt_tokens * 0.001');
      expect.fail('legacy a. prefix should be rejected');
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe('INVALID_PRICE_FORMULA');
    }
  });

  it('reports a missing field rather than silently treating it as zero', () => {
    expect(() => evaluatePriceFormula('output_tokens * 0.001', context))
      .toThrow('BillingContext 缺少公式引用字段 output_tokens');
  });

  it('treats an explicitly null token field as zero', () => {
    expect(evaluatePriceFormula(
      'prompt_tokens_details.audio_tokens * 0.001 + completion_tokens * 0.002',
      context,
    ).toFixed(6)).toBe('1.684000');
  });

  it('still rejects a present non-numeric field', () => {
    expect(() => evaluatePriceFormula(
      'prompt_tokens_details.cached_tokens * 0.001',
      {
        ...context,
        prompt_tokens_details: { cached_tokens: 'not-a-number' },
      },
    )).toThrow('公式引用字段 prompt_tokens_details.cached_tokens 必须是数字');
  });

  it('rejects negative results and division by zero', () => {
    expect(() => evaluatePriceFormula('completion_tokens - prompt_tokens', context))
      .toThrow('计价结果必须是有效的非负金额');
    expect(() => evaluatePriceFormula('total_tokens / 0', context))
      .toThrow('计价公式不能除以 0');
  });
});
