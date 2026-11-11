import { loadConfig } from '../config.js';
import { seedDemo } from './demo.js';
import { migrate } from './migrate.js';
import { createPool } from './pool.js';

/** `npm run seed`: demo accounts (password ReviewDesk2024) and a demo project. */
const config = loadConfig();
const pool = createPool(config.DATABASE_URL);
try {
  await migrate(pool);
  await seedDemo(pool, config.BCRYPT_ROUNDS);
  console.log('Seeded. Sign in as admin@reviewdesk.dev / rita@reviewdesk.dev / ravi@reviewdesk.dev, password: ReviewDesk2024');
} finally {
  await pool.end();
}
