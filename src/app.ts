import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import { env } from './config/env';
import { docsRouter } from './docs/openapi';
import { errorHandler, notFound } from './middleware/errorHandler';
import { requestId } from './middleware/requestContext';
import { router } from './routes';

export function createApp() {
  const app = express();

  app.set('trust proxy', env.TRUST_PROXY);
  // Nested query params, e.g. ?filter[sentiment]=Positive,Neutral
  app.set('query parser', 'extended');
  app.use(requestId);
  app.use(helmet());
  app.use(cors({ origin: env.CORS_ORIGIN === '*' ? true : env.CORS_ORIGIN.split(',') }));
  // No route takes a large JSON body; files go to storage through pre-signed URLs.
  app.use(express.json({ limit: '100kb' }));

  const docsEnabled = env.API_DOCS ? env.API_DOCS === 'true' : env.NODE_ENV !== 'production';
  if (docsEnabled) app.use('/api/docs', docsRouter());
  app.use('/api/v1', router);

  app.use(notFound);
  app.use(errorHandler);

  return app;
}
