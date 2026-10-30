import type { RequestHandler, Response } from 'express';
import { env } from '../config/env';

/** What the error handler answered, kept for the request's log line. */
export interface LoggedError {
  code: string;
  message: string;
  fields?: string[];
}

export function noteError(res: Response, error: LoggedError): void {
  res.locals['loggedError'] = error;
}

/**
 * One line per request in the server log, written when the answer has been sent:
 *
 *   [http] 3f2a1c9e POST /api/v1/auth/login 401 34ms INVALID_CREDENTIALS "Incorrect email/phone or password"
 *
 * The first part is the X-Request-Id the app received, so a request can be matched to the app's
 * [GIG] log. Bodies, query strings and tokens are never written (they can hold passwords, codes
 * and personal data); for field errors only the field names are. Off in tests.
 */
export const requestLog: RequestHandler = (req, res, next) => {
  if (env.NODE_ENV === 'test') {
    next();
    return;
  }
  const startedAt = process.hrtime.bigint();
  res.on('finish', () => {
    const ms = Number(process.hrtime.bigint() - startedAt) / 1e6;
    const error = res.locals['loggedError'] as LoggedError | undefined;
    const detail = error
      ? ` ${error.code} "${error.message}"${error.fields?.length ? ` fields: ${error.fields.join(', ')}` : ''}`
      : '';
    const line = `[http] ${req.requestId.slice(0, 8)} ${req.method} ${req.originalUrl.split('?')[0] ?? ''} ${res.statusCode} ${ms.toFixed(0)}ms${detail}`;
    if (res.statusCode >= 500) console.error(line);
    else if (res.statusCode >= 400) console.warn(line);
    else console.log(line);
  });
  next();
};
