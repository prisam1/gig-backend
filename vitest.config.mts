import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    restoreMocks: true,
    // Placeholder values: tests stub the repositories or fake the Supabase client, so nothing
    // reaches Supabase.
    env: {
      NODE_ENV: 'test',
      SUPABASE_URL: 'https://test-project.supabase.co',
      SUPABASE_SERVICE_ROLE_KEY: 'test-service-role-key',
    },
    // PGlite boots a full Postgres in WASM; give the database suite time to start.
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
