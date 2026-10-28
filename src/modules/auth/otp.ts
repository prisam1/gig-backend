import { randomUUID } from 'node:crypto';
import { env } from '../../config/env';
import { generateOtp, keyedHash } from '../../lib/crypto';
import type { Channel } from '../../lib/notifier';

// Matches the plan: 6-digit codes, valid 5 minutes, 5 attempts per code, 45 s resend cooldown
// (the app's timer), at most 5 sends per challenge.
export const OTP_TTL_SECONDS = 300;
export const OTP_MAX_ATTEMPTS = 5;
export const OTP_RESEND_COOLDOWN_SECONDS = 45;
export const OTP_MAX_SENDS = 5;

// Codes are stored only as keyed hashes; the key never leaves the API.
export function codeHash(challengePublicId: string, code: string): string {
  return keyedHash('otp', `${challengePublicId}:${code}`);
}

/**
 * A fresh code for a challenge. `stored` is what the database keeps: the code's hash, and a
 * decoy hash that no code can match, used when nothing must be sent (unknown or taken address).
 */
export function issueCode(publicId: string = randomUUID()) {
  // OTP_TEST_CODE (development only, refused in production) makes every code a known value.
  const code = env.OTP_TEST_CODE ?? generateOtp();
  return {
    publicId,
    code,
    stored: { publicId, codeHash: codeHash(publicId, code), decoyHash: codeHash(publicId, randomUUID()) },
  };
}

export function challengeView(publicId: string, channel: Channel, destination?: string) {
  return {
    challengeId: publicId,
    channel,
    ...(destination && { destination }),
    expiresInSeconds: OTP_TTL_SECONDS,
    resendAfterSeconds: OTP_RESEND_COOLDOWN_SECONDS,
  };
}
