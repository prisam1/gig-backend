import type { ErrorRequestHandler, RequestHandler } from 'express';
import { z } from 'zod';
import { env } from '../config/env';

export type FieldErrors = Record<string, string>;

// Codes from the API spec. Modules add their own where the app must tell cases apart
// (for example KYC_REQUIRED, KYC_PENDING or ACCOUNT_SUSPENDED).
const DEFAULT_CODES: Record<number, string> = {
  400: 'VALIDATION_FAILED',
  401: 'UNAUTHENTICATED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  409: 'CONFLICT',
  413: 'PAYLOAD_TOO_LARGE',
  415: 'UNSUPPORTED_MEDIA_TYPE',
};

// Every error response has the shape { error: { code, message, fields? } } so the app can show
// field messages next to each input.
export class HttpError extends Error {
  public readonly code: string;
  public readonly fields: FieldErrors | undefined;

  constructor(
    public readonly status: number,
    message: string,
    options: { code?: string; fields?: FieldErrors } = {},
  ) {
    super(message);
    this.code = options.code ?? DEFAULT_CODES[status] ?? 'INTERNAL';
    this.fields = options.fields;
  }
}

/** 400 with per-field messages the app can show next to each input. */
export function validationError(fields: FieldErrors): HttpError {
  return new HttpError(400, 'Request validation failed', { fields });
}

/** Flattens a zod error into `{ "metrics.transparency": "message" }`, first message per field. */
export function zodFields(error: z.ZodError): FieldErrors {
  const fields: FieldErrors = {};
  for (const issue of error.issues) {
    const key = issue.path.length > 0 ? issue.path.join('.') : '_';
    fields[key] ??= issue.message;
  }
  return fields;
}

/** Throws a 400 VALIDATION_FAILED when business-rule checks produced any field errors. */
export function assertNoFieldErrors(fields: FieldErrors): void {
  if (Object.keys(fields).length > 0) {
    throw new HttpError(400, 'Validation failed', { fields });
  }
}

export const notFound: RequestHandler = (req, _res, next) => {
  next(new HttpError(404, `Route not found: ${req.method} ${req.path}`));
};

// Errors raised by Express itself (e.g. by express.json()) carry their own 4xx status.
function expressError(err: unknown): HttpError | undefined {
  const { status, type, message } = (err ?? {}) as {
    status?: unknown;
    type?: string;
    message?: string;
  };
  if (type === 'entity.parse.failed') return new HttpError(400, 'Malformed JSON body');
  const code = Number(status);
  if (code >= 400 && code < 500) return new HttpError(code, message ?? 'Bad request');
  return undefined;
}

export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  const known =
    err instanceof HttpError
      ? err
      : err instanceof z.ZodError
        ? new HttpError(400, 'Validation failed', { fields: zodFields(err) })
        : expressError(err);

  if (!known) {
    console.error(`[${req.requestId}]`, err);
    res.status(500).json({
      error: {
        code: 'INTERNAL',
        message:
          env.NODE_ENV === 'production' ? 'Internal server error' : String(err?.message ?? err),
      },
    });
    return;
  }

  res.status(known.status).json({
    error: {
      code: known.code,
      message: known.message,
      ...(known.fields && { fields: known.fields }),
    },
  });
};
