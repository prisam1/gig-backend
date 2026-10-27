import { createHash } from 'node:crypto';
import type { Request } from 'express';
import { z } from 'zod';
import { parse } from '../middleware/validate';

// Every POST that creates a submission (review, rating, signature) takes an Idempotency-Key header.
// The key is stored on the created row with a hash of the request, so a retry with the same key
// and body returns the original result instead of creating a copy.

export const IDEMPOTENCY_HEADER = 'Idempotency-Key';

/** Response header set when a retry returns the result of an earlier request. */
export const REPLAYED_HEADER = 'Idempotent-Replayed';

export const idempotencyHeaders = z.object({
  [IDEMPOTENCY_HEADER]: z
    .string({ message: 'Send a unique key per submission, e.g. a UUID' })
    .regex(/^[A-Za-z0-9_-]{8,128}$/, { message: 'Use 8-128 characters: A-Z a-z 0-9 _ -' }),
});

/** The request's Idempotency-Key; a missing or malformed key is a 400 with a field error. */
export function readIdempotencyKey(req: Request): string {
  return parse(idempotencyHeaders, { [IDEMPOTENCY_HEADER]: req.get(IDEMPOTENCY_HEADER) })[
    IDEMPOTENCY_HEADER
  ];
}

/** Fingerprint of a parsed request body, stored next to the key to detect a reused key. */
export function hashRequest(input: unknown): string {
  return createHash('sha256').update(JSON.stringify(input)).digest('hex');
}

/** What a submission returns: the result, and whether it is a replay of an earlier request. */
export interface IdempotentResult<T> {
  result: T;
  replayed: boolean;
}
