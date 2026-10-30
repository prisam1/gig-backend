import type { z } from 'zod';
import { env } from '../../config/env';
import { audit } from '../../lib/audit';
import { decrypt, encrypt, keyedHash, randomToken, sha256 } from '../../lib/crypto';
import { callDb } from '../../lib/db';
import type { DbResult } from '../../lib/dbFunctions';
import { maskDestination, sendNotice, sendOtp, type Channel } from '../../lib/notifier';
import { burnPasswordCheck, hashPassword, verifyPassword } from '../../lib/password';
import { LIMITS, consume, limitArg, reset, tooMany } from '../../lib/rateLimit';
import type { AuthContext } from '../../middleware/auth';
import { AppError } from '../../middleware/errorHandler';
import type { ClientContext } from '../../middleware/requestContext';
import { loadUser } from '../users/users.service';
import {
  passwordContainsIdentity,
  type Identifier,
  type loginSchema,
  type otpSendSchema,
  type otpVerifySchema,
  type refreshSchema,
  type registerCheckSchema,
  type registerSchema,
  type resetPasswordSchema,
} from './auth.schemas';
import {
  OTP_MAX_ATTEMPTS,
  OTP_MAX_SENDS,
  OTP_RESEND_COOLDOWN_SECONDS,
  OTP_TTL_SECONDS,
  challengeView,
  codeHash,
  issueCode,
} from './otp';
import { newSession, parseRefreshToken, tokenPair } from './sessions';

const SIGNUP_TTL_SECONDS = 3600;
const RESET_TOKEN_TTL_SECONDS = 600;
const AGE_CONSENT_VERSION = '2026-10-27';

const emailHash = (email: string) => keyedHash('email', email);
const phoneHash = (phone: string) => keyedHash('phone', phone);
const identifierHash = (id: Identifier) => (id.channel === 'EMAIL' ? emailHash(id.value) : phoneHash(id.value));
const decryptContact = (channel: Channel, value: string) => decrypt(value, channel === 'EMAIL' ? 'email' : 'phone');

const fieldError = (field: string, message: string) =>
  new AppError(400, 'VALIDATION_FAILED', 'Some fields are invalid', { [field]: message });

// Database functions report expected failures as { error } instead of raising, so the state that
// must be kept (a counted OTP attempt, a revoked session) is committed.
type DbFailure = Extract<DbResult<'app_otp_verify'>, { error: string }>;
/** Narrows a database result to its { error } case; the other cases remain after the check. */
const failed = <T extends object>(result: T): result is Extract<T, DbFailure> => 'error' in result;

const signupExpired = () => new AppError(410, 'SIGNUP_EXPIRED', 'This sign-up has expired. Please register again.');
const invalidCode = () => new AppError(400, 'OTP_INVALID', 'Invalid or expired code');

function otpError(f: DbFailure): AppError {
  switch (f.error) {
    case 'OTP_EXPIRED':
      return new AppError(400, 'OTP_EXPIRED', 'This code has expired. Request a new one.');
    case 'OTP_ATTEMPTS_EXCEEDED':
      return new AppError(429, 'OTP_ATTEMPTS_EXCEEDED', 'Too many incorrect codes. Request a new one.');
    case 'OTP_INCORRECT': {
      const remaining = f.remaining ?? 0;
      return new AppError(400, 'OTP_INVALID', `Incorrect code. ${remaining} attempt${remaining === 1 ? '' : 's'} left.`, {
        code: 'Incorrect code',
      });
    }
    case 'RATE_LIMITED':
      return tooMany(f.retryAfter ?? 60);
    case 'SIGNUP_EXPIRED':
      return signupExpired();
    case 'ACCOUNT_EXISTS':
      return new AppError(409, 'ACCOUNT_EXISTS', 'An account with this email or phone already exists. Log in or reset your password.');
    default:
      return invalidCode();
  }
}

// ---------------------------------------------------------------------------------------------
// Sign-up. The account is created only after both the email and the phone are verified. An email
// or phone that already belongs to an account is refused with 409 ACCOUNT_EXISTS and a message
// under each taken field, on step 1 (checkSignupContact) and again here.
// ---------------------------------------------------------------------------------------------

// Each taken address has its own message under its own field; they are never combined.
const EMAIL_TAKEN = 'This email is already registered with another account.';
const PHONE_TAKEN = 'This phone number is already registered with another account.';

