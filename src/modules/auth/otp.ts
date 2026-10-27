import { randomUUID } from 'node:crypto';
import { generateOtp, keyedHash, safeEqualHex } from '../../lib/crypto';
import type { Db } from '../../lib/db';
import type { Channel, OtpPurpose } from '../../lib/notifier';

// Matches the plan: 6-digit codes, valid 5 minutes, 5 attempts per code, 45 s resend cooldown
// (the app's timer), at most 5 sends per challenge.
export const OTP_TTL_SECONDS = 300;
export const OTP_MAX_ATTEMPTS = 5;
export const OTP_RESEND_COOLDOWN_SECONDS = 45;
export const OTP_MAX_SENDS = 5;

export function codeHash(challengePublicId: string, code: string): string {
  return keyedHash('otp', `${challengePublicId}:${code}`);
}

export interface ChallengeRow {
  id: string;
  publicId: string;
  purpose: OtpPurpose;
  channel: Channel;
  userId: string | null;
  signupRequestId: string | null;
  isDecoy: boolean;
  codeHash: string;
  attempts: number;
  sendCount: number;
  lastSentAt: Date;
  expiresAt: Date;
  verifiedAt: Date | null;
}

export interface NewChallenge {
  purpose: OtpPurpose;
  channel: Channel;
  destinationHash: string;
  userId?: string | null;
  signupRequestId?: string | null;
  isDecoy: boolean;
  ip: string | null;
}

// Returns the code to deliver. For a decoy the code is never sent and its hash is random,
// so no input can ever verify it.
export async function createChallenge(tx: Db, c: NewChallenge): Promise<{ publicId: string; code: string }> {
  const publicId = randomUUID();
  const code = generateOtp();
  const hash = c.isDecoy ? codeHash(publicId, randomUUID()) : codeHash(publicId, code);
  await tx`
    insert into app.otp_challenges (public_id, purpose, channel, destination_hash, user_id,
      signup_request_id, is_decoy, code_hash, expires_at, created_ip)
    values (${publicId}, ${c.purpose}, ${c.channel}, ${c.destinationHash}, ${c.userId ?? null},
      ${c.signupRequestId ?? null}, ${c.isDecoy}, ${hash},
      now() + make_interval(secs => ${OTP_TTL_SECONDS}), ${c.ip})`;
  return { publicId, code };
}

// Issues a fresh code on an existing challenge: new hash, attempts reset, expiry extended.
export async function reissueChallenge(tx: Db, challenge: ChallengeRow): Promise<string> {
  const code = generateOtp();
  const hash = challenge.isDecoy ? codeHash(challenge.publicId, randomUUID()) : codeHash(challenge.publicId, code);
  await tx`
    update app.otp_challenges set code_hash = ${hash}, attempts = 0, send_count = send_count + 1,
      last_sent_at = now(), expires_at = now() + make_interval(secs => ${OTP_TTL_SECONDS})
    where id = ${challenge.id}`;
  return code;
}

export function codeMatches(challenge: ChallengeRow, code: string): boolean {
  return !challenge.isDecoy && safeEqualHex(challenge.codeHash, codeHash(challenge.publicId, code));
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
