import { AppError } from '../middleware/errorHandler';
import { keyedHash } from './crypto';
import { sql, type Db } from './db';

export interface Limit {
  name: string;
  max: number;
  windowSeconds: number;
}

// Shared limits stored in Postgres, so they hold across every API instance.
// Subjects (IPs, emails, phones) are hashed before they become keys.
export const LIMITS = {
  registerPerIp: { name: 'register:ip', max: 10, windowSeconds: 3600 },
  otpSendPerIp: { name: 'otp-send:ip', max: 20, windowSeconds: 3600 },
  otpSendPerDestination: { name: 'otp-send:dest', max: 5, windowSeconds: 3600 },
  otpVerifyPerIp: { name: 'otp-verify:ip', max: 30, windowSeconds: 900 },
  // Counted per guess on one email or phone, from any IP, so spreading guesses over many IPs
  // does not help. A correct code resets the count. 6 digits => at most 20 guesses a day.
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
  followPerUser: { name: 'follow:user', max: 60, windowSeconds: 60 },
  ratingSubmitPerUser: { name: 'rating-submit:user', max: 20, windowSeconds: 3600 },
  signaturePerUser: { name: 'signature:user', max: 20, windowSeconds: 3600 },
  // Every API request (health checks excepted). The load balancer's WAF adds its own limit.
  apiPerIp: { name: 'api:ip', max: 300, windowSeconds: 60 },
} satisfies Record<string, Limit>;

function key(limit: Limit, subject: string | null): string {
  return `${limit.name}:${keyedHash('rate-limit', subject ?? 'unknown')}`;
}

function tooMany(retryAfterSeconds: number): AppError {
  const seconds = Math.max(1, Math.ceil(retryAfterSeconds));
  return new AppError(429, 'RATE_LIMITED', 'Too many requests. Please try again later.', undefined, {
    'Retry-After': String(seconds),
  });
}

// Counts one hit and throws 429 once the limit is passed.
export async function consume(limit: Limit, subject: string | null, db: Db = sql): Promise<void> {
  const [row] = await db<{ count: number; retryAfter: number }[]>`
    insert into app.rate_limits as r (key, count, expires_at)
    values (${key(limit, subject)}, 1, now() + make_interval(secs => ${limit.windowSeconds}))
    on conflict (key) do update set
      count = case when r.expires_at <= now() then 1 else r.count + 1 end,
      expires_at = case when r.expires_at <= now() then excluded.expires_at else r.expires_at end
    returning count, extract(epoch from expires_at - now())::float8 as retry_after`;
  if (row && row.count > limit.max) throw tooMany(row.retryAfter);
}

export async function reset(limit: Limit, subject: string | null, db: Db = sql): Promise<void> {
  await db`delete from app.rate_limits where key = ${key(limit, subject)}`;
}
