import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globalSetup: ['tests/globalSetup.ts'],
    // Integration tests share one database, so run test files one after another.
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 180_000,
    env: { NODE_ENV: 'test' },
    coverage: { provider: 'v8', include: ['src/**/*.ts'], exclude: ['src/server.ts', 'src/db/seed.ts', 'src/db/migrate-cli.ts'] },
  },
});
