import { buildApp } from './app.js';
import { BillingReconciler, startBillingReconcileScheduler } from './billing-reconcile.js';
import { BillingService } from './billing.js';
import { bootstrapApplication } from './bootstrap.js';
import { loadConfig } from './config.js';
import { checkDatabase, createDatabase } from './db.js';
import { createAppLogger } from './logging.js';
import { migrateDatabase } from './migrations.js';
import { StudioAdminClient } from './studio-client.js';
import { StudioConnectionService } from './studio-connections.js';

const config = loadConfig();
const logger = createAppLogger(config);
const database = createDatabase(config);

try {
  await migrateDatabase(config);
  await checkDatabase(database);
  await bootstrapApplication(database, config, logger);
  const app = await buildApp({ config, database, logger });
  const connections = new StudioConnectionService(
    database,
    config,
    new StudioAdminClient(logger),
  );
  const stopReconcile = startBillingReconcileScheduler({
    config,
    reconciler: new BillingReconciler(database, connections, new BillingService(database), logger),
    logger,
  });
  const shutdown = async (): Promise<void> => {
    logger.info({ event: 'application_shutdown_started' }, 'Studio Login shutdown started');
    stopReconcile();
    await app.close();
    await database.close();
    logger.info({ event: 'application_shutdown_completed' }, 'Studio Login shutdown completed');
  };
  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());
  await app.listen({ host: config.HOST, port: config.PORT });
  logger.info({
    event: 'application_ready',
    host: config.HOST,
    port: config.PORT,
  }, 'Studio Login is ready');
} catch (error) {
  logger.error({ err: error, event: 'application_startup_failed' }, 'Studio Login startup failed');
  await database.close();
  process.exitCode = 1;
}
