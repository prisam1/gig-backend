import type { z } from 'zod';
import { audit } from '../../lib/audit';
import { decrypt, encrypt, keyedHash, randomToken, safeEqualHex, sha256 } from '../../lib/crypto';
import { sql, transaction, type Db } from '../../lib/db';
import { maskDestination, sendNotice, sendOtp, type Channel, type OtpPurpose } from '../../lib/notifier';
import { burnPasswordCheck, hashPassword, verifyPassword } from '../../lib/password';
import { LIMITS, assertNotLimited, consume, reset } from '../../lib/rateLimit';
import type { AuthContext } from '../../middleware/auth';
import { AppError } from '../../middleware/errorHandler';
import type { ClientContext } from '../../middleware/requestContext';
import { loadUser } from '../users/users.service';
import {
  passwordContainsIdentity,
  type DeviceInfo,
  type Identifier,
  type loginSchema,
  type otpSendSchema,
  type otpVerifySchema,
  type refreshSchema,
  type registerSchema,
  type resetPasswordSchema,
} from './auth.schemas';
import {
  OTP_MAX_ATTEMPTS,
  OTP_MAX_SENDS,
  OTP_RESEND_COOLDOWN_SECONDS,
  challengeView,
  codeMatches,
  createChallenge,
  reissueChallenge,
  type ChallengeRow,
} from './otp';
import { createSession, parseRefreshToken, revokeAllSessions, rotateSession } from './sessions';

const SIGNUP_TTL = '1 hour';
const RESET_TOKEN_TTL_SECONDS = 600;
const AGE_CONSENT_VERSION = '2026-10-27';

const emailHash = (email: string) => keyedHash('email', email);
const phoneHash = (phone: string) => keyedHash('phone', phone);
const identifierHash = (id: Identifier) => (id.channel === 'EMAIL' ? emailHash(id.value) : phoneHash(id.value));

const fieldError = (field: string, message: string) =>
  new AppError(400, 'VALIDATION_FAILED', 'Some fields are invalid', { [field]: message });

// Inside a transaction, failures that must still save state (a wrong OTP attempt, a revoked
// session) are returned instead of thrown, so the transaction commits first.
type Outcome<T> = { ok: true; value: T } | { ok: false; error: AppError };
const ok = <T>(value: T): Outcome<T> => ({ ok: true, value });
const fail = (error: AppError): Outcome<never> => ({ ok: false, error });
function unwrap<O extends Outcome<unknown>>(outcome: O): Extract<O, { ok: true }>['value'] {
  if (!outcome.ok) throw outcome.error;
  return outcome.value;
}

// ---------------------------------------------------------------------------------------------
// Sign-up step 1. The account is created only after both the email and the phone are verified.
// If the email or phone is already registered the response looks the same, but no code is sent
// to that address; its owner gets an "account exists" notice instead. This stops anyone from
// using sign-up to find out who has an account.
// ---------------------------------------------------------------------------------------------
export async function register(input: z.infer<typeof registerSchema>, ctx: ClientContext) {
  const eHash = emailHash(input.email);
  const pHash = phoneHash(input.phone);
  await consume(LIMITS.registerPerIp, ctx.ip);
  await consume(LIMITS.otpSendPerDestination, eHash);
  await consume(LIMITS.otpSendPerDestination, pHash);

  const passwordHash = await hashPassword(input.password);
  const [taken] = await sql<{ emailTaken: boolean; phoneTaken: boolean }[]>`
    select exists (select 1 from app.users where email_hash = ${eHash}) as email_taken,
           exists (select 1 from app.users where phone_hash = ${pHash}) as phone_taken`;
  const emailTaken = taken?.emailTaken ?? true;
  const phoneTaken = taken?.phoneTaken ?? true;

  const created = await transaction(async (tx) => {
    const [signup] = await tx<{ id: string; publicId: string; expiresAt: Date }[]>`
      insert into app.signup_requests (name, email_enc, email_hash, phone_country_code, phone_enc,
        phone_hash, password_hash, age_confirmed_at, created_ip, user_agent, app_version, expires_at)
      values (${input.name}, ${encrypt(input.email, 'email')}, ${eHash}, ${input.countryCode},
        ${encrypt(input.phone, 'phone')}, ${pHash}, ${passwordHash}, now(), ${ctx.ip}, ${ctx.userAgent},
        ${ctx.appVersion}, now() + ${SIGNUP_TTL}::interval)
      returning id, public_id, expires_at`;
    if (!signup) throw new Error('signup insert returned no row');

    const base = { purpose: 'SIGNUP' as const, signupRequestId: signup.id, ip: ctx.ip };
    const email = await createChallenge(tx, { ...base, channel: 'EMAIL', destinationHash: eHash, isDecoy: emailTaken });
    const phone = await createChallenge(tx, { ...base, channel: 'PHONE', destinationHash: pHash, isDecoy: phoneTaken });
    await audit(ctx, 'auth.register.started', { metadata: { signupId: signup.publicId } }, tx);
    return { signup, email, phone };
  });

  if (emailTaken) sendNotice('EMAIL', input.email, 'ACCOUNT_EXISTS');
  else sendOtp('EMAIL', input.email, created.email.code, 'SIGNUP');
  if (phoneTaken) sendNotice('PHONE', input.phone, 'ACCOUNT_EXISTS');
  else sendOtp('PHONE', input.phone, created.phone.code, 'SIGNUP');

  return {
    signupId: created.signup.publicId,
    expiresAt: created.signup.expiresAt,
    challenges: [
      challengeView(created.email.publicId, 'EMAIL', maskDestination('EMAIL', input.email)),
      challengeView(created.phone.publicId, 'PHONE', maskDestination('PHONE', input.phone)),
    ],
  };
}

