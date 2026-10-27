import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    setupFiles: ['test/setup.ts'],
    restoreMocks: true,
    // The API validates env at import time; tests never reach Supabase or Postgres (the Supabase
    // client, sign-in and repositories are faked, and the postgres.js client connects lazily).
    env: {
      NODE_ENV: 'test',
      SUPABASE_URL: 'https://test-project.supabase.co',
      SUPABASE_SERVICE_ROLE_KEY: 'test-service-role-key',
      DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
      JWT_ACCESS_SECRET: 'YWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWE=',
      DATA_ENCRYPTION_KEY: 'YmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmI=',
      BLIND_INDEX_KEY: 'Y2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2M=',
    },
    // PGlite boots a full Postgres in WASM; give the database suite time to start.
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
