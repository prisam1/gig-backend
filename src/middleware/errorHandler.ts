import type { ErrorRequestHandler, RequestHandler } from 'express';
import { env } from '../config/env';

export type FieldErrors = Record<string, string>;

const DEFAULT_CODES: Record<number, string> = {
  400: 'BAD_REQUEST',
  401: 'UNAUTHORIZED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  409: 'CONFLICT',
};

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code: string = DEFAULT_CODES[status] ?? 'INTERNAL_ERROR',
    public readonly fields?: FieldErrors,
  ) {
    super(message);
  }
}

/** 400 with per-field messages the app can show next to each input. */
export function validationError(fields: FieldErrors): HttpError {
  return new HttpError(400, 'Request validation failed', 'VALIDATION_FAILED', fields);
}

export const notFound: RequestHandler = (req, _res, next) => {
  next(new HttpError(404, `Route not found: ${req.method} ${req.originalUrl}`));
};

export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  // Errors raised by Express itself (e.g. malformed JSON) carry their own 4xx status.
  const status = err instanceof HttpError ? err.status : Number(err.status) || 500;
  if (status >= 500) console.error(err);

  const hideDetails = status >= 500 && env.NODE_ENV === 'production';

  res.status(status).json({
    error: {
      code: err instanceof HttpError ? err.code : (DEFAULT_CODES[status] ?? 'INTERNAL_ERROR'),
      message: hideDetails ? 'Internal server error' : err.message,
      ...(err instanceof HttpError && err.fields ? { fields: err.fields } : {}),
    },
  });
};