// ---------------------------------------------------------------------------------------------
// POST /auth/otp/send: resend a code for an existing challenge, or start a login / reset one.
// ---------------------------------------------------------------------------------------------
export async function sendOtpRequest(input: z.infer<typeof otpSendSchema>, ctx: ClientContext) {
  await consume(LIMITS.otpSendPerIp, ctx.ip);
  if ('challengeId' in input) return resendChallenge(input.challengeId);
  return startChallenge(input.purpose, input.identifier, ctx);
}

// Unknown and suspended accounts get a decoy challenge, so the response never reveals whether
// an email or phone is registered.
export async function startChallenge(purpose: Exclude<OtpPurpose, 'SIGNUP'>, identifier: Identifier, ctx: ClientContext) {
  const destinationHash = identifierHash(identifier);
  await consume(LIMITS.otpSendPerDestination, destinationHash);

  const [user] =
    identifier.channel === 'EMAIL'
      ? await sql<{ id: string }[]>`select id from app.users where email_hash = ${destinationHash} and status = 'ACTIVE'`
      : await sql<{ id: string }[]>`select id from app.users where phone_hash = ${destinationHash} and status = 'ACTIVE'`;

  const challenge = await transaction((tx) =>
    createChallenge(tx, {
      purpose,
      channel: identifier.channel,
      destinationHash,
      userId: user?.id ?? null,
      isDecoy: !user,
      ip: ctx.ip,
    }),
  );
  if (user) sendOtp(identifier.channel, identifier.value, challenge.code, purpose);
  if (purpose === 'PASSWORD_RESET') {
    await audit(ctx, 'auth.password.reset_requested', { userId: user?.id ?? null, metadata: { channel: identifier.channel } });
  }
  return challengeView(challenge.publicId, identifier.channel, maskDestination(identifier.channel, identifier.value));
}

type LockedChallenge = ChallengeRow & { destinationHash: string; expired: boolean; secondsSinceSent: number };

async function lockChallenge(tx: Db, publicId: string): Promise<LockedChallenge | undefined> {
  const [row] = await tx<LockedChallenge[]>`
    select id, public_id, purpose, channel, user_id, signup_request_id, is_decoy, code_hash, attempts,
           send_count, last_sent_at, expires_at, verified_at, destination_hash,
           expires_at <= now() as expired,
           extract(epoch from now() - last_sent_at)::float8 as seconds_since_sent
    from app.otp_challenges where public_id = ${publicId}
    for update`;
  return row;
}

