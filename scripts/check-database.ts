import { loadConfig } from '../src/config.js';
import { checkDatabase, createDatabase } from '../src/db.js';

const database = createDatabase(loadConfig());
try {
  await checkDatabase(database);
  console.log('MySQL startup check passed');
} finally {
  await database.close();
}

