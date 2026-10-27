import { randomUUID } from 'node:crypto';
import type { Request, RequestHandler } from 'express';
import { consume, LIMITS } from '../lib/rateLimit';

export const requestId: RequestHandler = (req, res, next) => {
  req.requestId = randomUUID();
  res.set('X-Request-Id', req.requestId);
  next();
};

// Responses carry tokens and personal data; never let a proxy or device cache them.
export const noStore: RequestHandler = (_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  res.set('Pragma', 'no-cache');
  next();
};

export const apiRateLimit: RequestHandler = async (req, _res, next) => {
  await consume(LIMITS.apiPerIp, req.ip ?? null);
  next();
};

export interface ClientContext {
  ip: string | null;
  userAgent: string | null;
  appVersion: string | null;
  requestId: string;
}

function header(req: Request, name: string, max: number): string | null {
  const value = req.get(name)?.trim();
  return value ? value.slice(0, max) : null;
}

export function clientContext(req: Request): ClientContext {
  return {
    ip: req.ip ?? null,
    userAgent: header(req, 'user-agent', 256),
    appVersion: header(req, 'x-app-version', 32),
    requestId: req.requestId,
  };
}
