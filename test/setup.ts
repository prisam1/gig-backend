// The HTTP tests run without Postgres. Rate limits and the audit log write to the database, so
// they are stubbed here; everything else that needs data is stubbed per test.
import { vi } from 'vitest';

vi.mock('../src/lib/rateLimit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/rateLimit')>()),
  consume: () => Promise.resolve(),
}));

vi.mock('../src/lib/audit', () => ({ audit: () => Promise.resolve() }));
