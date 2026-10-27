import { randomUUID } from 'node:crypto';
import type { RequestHandler } from 'express';

export const requestId: RequestHandler = (req, res, next) => {
  req.requestId = randomUUID();
  res.set('X-Request-Id', req.requestId);
  next();
};

// Responses with personal data; never let a proxy or device cache them.
export const noStore: RequestHandler = (_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  res.set('Pragma', 'no-cache');
  next();
};
