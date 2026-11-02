import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { env } from '../config/env';

const indexKey = Buffer.from(env.BLIND_INDEX_KEY, 'base64');

// Deterministic keyed hash for OTP codes and rate-limit keys.
export function keyedHash(context: string, value: string): string {
  return createHmac('sha256', indexKey).update(`${context}:${value}`).digest('hex');
}

// For high-entropy secrets (refresh tokens, reset tokens); no key needed.
export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function generateOtp(): string {
  return randomInt(0, 10_000).toString().padStart(4, '0');
}

export function safeEqualHex(a: string, b: string): boolean {
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  return left.length === right.length && timingSafeEqual(left, right);
}
