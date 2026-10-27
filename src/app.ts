import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import { env } from './config/env';
import { errorHandler, notFound } from './middleware/errorHandler';
import { router } from './routes';

export function createApp() {
  const app = express();

  // Nested query params, e.g. ?filter[sentiment]=Positive,Neutral
  app.set('query parser', 'extended');

  app.use(helmet());
  app.use(cors({ origin: env.CORS_ORIGIN === '*' ? true : env.CORS_ORIGIN.split(',') }));
  app.use(express.json({ limit: '1mb' }));

  app.use('/api/v1', router);

  app.use(notFound);
  app.use(errorHandler);

  return app;
}