function accountExists(taken: { email: boolean; phone: boolean }): AppError {
  const fields: Record<string, string> = {};
  if (taken.email) fields['email'] = EMAIL_TAKEN;
  if (taken.phone) fields['phone'] = PHONE_TAKEN;
  return new AppError(409, 'ACCOUNT_EXISTS', taken.email ? EMAIL_TAKEN : PHONE_TAKEN, fields);
}

/** POST /auth/register/check: sign-up step 1 asks whether the email, the phone, or both are free. */
export async function checkSignupContact(input: z.infer<typeof registerCheckSchema>, ctx: ClientContext) {
  await consume(LIMITS.registerCheckPerIp, ctx.ip);
  const taken = await callDb('app_contact_taken', {
    p_email_hash: input.email === undefined ? null : emailHash(input.email),
    p_phone_hash: input.phone === undefined ? null : phoneHash(input.phone),
  });
  if (taken.emailTaken || taken.phoneTaken) throw accountExists({ email: taken.emailTaken, phone: taken.phoneTaken });
  return { available: true as const };
}

export async function register(input: z.infer<typeof registerSchema>, ctx: ClientContext) {
  const eHash = emailHash(input.email);
  const pHash = phoneHash(input.phone);
  await consume(LIMITS.registerPerIp, ctx.ip);
  await consume(LIMITS.otpSendPerDestination, eHash);
  await consume(LIMITS.otpSendPerDestination, pHash);

  const email = issueCode();
  const phone = issueCode();
  const started = await callDb(
    'app_signup_start',
    {
      p_signup: {
        name: input.name,
        emailEnc: encrypt(input.email, 'email'),
        emailHash: eHash,
        countryCode: input.countryCode,
        phoneEnc: encrypt(input.phone, 'phone'),
        phoneHash: pHash,
        passwordHash: await hashPassword(input.password),
        ttlSeconds: SIGNUP_TTL_SECONDS,
        otpTtlSeconds: OTP_TTL_SECONDS,
        // Steps 2-3 and the tier (the app's OTP screen comes after its tier screen).
        onboarding: { profile: input.profile, preferences: input.preferences, tier: input.tier },
      },
      p_email_challenge: email.stored,
      p_phone_challenge: phone.stored,
      p_ctx: ctx,
    },
  );

  // Nothing was stored and no code was sent in either case.
  if ('fields' in started) throw new AppError(400, 'VALIDATION_FAILED', 'Some fields are invalid', started.fields);
  if ('taken' in started) throw accountExists(started.taken);

  sendOtp('EMAIL', input.email, email.code, 'SIGNUP');
  sendOtp('PHONE', input.phone, phone.code, 'SIGNUP');

  return {
    signupId: started.signupId,
    expiresAt: started.expiresAt,
    challenges: [
      challengeView(email.publicId, 'EMAIL', maskDestination('EMAIL', input.email)),
      challengeView(phone.publicId, 'PHONE', maskDestination('PHONE', input.phone)),
    ],
  };
}

// ---------------------------------------------------------------------------------------------
// POST /auth/otp/send: resend the code of an existing sign-up or password-reset challenge.
// ---------------------------------------------------------------------------------------------
export async function sendOtpRequest(input: z.infer<typeof otpSendSchema>, ctx: ClientContext) {
  await consume(LIMITS.otpSendPerIp, ctx.ip);
  return resendChallenge(input.challengeId);
}

// POST /auth/password/forgot: a code is sent only when an active account has the email or phone;
// otherwise the user is told to create an account (404 ACCOUNT_NOT_FOUND). Limited per IP and per
// address before the lookup, so the answer cannot be used to check many addresses quickly. Only
// the newest code per address works.
export async function forgotPassword(identifier: Identifier, ctx: ClientContext) {
  await consume(LIMITS.otpSendPerIp, ctx.ip);
  const destinationHash = identifierHash(identifier);
  await consume(LIMITS.otpSendPerDestination, destinationHash);

  const challenge = issueCode();
  const { userExists } = await callDb('app_otp_start', {
    p_purpose: 'PASSWORD_RESET',
    p_channel: identifier.channel,
    p_destination_hash: destinationHash,
    p_challenge: challenge.stored,
    p_ttl_seconds: OTP_TTL_SECONDS,
    p_ctx: ctx,
  });
  if (!userExists) {
    const what = identifier.channel === 'EMAIL' ? 'email' : 'phone number';
    const message = `No account found with this ${what}. Please create your account.`;
    throw new AppError(404, 'ACCOUNT_NOT_FOUND', message, { identifier: message });
  }
  sendOtp(identifier.channel, identifier.value, challenge.code, 'PASSWORD_RESET');
  return challengeView(challenge.publicId, identifier.channel, maskDestination(identifier.channel, identifier.value));
}

