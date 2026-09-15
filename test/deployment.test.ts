import { describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import type { Database } from '../src/db.js';
import { deploymentTimeZone } from '../src/deployment.js';
import { dateRange } from '../src/model-usage.js';
import { currentBillingPeriod } from '../src/quota.js';

const env = {
  APP_ENV: 'test', STUDIO_LOGIN_LOG_LEVEL: 'silent',
  STUDIO_LOGIN_DATABASE_URL: 'mysql://root@127.0.0.1:3307/unused',
  STUDIO_LOGIN_ACCOUNT_ID: 'studio', STUDIO_LOGIN_ADMIN_USERNAME: 'admin',
  STUDIO_LOGIN_ADMIN_PASSWORD: 'test-password-123',
  LAS_STUDIO_INTEGRATION_TOKEN: 'test-integration-token-01234567890123',
};

describe('deployment configuration', () => {
  it('keeps original CNY prices and Shanghai time zone when configuration is omitted', () => {
    const config = loadConfig(env);
    expect(config.STUDIO_LOGIN_CURRENCY).toBe('CNY');
    expect(config.defaultPrices).toEqual({ customerUnitPrice: '1', costUnitPrice: '0.5' });
    expect(config.timeZone).toBe('Asia/Shanghai');
  });

  it.each(['', '   '])('uses Shanghai for an empty TZ (%j)', tz => {
    expect(deploymentTimeZone(tz)).toBe('Asia/Shanghai');
    expect(loadConfig({ ...env, TZ: tz }).timeZone).toBe('Asia/Shanghai');
  });

  it.each(['UTC', 'America/Los_Angeles'])('honors explicit TZ=%s', tz => {
    expect(loadConfig({ ...env, TZ: tz }).timeZone).toBe(tz);
  });

  it.each(['CNY', 'USD'])('uses shared numeric defaults for %s without price overrides', currency => {
    expect(loadConfig({ ...env, STUDIO_LOGIN_CURRENCY: currency }).defaultPrices).toEqual({ customerUnitPrice: '1', costUnitPrice: '0.5' });
  });

  it('rejects unsupported currency and invalid time zones', () => {
    expect(() => loadConfig({ ...env, STUDIO_LOGIN_CURRENCY: 'JPY' })).toThrow();
    expect(() => loadConfig({ ...env, TZ: 'invalid-zone' })).toThrow();
  });

  it.each(['CNY', 'USD'])('exposes only public deployment properties for %s in all UI languages', async currency => {
    const config = loadConfig({ ...env, TZ: 'UTC', STUDIO_LOGIN_CURRENCY: currency,
    });
    const app = await buildApp({ config, database: {} as Database });
    try {
      for (const language of ['en', 'ja', 'zh-CN']) {
        const response = await app.inject({ url: '/api/runtime-config', headers: { 'accept-language': language } });
        expect(response.statusCode).toBe(200);
        expect(response.headers['cache-control']).toBe('no-store');
        expect(response.json()).toEqual({ currency, timeZone: 'UTC', defaultPrices: config.defaultPrices });
      }
    } finally { await app.close(); }
  });
});

describe('deployment calendar boundaries', () => {
  it.each([
    ['Asia/Shanghai', '2026-08-31T16:00:00Z', '2026-09'],
    ['UTC', '2026-08-31T16:00:00Z', '2026-08'],
    ['America/Los_Angeles', '2026-09-01T06:59:59Z', '2026-08'],
    ['America/Los_Angeles', '2026-09-01T07:00:00Z', '2026-09'],
  ])('uses %s at %s', (zone, instant, period) => {
    expect(currentBillingPeriod(new Date(instant), zone)).toBe(period);
  });

  it.each([
    ['Asia/Shanghai', '2026-09-01', '2026-08-31T16:00:00.000Z', '2026-09-01T16:00:00.000Z'],
    ['UTC', '2026-09-01', '2026-09-01T00:00:00.000Z', '2026-09-02T00:00:00.000Z'],
    ['America/Los_Angeles', '2026-03-08', '2026-03-08T08:00:00.000Z', '2026-03-09T07:00:00.000Z'],
    ['America/Los_Angeles', '2026-11-01', '2026-11-01T07:00:00.000Z', '2026-11-02T08:00:00.000Z'],
  ])('selects the full local day in %s on %s', (zone, day, start, end) => {
    expect(dateRange(day, day, zone).map(date => date.toISOString())).toEqual([start, end]);
  });

  it('counts the 90 day maximum by calendar days across DST', () => {
    expect(() => dateRange('2026-08-04', '2026-11-01', 'America/Los_Angeles')).not.toThrow();
    expect(() => dateRange('2026-08-03', '2026-11-01', 'America/Los_Angeles')).toThrow();
  });

  it.each([['2026-02-30', '2026-03-01'], ['2026-09-02', '2026-09-01'], ['bad', '2026-09-01']])('rejects invalid range %s–%s', (start, end) => {
    expect(() => dateRange(start, end, 'UTC')).toThrow();
  });
});
