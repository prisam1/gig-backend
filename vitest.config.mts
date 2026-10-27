import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // The API validates env at import time; tests never reach Supabase (the client is faked).
    env: {
      NODE_ENV: 'test',
      SUPABASE_URL: 'https://test-project.supabase.co',
      SUPABASE_ANON_KEY: 'test-anon-key',
      SUPABASE_SERVICE_ROLE_KEY: 'test-service-role-key',
    },
    // PGlite boots a full Postgres in WASM; give the database suite time to start.
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
