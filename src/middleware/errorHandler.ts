import type { ErrorRequestHandler, RequestHandler } from 'express';
import { z } from 'zod';
import { env } from '../config/env';

export type ErrorCode =
  | 'VALIDATION_FAILED'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'KYC_REQUIRED'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'IDEMPOTENCY_CONFLICT'
  | 'INTERNAL';

const defaultCodes: Record<number, ErrorCode> = {
  400: 'VALIDATION_FAILED',
  401: 'UNAUTHENTICATED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  409: 'CONFLICT',
};

export class HttpError extends Error {
  public readonly code: ErrorCode;

  constructor(
    public readonly status: number,
    message: string,
    options: { code?: ErrorCode; fields?: Record<string, string> } = {},
  ) {
    super(message);
    this.code = options.code ?? defaultCodes[status] ?? 'INTERNAL';
    this.fields = options.fields;
  }

  public readonly fields: Record<string, string> | undefined;
}

/** Flattens a zod error into `{ "metrics.transparency": "message" }`, first message per field. */
export function zodFields(error: z.ZodError): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.length > 0 ? issue.path.join('.') : '_';
    fields[key] ??= issue.message;
  }
  return fields;
}

/** Throws a 400 VALIDATION_FAILED when business-rule checks produced any field errors. */
export function assertNoFieldErrors(fields: Record<string, string>): void {
  if (Object.keys(fields).length > 0) {
    throw new HttpError(400, 'Validation failed', { fields });
  }
}

export const notFound: RequestHandler = (req, _res, next) => {
  next(new HttpError(404, `Route not found: ${req.method} ${req.originalUrl}`));
};

export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof z.ZodError) {
    res.status(400).json({
      error: { code: 'VALIDATION_FAILED', message: 'Validation failed', fields: zodFields(err) },
    });
    return;
  }

  // Malformed JSON body from express.json()
  if (err instanceof SyntaxError && 'body' in err) {
    res.status(400).json({ error: { code: 'VALIDATION_FAILED', message: 'Malformed JSON body' } });
    return;
  }

  const status = err instanceof HttpError ? err.status : 500;
  if (status >= 500) console.error(err);

  res.status(status).json({
    error: {
      code: err instanceof HttpError ? err.code : 'INTERNAL',
      message:
        status >= 500 && env.NODE_ENV === 'production' ? 'Internal server error' : err.message,
      ...(err instanceof HttpError && err.fields ? { fields: err.fields } : {}),
    },
  });
};
