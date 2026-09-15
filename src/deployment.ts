export const DEFAULT_PRICES = {
  customerUnitPrice: '1',
  costUnitPrice: '0.5',
} as const;

export interface DefaultPrices {
  customerUnitPrice: string;
  costUnitPrice: string;
}

export function deploymentTimeZone(tz = process.env.TZ): string {
  const timeZone = tz?.trim() || 'Asia/Shanghai';
  // Validate explicitly: an invalid TZ must not silently fall back to UTC.
  return new Intl.DateTimeFormat('en', { timeZone }).resolvedOptions().timeZone;
}
