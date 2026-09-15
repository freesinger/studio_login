import 'dotenv/config';

import { createHash } from 'node:crypto';

import { z } from 'zod';

import { DEFAULT_PRICES, deploymentTimeZone, type DefaultPrices } from './deployment.js';
import { translate } from './i18n.js';

const envSchema = z.object({
  STUDIO_LOGIN_CURRENCY: z.enum(['CNY', 'USD']).default('CNY'),
  APP_ENV: z.enum(['local', 'test', 'production']).default('local'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3100),
  STUDIO_LOGIN_LOG_LEVEL: z.enum([
    'fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent',
  ]).default('info'),
  STUDIO_LOGIN_DATABASE_URL: z.string().url().refine(
    value => value.startsWith('mysql://') || value.startsWith('mysql2://'),
    translate('startup.databaseProtocol', 'zh-CN'),
  ),
  STUDIO_LOGIN_DB_CONNECTION_LIMIT: z.coerce.number().int().min(1).max(100).default(10),
  STUDIO_LOGIN_ACCOUNT_ID: z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/),
  STUDIO_LOGIN_ACCOUNT_NAME: z.string().min(1).max(128).default('Studio'),
  STUDIO_LOGIN_ADMIN_USERNAME: z.string().min(3).max(128),
  STUDIO_LOGIN_ADMIN_PASSWORD: z.string().min(12).max(128),
  STUDIO_LOGIN_ADMIN_DISPLAY_NAME: z.string().min(1).max(128).default('Administrator'),
  LAS_STUDIO_BASE_URL: z.string().url().optional(),
  STUDIO_LOGIN_PUBLIC_BASE_URL: z.string().url().optional(),
  LAS_STUDIO_INTEGRATION_TOKEN: z.string().min(32).max(512),
  STUDIO_LOGIN_RECONCILE_INTERVAL_SECONDS: z.coerce.number().int().min(10).max(3600).default(300),
  STUDIO_LOGIN_RECONCILE_OLDER_THAN_MINUTES: z.coerce.number().int().min(0).max(1440).default(10),
  STUDIO_LOGIN_RECONCILE_BATCH_SIZE: z.coerce.number().int().min(1).max(100).default(20),
  STUDIO_LOGIN_RUNNING_STALE_MINUTES: z.coerce.number().int().min(1).max(10080).default(30),
  STUDIO_LOGIN_RECONCILE_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(3),
  STUDIO_LOGIN_RECONCILE_BACKOFF_BASE_SECONDS: z.coerce.number().int().min(10).max(86400).default(300),
});

export type AppConfig = z.infer<typeof envSchema> & {
  timeZone: string;
  defaultPrices: DefaultPrices;
  encryptionKey: Buffer;
  STUDIO_LOGIN_SESSION_TTL_SECONDS: number;
  STUDIO_LOGIN_TICKET_TTL_SECONDS: number;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.parse(env);
  const timeZone = deploymentTimeZone(env.TZ ?? '');
  if (Boolean(parsed.LAS_STUDIO_BASE_URL) !== Boolean(parsed.STUDIO_LOGIN_PUBLIC_BASE_URL)) {
    throw new Error(translate('startup.baseUrlsPaired', 'zh-CN'));
  }
  if (parsed.APP_ENV === 'production'
      && parsed.STUDIO_LOGIN_PUBLIC_BASE_URL
      && new URL(parsed.STUDIO_LOGIN_PUBLIC_BASE_URL).protocol !== 'https:') {
    throw new Error(translate('startup.loginHttpsRequired', 'zh-CN'));
  }
  if (parsed.APP_ENV === 'production'
      && parsed.LAS_STUDIO_BASE_URL
      && new URL(parsed.LAS_STUDIO_BASE_URL).protocol !== 'https:') {
    throw new Error(translate('startup.studioHttpsRequired', 'zh-CN'));
  }
  const encryptionKey = createHash('sha256')
    .update('studio-login/config-encryption/v1\0', 'utf8')
    .update(parsed.LAS_STUDIO_INTEGRATION_TOKEN, 'utf8')
    .digest();
  return {
    ...parsed,
    encryptionKey,
    timeZone,
    defaultPrices: { ...DEFAULT_PRICES },
    STUDIO_LOGIN_SESSION_TTL_SECONDS: 604_800,
    STUDIO_LOGIN_TICKET_TTL_SECONDS: 120,
  };
}
