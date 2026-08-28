import { loadConfig } from '../src/config.js';
import { migrateDatabase } from '../src/migrations.js';

await migrateDatabase(loadConfig());
console.log('MySQL migrations are up to date');
