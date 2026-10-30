import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  randomInt,
  timingSafeEqual,
} from 'node:crypto';
import { env } from '../config/env';

const encryptionKey = Buffer.from(env.DATA_ENCRYPTION_KEY, 'base64');
const indexKey = Buffer.from(env.BLIND_INDEX_KEY, 'base64');

// AES-256-GCM. Output: v1.<iv>.<tag>.<ciphertext> (base64url). The context (e.g. "email") is
// bound as additional data, so a value copied into another column will not decrypt.
export function encrypt(plaintext: string, context: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey, iv);
  cipher.setAAD(Buffer.from(context));
  const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', iv, tag, data].map((p) => (typeof p === 'string' ? p : p.toString('base64url'))).join('.');
}

export function decrypt(payload: string, context: string): string {
  const [version, iv, tag, data] = payload.split('.');
  if (version !== 'v1' || !iv || !tag || data === undefined) throw new Error('Unsupported ciphertext');
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey, Buffer.from(iv, 'base64url'));
  decipher.setAAD(Buffer.from(context));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8');
}

// Deterministic keyed hash for unique lookups (email, phone), OTP codes and rate-limit keys.
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
