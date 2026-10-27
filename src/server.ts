import { createApp } from './app';
import { env } from './config/env';

const server = createApp().listen(env.PORT, () => {
  console.log(`GIG backend listening on http://localhost:${env.PORT} (${env.NODE_ENV})`);
});

function shutdown(signal: string) {
  console.log(`${signal} received, shutting down`);
  server.close(() => process.exit(0));
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
