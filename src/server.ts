import { createApp } from './app';
import { env } from './config/env';
import { callDb } from './lib/db';

const server = createApp().listen(env.PORT, () => {
  console.log(`GIG backend listening on http://localhost:${env.PORT} (${env.NODE_ENV})`);
});

// Clears expired OTPs, sign-ups, reset tokens, sessions and rate-limit rows.
const purge = setInterval(
  () => {
    callDb('app_purge_expired', {}).catch((err: unknown) => {
      console.error('[purge] failed', err);
    });
  },
  15 * 60 * 1000,
);
purge.unref();

function shutdown(signal: string) {
  console.log(`${signal} received, shutting down`);
  clearInterval(purge);
  server.close(() => process.exit(0));
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
