import { AuthService } from './auth.js';
import type { AppConfig } from './config.js';
import type { Database } from './db.js';
import { noopLogger, type AppLogger } from './logging.js';
import { StudioAdminClient } from './studio-client.js';
import { StudioConnectionService } from './studio-connections.js';

export async function bootstrapApplication(
  database: Database,
  config: AppConfig,
  logger: AppLogger = noopLogger,
): Promise<void> {
  const actor = await new AuthService(database, config).bootstrapConfiguredAdmin();
  logger.info({
    event: 'bootstrap_admin_ready',
    accountId: config.STUDIO_LOGIN_ACCOUNT_ID,
    role: actor.role,
  }, 'Configured administrator is ready');
  if (!config.LAS_STUDIO_BASE_URL || !config.STUDIO_LOGIN_PUBLIC_BASE_URL) {
    logger.warn({
      event: 'bootstrap_studio_registration_skipped',
      accountId: config.STUDIO_LOGIN_ACCOUNT_ID,
    }, 'Studio automatic registration is not configured');
    return;
  }
  const studioConnections = new StudioConnectionService(
    database,
    config,
    new StudioAdminClient(logger),
  );
  logger.info({
    event: 'bootstrap_studio_registration_started',
    accountId: config.STUDIO_LOGIN_ACCOUNT_ID,
  }, 'Studio automatic registration started');
  await studioConnections.save({
    accountId: config.STUDIO_LOGIN_ACCOUNT_ID,
    studioBaseUrl: config.LAS_STUDIO_BASE_URL,
    callbackBaseUrl: config.STUDIO_LOGIN_PUBLIC_BASE_URL,
    actor,
  });
  const registration = await studioConnections.register(config.STUDIO_LOGIN_ACCOUNT_ID, actor);
  logger.info({
    event: 'bootstrap_studio_registration_completed',
    accountId: config.STUDIO_LOGIN_ACCOUNT_ID,
    idempotent: registration.idempotent,
    status: registration.status,
  }, 'Studio automatic registration completed');
}