// Where to send a fresh code: the pending sign-up's address, or the account's address.
async function challengeDestination(tx: Db, c: LockedChallenge): Promise<string | null> {
  if (c.isDecoy) return null;
  const column = c.channel === 'EMAIL' ? 'email_enc' : 'phone_enc';
  const context = c.channel === 'EMAIL' ? 'email' : 'phone';
  const [row] = c.signupRequestId
    ? await tx<{ value: string }[]>`select ${tx(column)} as value from app.signup_requests where id = ${c.signupRequestId}`
    : await tx<{ value: string }[]>`select ${tx(column)} as value from app.users where id = ${c.userId}`;
  return row ? decrypt(row.value, context) : null;
}

async function resendChallenge(publicId: string) {
  const sent = await transaction(async (tx) => {
    const c = await lockChallenge(tx, publicId);
    if (!c || c.verifiedAt) throw new AppError(400, 'OTP_CHALLENGE_INVALID', 'This verification has ended. Start again.');

    if (c.signupRequestId) {
      const [signup] = await tx<{ open: boolean }[]>`
        select completed_at is null and expires_at > now() as open
        from app.signup_requests where id = ${c.signupRequestId}`;
      if (!signup?.open) throw new AppError(410, 'SIGNUP_EXPIRED', 'This sign-up has expired. Please register again.');
    }
    if (c.secondsSinceSent < OTP_RESEND_COOLDOWN_SECONDS) {
      const wait = Math.ceil(OTP_RESEND_COOLDOWN_SECONDS - c.secondsSinceSent);
      throw new AppError(429, 'OTP_RESEND_COOLDOWN', `Please wait ${wait} seconds before requesting a new code.`, undefined, {
        'Retry-After': String(wait),
      });
    }
    if (c.sendCount >= OTP_MAX_SENDS) {
      throw new AppError(429, 'OTP_RESEND_LIMIT', 'Too many codes requested. Please start again.');
    }
    await consume(LIMITS.otpSendPerDestination, c.destinationHash, tx);

    const code = await reissueChallenge(tx, c);
    return { channel: c.channel, purpose: c.purpose, code, destination: await challengeDestination(tx, c) };
  });

  if (sent.destination) sendOtp(sent.channel, sent.destination, sent.code, sent.purpose);
  // No destination in the response: a decoy has none, and leaving it out keeps both identical.
  return challengeView(publicId, sent.channel);
}

// ---------------------------------------------------------------------------------------------
// POST /auth/otp/verify
// ---------------------------------------------------------------------------------------------
export async function verifyOtp(input: z.infer<typeof otpVerifySchema>, ctx: ClientContext) {
  await consume(LIMITS.otpVerifyPerIp, ctx.ip);

  const outcome = await transaction(async (tx) => {
    const c = await lockChallenge(tx, input.challengeId);
    if (!c || c.verifiedAt) return fail(new AppError(400, 'OTP_INVALID', 'Invalid or expired code'));
    if (c.expired) return fail(new AppError(400, 'OTP_EXPIRED', 'This code has expired. Request a new one.'));
    if (c.attempts >= OTP_MAX_ATTEMPTS) {
      return fail(new AppError(429, 'OTP_ATTEMPTS_EXCEEDED', 'Too many incorrect codes. Request a new one.'));
    }

    await tx`update app.otp_challenges set attempts = attempts + 1 where id = ${c.id}`;
    if (!codeMatches(c, input.code)) {
      const remaining = OTP_MAX_ATTEMPTS - c.attempts - 1;
      await audit(ctx, 'auth.otp.failed', { userId: c.userId, metadata: { purpose: c.purpose, remaining } }, tx);
      return fail(
        new AppError(400, 'OTP_INVALID', `Incorrect code. ${remaining} attempt${remaining === 1 ? '' : 's'} left.`, {
          code: 'Incorrect code',
        }),
      );
    }
    await tx`update app.otp_challenges set verified_at = now() where id = ${c.id}`;

    if (c.purpose === 'SIGNUP') return completeSignupStep(tx, c, input.device, ctx);
    if (c.purpose === 'LOGIN') return completeOtpLogin(tx, c, input.device, ctx);
    return issueResetToken(tx, c);
  });

  return unwrap(outcome);
}

