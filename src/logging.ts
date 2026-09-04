import pino, { type Logger } from 'pino';

import type { AppConfig } from './config.js';

export type AppLogger = Pick<Logger, 'debug' | 'info' | 'warn' | 'error'>;

export const noopLogger: AppLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

export function createAppLogger(config: AppConfig): Logger {
  return pino({
    level: config.APP_ENV === 'test' ? 'silent' : config.STUDIO_LOGIN_LOG_LEVEL,
    base: {
      service: 'studio-login',
      environment: config.APP_ENV,
      instanceId: process.env.HOSTNAME ?? 'local',
    },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        'req.headers.x-las-api-key',
        'req.headers.x-las-integration-token',
        'res.headers.set-cookie',
        'body.password',
        'body.csv',
        'body.integrationToken',
        'body.resourceConfig',
      ],
      censor: '[REDACTED]',
    },
  });
}
