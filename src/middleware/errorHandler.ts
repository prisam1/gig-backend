import type { ErrorRequestHandler, RequestHandler } from 'express';
import { z } from 'zod';
import { env } from '../config/env';
import { noteError } from './requestLog';

// Every error response has the shape { error: { code, message, fields? } } so the app can show
// its existing field messages.
export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly fields?: Record<string, string>,
    public readonly headers?: Record<string, string>,
  ) {
    super(message);
  }
}

export type FieldErrors = Record<string, string>;

// Shared codes from the API spec. Modules add their own where the app needs to tell cases apart
// (for example INVALID_CREDENTIALS or KYC_ALREADY_PENDING).
const defaultCodes: Record<number, string> = {
  400: 'VALIDATION_FAILED',
  401: 'UNAUTHENTICATED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  409: 'CONFLICT',
};

/** An AppError whose code defaults from the status. */
export class HttpError extends AppError {
  constructor(status: number, message: string, options: { code?: string; fields?: FieldErrors } = {}) {
    super(status, options.code ?? defaultCodes[status] ?? 'INTERNAL', message, options.fields);
  }
}

/** 400 with per-field messages the app can show next to each input. */
export function validationError(fields: FieldErrors): HttpError {
  return new HttpError(400, 'Some fields are invalid', { fields });
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
  next(new AppError(404, 'NOT_FOUND', `Route not found: ${req.method} ${req.path}`));
};

// Errors raised by express.json() before a route runs.
function bodyParserError(err: unknown): AppError | undefined {
  const type = (err as { type?: string } | null)?.type;
  if (type === 'entity.parse.failed') return new AppError(400, 'VALIDATION_FAILED', 'Malformed JSON body');
  if (type === 'entity.too.large') return new AppError(413, 'PAYLOAD_TOO_LARGE', 'Request body is too large');
  if (type === 'charset.unsupported' || type === 'encoding.unsupported') {
    return new AppError(415, 'UNSUPPORTED_ENCODING', 'Unsupported request encoding');
  }
  return undefined;
}

export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  const known =
    err instanceof AppError
      ? err
      : err instanceof z.ZodError
        ? new AppError(400, 'VALIDATION_FAILED', 'Validation failed', zodFields(err))
        : bodyParserError(err);

  if (!known) {
    console.error(`[${req.requestId}]`, err);
    const detail = err instanceof Error ? err.message : String(err);
    noteError(res, { code: 'INTERNAL', message: detail });
    res.status(500).json({
      error: {
        code: 'INTERNAL',
        // Details (SQL errors, stack messages) only on a developer machine, never on a server.
        message: env.NODE_ENV === 'development' ? detail : 'Internal server error',
      },
    });
    return;
  }

  noteError(res, { code: known.code, message: known.message, ...(known.fields && { fields: Object.keys(known.fields) }) });
  if (known.headers) res.set(known.headers);
  res.status(known.status).json({
    error: { code: known.code, message: known.message, ...(known.fields && { fields: known.fields }) },
  });
};