async function completeSignupStep(tx: Db, c: LockedChallenge, device: DeviceInfo, ctx: ClientContext) {
  const [s] = await tx<
    {
      id: string;
      publicId: string;
      name: string;
      emailEnc: string;
      emailHash: string;
      phoneCountryCode: string;
      phoneEnc: string;
      phoneHash: string;
      passwordHash: string;
      ageConfirmedAt: Date;
      emailVerifiedAt: Date | null;
      phoneVerifiedAt: Date | null;
      open: boolean;
      createdIp: string | null;
      userAgent: string | null;
      appVersion: string | null;
    }[]
  >`
    select id, public_id, name, email_enc, email_hash, phone_country_code, phone_enc, phone_hash,
           password_hash, age_confirmed_at, email_verified_at, phone_verified_at, created_ip, user_agent,
           app_version, completed_at is null and expires_at > now() as open
    from app.signup_requests where id = ${c.signupRequestId}
    for update`;
  if (!s?.open) return fail(new AppError(410, 'SIGNUP_EXPIRED', 'This sign-up has expired. Please register again.'));

  const emailVerifiedAt = c.channel === 'EMAIL' ? new Date() : s.emailVerifiedAt;
  const phoneVerifiedAt = c.channel === 'PHONE' ? new Date() : s.phoneVerifiedAt;
  await tx`
    update app.signup_requests set email_verified_at = ${emailVerifiedAt}, phone_verified_at = ${phoneVerifiedAt}
    where id = ${s.id}`;

  if (!emailVerifiedAt || !phoneVerifiedAt) {
    return ok({
      status: 'PENDING' as const,
      signupId: s.publicId,
      verified: [emailVerifiedAt && 'EMAIL', phoneVerifiedAt && 'PHONE'].filter(Boolean) as Channel[],
      pending: [!emailVerifiedAt && 'EMAIL', !phoneVerifiedAt && 'PHONE'].filter(Boolean) as Channel[],
    });
  }

  // Both verified: create the account. A unique conflict means someone else completed sign-up
  // with this email or phone first; the caller has proven they own both, so saying so is safe.
  const [user] = await tx<{ id: string; publicId: string }[]>`
    insert into app.users (email_enc, email_hash, phone_country_code, phone_enc, phone_hash, password_hash,
      email_verified_at, phone_verified_at)
    values (${s.emailEnc}, ${s.emailHash}, ${s.phoneCountryCode}, ${s.phoneEnc}, ${s.phoneHash},
      ${s.passwordHash}, ${emailVerifiedAt}, ${phoneVerifiedAt})
    on conflict do nothing
    returning id, public_id`;
  if (!user) {
    return fail(
      new AppError(409, 'ACCOUNT_EXISTS', 'An account with this email or phone already exists. Log in or reset your password.'),
    );
  }

  await tx`insert into app.user_profiles (user_id, name) values (${user.id}, ${s.name})`;
  await tx`
    insert into app.consents (user_id, type, version, accepted_at, ip, user_agent, app_version)
    values (${user.id}, 'AGE_18_PLUS', ${AGE_CONSENT_VERSION}, ${s.ageConfirmedAt}, ${s.createdIp},
      ${s.userAgent}, ${s.appVersion})`;
  // The pending copy (and any other open sign-ups for the same email or phone) is no longer needed.
  await tx`
    delete from app.signup_requests
    where id = ${s.id} or (completed_at is null and (email_hash = ${s.emailHash} or phone_hash = ${s.phoneHash}))`;

  const tokens = await createSession(tx, user, device, ctx);
  await audit(ctx, 'auth.register.completed', { userId: user.id }, tx);
  return ok({ status: 'COMPLETED' as const, user: await loadUser(user.id, tx), tokens });
}

async function completeOtpLogin(tx: Db, c: LockedChallenge, device: DeviceInfo, ctx: ClientContext) {
  const [user] = await tx<{ id: string; publicId: string }[]>`
    select id, public_id from app.users where id = ${c.userId} and status = 'ACTIVE' for update`;
  if (!user) return fail(new AppError(400, 'OTP_INVALID', 'Invalid or expired code'));

  const tokens = await createSession(tx, user, device, ctx);
  await audit(ctx, 'auth.otp.login', { userId: user.id, metadata: { channel: c.channel } }, tx);
  return ok({ status: 'COMPLETED' as const, user: await loadUser(user.id, tx), tokens });
}

