import { createHash } from 'node:crypto';
import type { Request } from 'express';
import { z } from 'zod';
import { parse } from './http';

/** Header that makes a submission safe to retry. */
export const idempotencyHeaders = z.object({
  'Idempotency-Key': z
    .string({ message: 'Send a unique key per submission, e.g. a UUID' })
    .regex(/^[A-Za-z0-9_-]{8,128}$/, { message: 'Use 8-128 characters: A-Z a-z 0-9 _ -' }),
});

/** The request's Idempotency-Key header; a missing or malformed key is a 400. */
export function idempotencyKeyOf(req: Request): string {
  return parse(idempotencyHeaders, { 'Idempotency-Key': req.get('Idempotency-Key') })[
    'Idempotency-Key'
  ];
}

/** Fingerprint of a parsed request body, stored with the key to spot reuse with another body. */
export function requestHash(input: unknown): string {
  return createHash('sha256').update(JSON.stringify(input)).digest('hex');
}