// The keyed hash of the address a challenge belongs to, for per-address limits.
async function challengeDestination(publicId: string): Promise<string | null> {
  const peek = await callDb('app_otp_peek', { p_public_id: publicId });
  return peek?.destinationHash ?? null;
}

async function resendChallenge(publicId: string) {
  const invalid = new AppError(400, 'OTP_CHALLENGE_INVALID', 'This verification has ended. Start again.');
  const destinationHash = await challengeDestination(publicId);
  if (!destinationHash) throw invalid;

  const code = issueCode(publicId);
  const sent = await callDb('app_otp_resend', {
    p_public_id: publicId,
    p_challenge: code.stored,
    p_cooldown_seconds: OTP_RESEND_COOLDOWN_SECONDS,
    p_max_sends: OTP_MAX_SENDS,
    p_ttl_seconds: OTP_TTL_SECONDS,
    p_limit: limitArg(LIMITS.otpSendPerDestination, destinationHash),
  });

  if (failed(sent)) {
    switch (sent.error) {
      case 'SIGNUP_EXPIRED':
        throw signupExpired();
      case 'OTP_RESEND_COOLDOWN': {
        const wait = String(sent.retryAfter ?? OTP_RESEND_COOLDOWN_SECONDS);
        throw new AppError(429, 'OTP_RESEND_COOLDOWN', `Please wait ${wait} seconds before requesting a new code.`, undefined, {
          'Retry-After': wait,
        });
      }
      case 'OTP_RESEND_LIMIT':
        throw new AppError(429, 'OTP_RESEND_LIMIT', 'Too many codes requested. Please start again.');
      case 'RATE_LIMITED':
        throw tooMany(sent.retryAfter ?? 60);
      default:
        throw invalid;
    }
  }

  if (!sent.isDecoy && sent.destinationEnc) {
    sendOtp(sent.channel, decryptContact(sent.channel, sent.destinationEnc), code.code, sent.purpose);
  }
  // No destination in the response: a decoy has none, and leaving it out keeps both identical.
  return challengeView(publicId, sent.channel);
}

// ---------------------------------------------------------------------------------------------
// POST /auth/otp/verify
// ---------------------------------------------------------------------------------------------
export async function verifyOtp(input: z.infer<typeof otpVerifySchema>, ctx: ClientContext) {
  await consume(LIMITS.otpVerifyPerIp, ctx.ip);
  const destinationHash = await challengeDestination(input.challengeId);
  if (!destinationHash) throw invalidCode();

  // Prepared up front; the database keeps only hashes and uses whichever the challenge needs.
  const session = newSession(input.device);
  const resetToken = randomToken();
  const result = await callDb('app_otp_verify', {
    p_public_id: input.challengeId,
    p_code_hash: codeHash(input.challengeId, input.code),
    p_max_attempts: OTP_MAX_ATTEMPTS,
    // Per address, across every challenge and IP, so spreading guesses over many IPs does not help.
    p_limits: [
      limitArg(LIMITS.otpVerifyPerDestinationHour, destinationHash),
      limitArg(LIMITS.otpVerifyPerDestinationDay, destinationHash),
    ],
    p_session: session.stored,
    p_reset: { tokenHash: sha256(resetToken), ttlSeconds: RESET_TOKEN_TTL_SECONDS },
    p_age_consent_version: AGE_CONSENT_VERSION,
    p_ctx: ctx,
  });
  if (failed(result)) throw otpError(result);

  switch (result.status) {
    case 'PENDING':
      return result;
    case 'RESET_TOKEN_ISSUED':
      return { status: result.status, resetToken, resetTokenExpiresIn: RESET_TOKEN_TTL_SECONDS };
    case 'COMPLETED':
      return {
        status: result.status,
        user: await loadUser(result.userId),
        tokens: tokenPair(result.userPublicId, session.publicId, session.secret, result.sessionExpiresAt),
      };
  }
}