async function issueResetToken(tx: Db, c: LockedChallenge) {
  const token = randomToken();
  // Only the newest reset token for a user is valid.
  await tx`update app.password_reset_tickets set used_at = now() where user_id = ${c.userId} and used_at is null`;
  await tx`
    insert into app.password_reset_tickets (token_hash, user_id, challenge_id, expires_at)
    values (${sha256(token)}, ${c.userId}, ${c.id}, now() + make_interval(secs => ${RESET_TOKEN_TTL_SECONDS}))`;
  return ok({ status: 'RESET_TOKEN_ISSUED' as const, resetToken: token, resetTokenExpiresIn: RESET_TOKEN_TTL_SECONDS });
}

// ---------------------------------------------------------------------------------------------
// POST /auth/login. One generic error for unknown accounts and wrong passwords; 5 failures per
// email/phone in 15 minutes lock that identifier, whether or not an account exists.
// ---------------------------------------------------------------------------------------------
export async function login(input: z.infer<typeof loginSchema>, ctx: ClientContext) {
  await consume(LIMITS.loginPerIp, ctx.ip);
  const idHash = identifierHash(input.identifier);
  await assertNotLimited(LIMITS.loginFailuresPerAccount, idHash);

  const [user] =
    input.identifier.channel === 'EMAIL'
      ? await sql<{ id: string; publicId: string; passwordHash: string; status: string }[]>`
          select id, public_id, password_hash, status from app.users
          where email_hash = ${idHash} and status <> 'DELETED'`
      : await sql<{ id: string; publicId: string; passwordHash: string; status: string }[]>`
          select id, public_id, password_hash, status from app.users
          where phone_hash = ${idHash} and status <> 'DELETED'`;

  let valid = false;
  if (user) valid = await verifyPassword(user.passwordHash, input.password);
  else await burnPasswordCheck(input.password);

  if (!user || !valid) {
    await consume(LIMITS.loginFailuresPerAccount, idHash);
    await audit(ctx, 'auth.login.failed', { userId: user?.id ?? null, metadata: { channel: input.identifier.channel } });
    throw new AppError(401, 'INVALID_CREDENTIALS', 'Incorrect email/phone or password');
  }
  // Only revealed to someone who knows the password.
  if (user.status === 'SUSPENDED') {
    throw new AppError(403, 'ACCOUNT_SUSPENDED', 'This account is suspended. Please contact support.');
  }

  await reset(LIMITS.loginFailuresPerAccount, idHash);
  const tokens = await transaction(async (tx) => {
    const pair = await createSession(tx, user, input.device, ctx);
    await audit(ctx, 'auth.login.succeeded', { userId: user.id }, tx);
    return pair;
  });
  return { user: await loadUser(user.id), tokens };
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

  const outcome = await transaction(async (tx) => {
    const [s] = await tx<
      {
        id: string;
        publicId: string;
        userId: string;
        refreshTokenHash: string;
        previousRefreshTokenHash: string | null;
        revokedAt: Date | null;
        expired: boolean;
        absoluteExpiresAt: Date;
        userPublicId: string;
        userStatus: string;
      }[]
    >`
      select s.id, s.public_id, s.user_id, s.refresh_token_hash, s.previous_refresh_token_hash, s.revoked_at,
             s.expires_at <= now() or s.absolute_expires_at <= now() as expired, s.absolute_expires_at,
             u.public_id as user_public_id, u.status as user_status
      from app.user_sessions s join app.users u on u.id = s.user_id
      where s.public_id = ${parsed.sessionPublicId}
      for update of s`;
    if (!s) return fail(invalid);

    if (s.previousRefreshTokenHash && safeEqualHex(s.previousRefreshTokenHash, parsed.secretHash)) {
      if (!s.revokedAt) {
        await tx`update app.user_sessions set revoked_at = now(), revoked_reason = 'TOKEN_REUSE' where id = ${s.id}`;
        await audit(ctx, 'auth.refresh.reuse_detected', { userId: s.userId, metadata: { session: s.publicId } }, tx);
      }
      return fail(invalid);
    }
    if (!safeEqualHex(s.refreshTokenHash, parsed.secretHash) || s.revokedAt || s.expired || s.userStatus !== 'ACTIVE') {
      return fail(invalid);
    }
    return ok(await rotateSession(tx, s, s.userPublicId, ctx));
  });

  return { tokens: unwrap(outcome) };
}

