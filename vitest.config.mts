import { randomBytes } from 'node:crypto';
import { defineConfig } from 'vitest/config';

// Fresh keys for every test run, so no key material is ever stored in the repository.
const testKey = () => randomBytes(32).toString('base64');

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    setupFiles: ['test/setup.ts'],
    restoreMocks: true,
    // The API validates env at import time; tests never reach Supabase (the Supabase client,
    // sign-in and repositories are faked).
    env: {
      NODE_ENV: 'test',
      SUPABASE_URL: 'https://test-project.supabase.co',
      SUPABASE_SERVICE_ROLE_KEY: 'test-service-role-key',
      JWT_ACCESS_SECRET: testKey(),
      DATA_ENCRYPTION_KEY: testKey(),
      BLIND_INDEX_KEY: testKey(),
    },
    // PGlite boots a full Postgres in WASM; give the database suite time to start.
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
