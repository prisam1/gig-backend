import { AppError } from '../middleware/errorHandler';
import { keyedHash } from './crypto';
import { callDb } from './db';

export interface Limit {
  name: string;
  max: number;
  windowSeconds: number;
}

// Shared limits stored in Postgres, so they hold across every API instance.
// Subjects (IPs, emails, phones) are hashed before they become keys.
export const LIMITS = {
  registerPerIp: { name: 'register:ip', max: 10, windowSeconds: 3600 },
  // Sign-up step 1 asks whether the email and phone are free.
  registerCheckPerIp: { name: 'register-check:ip', max: 30, windowSeconds: 3600 },
  otpSendPerIp: { name: 'otp-send:ip', max: 20, windowSeconds: 3600 },
  otpSendPerDestination: { name: 'otp-send:dest', max: 5, windowSeconds: 3600 },
  otpVerifyPerIp: { name: 'otp-verify:ip', max: 30, windowSeconds: 900 },
  // Counted per guess on one email or phone, from any IP, so spreading guesses over many IPs
  // does not help. A correct code resets the count. 4 digits => at most 20 guesses a day (0.2% of the codes).
  otpVerifyPerDestinationHour: { name: 'otp-verify:dest:h', max: 10, windowSeconds: 3600 },
  otpVerifyPerDestinationDay: { name: 'otp-verify:dest:d', max: 20, windowSeconds: 86400 },
  loginPerIp: { name: 'login:ip', max: 20, windowSeconds: 900 },
  // Counted before the password is checked (so parallel requests cannot slip past it) and reset
  // on a successful login.
  loginFailuresPerAccount: { name: 'login-fail:id', max: 5, windowSeconds: 900 },
  refreshPerIp: { name: 'refresh:ip', max: 60, windowSeconds: 60 },
  passwordResetPerIp: { name: 'pw-reset:ip', max: 10, windowSeconds: 3600 },
  uploadUrlPerUser: { name: 'upload-url:user', max: 30, windowSeconds: 3600 },
  kycSubmitPerUser: { name: 'kyc-submit:user', max: 5, windowSeconds: 3600 },
  ratingSubmitPerUser: { name: 'rating-submit:user', max: 20, windowSeconds: 3600 },
  signaturePerUser: { name: 'signature:user', max: 20, windowSeconds: 3600 },
  // Every API request (health checks excepted). The load balancer's WAF adds its own limit.
  apiPerIp: { name: 'api:ip', max: 300, windowSeconds: 60 },
} satisfies Record<string, Limit>;

function key(limit: Limit, subject: string | null): string {
  return `${limit.name}:${keyedHash('rate-limit', subject ?? 'unknown')}`;
}

/** A limit as the database functions take it, for limits counted inside one of them. */
export function limitArg(limit: Limit, subject: string | null) {
  return { key: key(limit, subject), max: limit.max, window: limit.windowSeconds };
}

export function tooMany(retryAfterSeconds: number): AppError {
  const seconds = Math.max(1, Math.ceil(retryAfterSeconds));
  return new AppError(429, 'RATE_LIMITED', 'Too many requests. Please try again later.', undefined, {
    'Retry-After': String(seconds),
  });
}

// Counts one hit and throws 429 once the limit is passed.
export async function consume(limit: Limit, subject: string | null): Promise<void> {
  const hit = await callDb('app_rate_limit_hit', {
    p_key: key(limit, subject),
    p_max: limit.max,
    p_window_seconds: limit.windowSeconds,
  });
  if (hit.limited) throw tooMany(hit.retryAfter);
}

export async function reset(limit: Limit, subject: string | null): Promise<void> {
  await callDb('app_rate_limit_reset', { p_keys: [key(limit, subject)] });
}
