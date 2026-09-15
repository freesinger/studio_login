import { Decimal } from 'decimal.js';

import { deploymentTimeZone } from './deployment.js';
import { translate } from './i18n.js';

export interface QuotaSnapshot {
  limit: string | null;
  actualAmount: string;
  reservedAmount: string;
  availableAmount: string | null;
}

function normalizedAmount(value: string | number | null | undefined): Decimal {
  const amount = new Decimal(value ?? 0);
  return amount.isFinite() && amount.gte(0) ? amount : new Decimal(0);
}

function formattedAmount(value: Decimal): string {
  return value.toDecimalPlaces(6, Decimal.ROUND_HALF_UP).toFixed(6);
}

export function currentBillingPeriod(now = new Date(), timeZone = deploymentTimeZone()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(now);
  const year = parts.find(part => part.type === 'year')?.value;
  const month = parts.find(part => part.type === 'month')?.value;
  if (!year || !month) throw new Error(translate('billing.periodUnavailable', 'zh-CN'));
  return `${year}-${month}`;
}

export function quotaSnapshot(
  limit: string | null,
  actualAmount: string | number | null | undefined,
  reservedAmount: string | number | null | undefined,
): QuotaSnapshot {
  const actual = normalizedAmount(actualAmount);
  const reserved = normalizedAmount(reservedAmount);
  if (limit === null) {
    return {
      limit: null,
      actualAmount: formattedAmount(actual),
      reservedAmount: formattedAmount(reserved),
      availableAmount: null,
    };
  }
  const normalizedLimit = normalizedAmount(limit);
  return {
    limit: formattedAmount(normalizedLimit),
    actualAmount: formattedAmount(actual),
    reservedAmount: formattedAmount(reserved),
    availableAmount: formattedAmount(Decimal.max(normalizedLimit.minus(actual).minus(reserved), 0)),
  };
}

export function effectiveAvailableAmount(
  userAvailableAmount: string | null,
  groupAvailableAmount: string | null,
): string | null {
  if (userAvailableAmount === null) {
    return groupAvailableAmount === null
      ? null
      : formattedAmount(normalizedAmount(groupAvailableAmount));
  }
  if (groupAvailableAmount === null) return formattedAmount(normalizedAmount(userAvailableAmount));
  return formattedAmount(Decimal.min(userAvailableAmount, groupAvailableAmount));
}