// ---------------------------------------------------------------------------------------------
// POST /auth/login. One generic error for unknown accounts and wrong passwords; 5 attempts per
// email/phone in 15 minutes, whether or not an account exists.
// ---------------------------------------------------------------------------------------------
export async function login(input: z.infer<typeof loginSchema>, ctx: ClientContext) {
  await consume(LIMITS.loginPerIp, ctx.ip);
  const idHash = identifierHash(input.identifier);
  // Counted before the password check, so parallel guesses cannot all pass; reset on success.
  await consume(LIMITS.loginFailuresPerAccount, idHash);

  const user = await callDb(
    'app_login_lookup',
    { p_channel: input.identifier.channel, p_id_hash: idHash },
  );

  let valid = false;
  if (user) valid = await verifyPassword(user.passwordHash, input.password);
  else await burnPasswordCheck(input.password);

  const invalidCredentials = new AppError(401, 'INVALID_CREDENTIALS', 'Incorrect email/phone or password');
  if (!user || !valid) {
    await audit(ctx, 'auth.login.failed', { userId: user?.userId ?? null, metadata: { channel: input.identifier.channel } });
    throw invalidCredentials;
  }
  // Only revealed to someone who knows the password.
  if (user.status === 'SUSPENDED') {
    throw new AppError(403, 'ACCOUNT_SUSPENDED', 'This account is suspended. Please contact support.');
  }

  await reset(LIMITS.loginFailuresPerAccount, idHash);
  const session = newSession(input.device);
  const done = await callDb('app_login_complete', {
    p_user_id: user.userId,
    p_session: session.stored,
    p_ctx: ctx,
  });
  if (failed(done)) throw invalidCredentials;

  return {
    user: await loadUser(user.userId),
    tokens: tokenPair(user.userPublicId, session.publicId, session.secret, done.sessionExpiresAt),
  };
}

// ---------------------------------------------------------------------------------------------
// POST /auth/refresh. Rotates on every use. Presenting an already-rotated token means it was
// copied: the whole session is revoked and the device must log in again.
// ---------------------------------------------------------------------------------------------
export async function refresh(input: z.infer<typeof refreshSchema>, ctx: ClientContext) {
  await consume(LIMITS.refreshPerIp, ctx.ip);
  const invalid = new AppError(401, 'INVALID_REFRESH_TOKEN', 'Your session has expired. Please log in again.');
  const parsed = parseRefreshToken(input.refreshToken);
  if (!parsed) throw invalid;

  const secret = randomToken();
  const rotated = await callDb('app_refresh', {
    p_session_public_id: parsed.sessionPublicId,
    p_secret_hash: parsed.secretHash,
    p_new_secret_hash: sha256(secret),
    p_idle_days: env.REFRESH_TOKEN_IDLE_DAYS,
    p_ctx: ctx,
  });
  if (failed(rotated)) throw invalid;

  return { tokens: tokenPair(rotated.userPublicId, parsed.sessionPublicId, secret, rotated.sessionExpiresAt) };
}

// ---------------------------------------------------------------------------------------------
// Signed-in session management
// ---------------------------------------------------------------------------------------------
export async function logout(auth: AuthContext, ctx: ClientContext) {
  await callDb('app_logout', { p_user_id: auth.userId, p_session_id: auth.sessionId, p_ctx: ctx });
}

// ---------------------------------------------------------------------------------------------
// POST /auth/password/reset. Sets the new password, ends every session, and tells the user.
// ---------------------------------------------------------------------------------------------
export async function resetPassword(input: z.infer<typeof resetPasswordSchema>, ctx: ClientContext) {
  await consume(LIMITS.passwordResetPerIp, ctx.ip);
  const invalid = new AppError(400, 'RESET_TOKEN_INVALID', 'This reset has expired. Please request a new code.');
  const tokenHash = sha256(input.resetToken);

  const ticket = await callDb(
    'app_reset_lookup',
    { p_token_hash: tokenHash },
  );
  if (!ticket) throw invalid;

  const email = decrypt(ticket.emailEnc, 'email');
  const phone = decrypt(ticket.phoneEnc, 'phone');
  if (passwordContainsIdentity(input.newPassword, email, phone)) {
    throw fieldError('newPassword', 'Password must not contain your email name or phone number');
  }
  if (await verifyPassword(ticket.passwordHash, input.newPassword)) {
    throw fieldError('newPassword', 'New password must be different from your current password');
  }

  // Re-checks the ticket under lock, so a ticket used or replaced meanwhile is refused.
  const done = await callDb('app_reset_complete', {
    p_token_hash: tokenHash,
    p_password_hash: await hashPassword(input.newPassword),
    p_ctx: ctx,
  });
  if (!done.ok) throw invalid;

  // A fresh password clears any login lock on this account.
  await reset(LIMITS.loginFailuresPerAccount, emailHash(email));
  await reset(LIMITS.loginFailuresPerAccount, phoneHash(phone));
  sendNotice('EMAIL', email, 'PASSWORD_CHANGED');
  return { passwordReset: true };
}