// ---------------------------------------------------------------------------------------------
// Signed-in session management
// ---------------------------------------------------------------------------------------------
export async function logout(auth: AuthContext, ctx: ClientContext) {
  await sql`
    update app.user_sessions set revoked_at = now(), revoked_reason = 'LOGOUT'
    where id = ${auth.sessionId} and revoked_at is null`;
  await audit(ctx, 'auth.logout', { userId: auth.userId });
}

export async function listSessions(auth: AuthContext) {
  const rows = await sql<
    {
      id: string;
      deviceName: string | null;
      platform: string;
      appVersion: string | null;
      ip: string | null;
      createdAt: Date;
      lastUsedAt: Date;
    }[]
  >`
    select public_id as id, device_name, platform, app_version, ip::text as ip, created_at, last_used_at
    from app.user_sessions
    where user_id = ${auth.userId} and revoked_at is null
      and expires_at > now() and absolute_expires_at > now()
    order by last_used_at desc`;
  return rows.map((r) => ({ ...r, current: r.id === auth.sessionPublicId }));
}

export async function revokeSession(auth: AuthContext, sessionPublicId: string, ctx: ClientContext) {
  const rows = await sql`
    update app.user_sessions set revoked_at = now(), revoked_reason = 'REVOKED_BY_USER'
    where user_id = ${auth.userId} and public_id = ${sessionPublicId} and revoked_at is null
    returning id`;
  if (rows.length === 0) throw new AppError(404, 'SESSION_NOT_FOUND', 'Session not found');
  await audit(ctx, 'auth.session.revoked', { userId: auth.userId, metadata: { session: sessionPublicId } });
}

export async function revokeOtherSessions(auth: AuthContext, ctx: ClientContext) {
  await revokeAllSessions(sql, auth.userId, 'REVOKED_BY_USER', auth.sessionId);
  await audit(ctx, 'auth.session.revoked', { userId: auth.userId, metadata: { scope: 'others' } });
}

// ---------------------------------------------------------------------------------------------
// POST /auth/password/reset. Sets the new password, ends every session, and tells the user.
// ---------------------------------------------------------------------------------------------
export async function resetPassword(input: z.infer<typeof resetPasswordSchema>, ctx: ClientContext) {
  await consume(LIMITS.passwordResetPerIp, ctx.ip);

  const done = await transaction(async (tx) => {
    const [t] = await tx<
      {
        id: string;
        userId: string;
        passwordHash: string;
        emailEnc: string;
        phoneEnc: string;
        status: string;
        usable: boolean;
      }[]
    >`
      select t.id, t.user_id, u.password_hash, u.email_enc, u.phone_enc, u.status,
             t.used_at is null and t.expires_at > now() as usable
      from app.password_reset_tickets t join app.users u on u.id = t.user_id
      where t.token_hash = ${sha256(input.resetToken)}
      for update of t, u`;
    if (!t?.usable || t.status !== 'ACTIVE') {
      throw new AppError(400, 'RESET_TOKEN_INVALID', 'This reset has expired. Please request a new code.');
    }

    const email = decrypt(t.emailEnc, 'email');
    const phone = decrypt(t.phoneEnc, 'phone');
    if (passwordContainsIdentity(input.newPassword, email, phone)) {
      throw fieldError('newPassword', 'Password must not contain your email name or phone number');
    }
    if (await verifyPassword(t.passwordHash, input.newPassword)) {
      throw fieldError('newPassword', 'New password must be different from your current password');
    }

    await tx`
      update app.users set password_hash = ${await hashPassword(input.newPassword)}, password_changed_at = now()
      where id = ${t.userId}`;
    await tx`update app.password_reset_tickets set used_at = now() where user_id = ${t.userId} and used_at is null`;
    await revokeAllSessions(tx, t.userId, 'PASSWORD_RESET');
    await audit(ctx, 'auth.password.reset', { userId: t.userId }, tx);
    return { email, phone };
  });

  // A fresh password clears any login lock on this account.
  await reset(LIMITS.loginFailuresPerAccount, emailHash(done.email));
  await reset(LIMITS.loginFailuresPerAccount, phoneHash(done.phone));
  sendNotice('EMAIL', done.email, 'PASSWORD_CHANGED');
  return { passwordReset: true };
}
