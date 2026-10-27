import type { ErrorRequestHandler, RequestHandler } from 'express';
import { env } from '../config/env';

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

export const notFound: RequestHandler = (req, _res, next) => {
  next(new AppError(404, 'NOT_FOUND', `Route not found: ${req.method} ${req.path}`));
};

// Errors raised by express.json() before a route runs.
function bodyParserError(err: unknown): AppError | undefined {
  const type = (err as { type?: string } | null)?.type;
  if (type === 'entity.parse.failed') return new AppError(400, 'INVALID_JSON', 'Request body is not valid JSON');
  if (type === 'entity.too.large') return new AppError(413, 'PAYLOAD_TOO_LARGE', 'Request body is too large');
  if (type === 'charset.unsupported' || type === 'encoding.unsupported') {
    return new AppError(415, 'UNSUPPORTED_ENCODING', 'Unsupported request encoding');
  }
  return undefined;
}

export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  const known = err instanceof AppError ? err : bodyParserError(err);

  if (!known) {
    console.error(`[${req.requestId}]`, err);
    res.status(500).json({
      error: {
        code: 'INTERNAL',
        message: env.NODE_ENV === 'production' ? 'Internal server error' : String(err?.message ?? err),
      },
    });
    return;
  }

  if (known.headers) res.set(known.headers);
  res.status(known.status).json({
    error: { code: known.code, message: known.message, ...(known.fields && { fields: known.fields }) },
  });
};
