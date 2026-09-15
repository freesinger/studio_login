import { describe, expect, it } from 'vitest';

import {
  currentBillingPeriod,
  effectiveAvailableAmount,
  quotaSnapshot,
} from '../src/quota.js';

describe('monthly quota presentation', () => {
  it('uses the Asia/Shanghai calendar month at the UTC boundary', () => {
    expect(currentBillingPeriod(new Date('2026-08-31T16:00:00.000Z'), 'Asia/Shanghai')).toBe('2026-09');
  });

  it('subtracts settled and reserved amounts from a finite limit', () => {
    expect(quotaSnapshot('2000', '300.25', '99.75')).toEqual({
      limit: '2000.000000',
      actualAmount: '300.250000',
      reservedAmount: '99.750000',
      availableAmount: '1600.000000',
    });
  });

  it('keeps an unlimited subject unlimited while preserving usage amounts', () => {
    expect(quotaSnapshot(null, '300', '100')).toEqual({
      limit: null,
      actualAmount: '300.000000',
      reservedAmount: '100.000000',
      availableAmount: null,
    });
  });

  it('uses the tighter remaining amount across user and config group limits', () => {
    expect(effectiveAvailableAmount(null, '1200')).toBe('1200.000000');
    expect(effectiveAvailableAmount('900', null)).toBe('900.000000');
    expect(effectiveAvailableAmount('900', '1200')).toBe('900.000000');
    expect(effectiveAvailableAmount(null, null)).toBeNull();
  });
});
