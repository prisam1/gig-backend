// Runs every migration in an in-memory Postgres (PGlite) and exercises the app_* database
// functions the API calls through supabase-js: sign-up, OTP, login, refresh, password reset,
// profile, tier, KYC, rate limits, and who may call them.

import { PGlite } from '@electric-sql/pglite';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LOOKUP_TYPES } from '../../src/modules/users/users.schemas';

const ROOT = join(__dirname, '..', '..');
const CTX = { ip: '203.0.113.7', userAgent: 'vitest', appVersion: '1.0.0', requestId: 'req-1' };
const SESSION_CONFIG = { platform: 'IOS', deviceName: 'Test phone', idleDays: 30, maxDays: 90, maxActive: 10 };

let db: PGlite;

/** Calls public.<fn>(args...) and returns its result. */
async function call<T = Record<string, unknown>>(fn: string, ...args: unknown[]): Promise<T> {
  const params = args.map((a) => (a !== null && typeof a === 'object' ? JSON.stringify(a) : a));
  const placeholders = params.map((_, i) => `$${i + 1}`).join(', ');
  const { rows } = await db.query<{ r: T }>(`select public.${fn}(${placeholders}) as r`, params);
  return rows[0]!.r;
}

async function one<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T> {
  const { rows } = await db.query<T>(sql, params);
  if (!rows[0]) throw new Error(`no row for: ${sql}`);
  return rows[0];
}

const challenge = (id = randomUUID()) => ({ publicId: id, codeHash: `code:${id}`, decoyHash: `decoy:${id}` });
const session = () => ({ ...SESSION_CONFIG, publicId: randomUUID(), refreshHash: `refresh:${randomUUID()}` });
const verify = (c: { publicId: string; codeHash: string }, codeHash = c.codeHash, limits: unknown[] = [], s = session()) =>
  call('app_otp_verify', c.publicId, codeHash, 5, limits, s, { tokenHash: `reset:${c.publicId}`, ttlSeconds: 600 }, '2026-10-27', CTX);

/** Signs up a user with both codes verified; returns ids and the first session. */
async function signUp(tag: string) {
  const email = challenge();
  const phone = challenge();
  await call('app_signup_start', {
    name: `User ${tag}`, emailEnc: `enc-email-${tag}`, emailHash: `email-${tag}`, countryCode: '+91',
    phoneEnc: `enc-phone-${tag}`, phoneHash: `phone-${tag}`, passwordHash: `argon-${tag}`,
    ttlSeconds: 3600, otpTtlSeconds: 300,
  }, email, phone, CTX);
  await verify(email);
  const s = session();
  const done = await verify(phone, phone.codeHash, [], s);
  return { ...(done as { userId: string; userPublicId: string }), session: s };
}

beforeAll(async () => {
  db = new PGlite({ extensions: { pg_trgm } });
  // Minimal stand-ins for what Supabase provides.
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create schema extensions; create schema auth; create schema storage;
    create table auth.users (id uuid primary key, raw_user_meta_data jsonb);
    create table storage.buckets (id text primary key, name text, public boolean,
      file_size_limit bigint, allowed_mime_types text[]);
  `);
  const dir = join(ROOT, 'supabase', 'migrations');
  for (const file of readdirSync(dir).sort()) {
    await db.exec(readFileSync(join(dir, file), 'utf8'));
  }
});

afterAll(async () => {
  await db.close();
});

describe('who may call the functions', () => {
  it('lets only the service role run the app_* functions', async () => {
    const r = await one<{ anon: boolean; authenticated: boolean; service: boolean }>(`
      select has_function_privilege('anon', 'public.app_member(uuid, uuid)', 'EXECUTE') as anon,
             has_function_privilege('authenticated', 'public.app_member(uuid, uuid)', 'EXECUTE') as authenticated,
             has_function_privilege('service_role', 'public.app_member(uuid, uuid)', 'EXECUTE') as service`);
    expect(r).toEqual({ anon: false, authenticated: false, service: true });
  });

  it('lets the public roles run no function at all, including ones added by later migrations', async () => {
    const { rows } = await db.query<{ fn: string }>(`
      select n.nspname || '.' || p.proname as fn
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname in ('public', 'app')
        and (has_function_privilege('anon', p.oid, 'EXECUTE')
             or has_function_privilege('authenticated', p.oid, 'EXECUTE'))`);
    expect(rows).toEqual([]);
  });

  it('gives no API role, not even the service role, direct access to the app schema', async () => {
    const r = await one<{ anon: boolean; authenticated: boolean; service: boolean }>(`
      select has_schema_privilege('anon', 'app', 'USAGE') as anon,
             has_schema_privilege('authenticated', 'app', 'USAGE') as authenticated,
             has_schema_privilege('service_role', 'app', 'USAGE') as service`);
    expect(r).toEqual({ anon: false, authenticated: false, service: false });
  });

  it('keeps every app_* function security definer with a fixed search_path', async () => {
    const { rows } = await db.query<{ proname: string }>(`
      select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname like 'app\\_%'
        and (not p.prosecdef or not coalesce('search_path=""' = any (p.proconfig), false))`);
    expect(rows).toEqual([]);
  });
});

describe('rate limits', () => {
  it('counts hits and reports when the limit is passed', async () => {
    const key = `test:${randomUUID()}`;
    expect((await call<{ limited: boolean }>('app_rate_limit_hit', key, 2, 60)).limited).toBe(false);
    expect((await call<{ limited: boolean }>('app_rate_limit_hit', key, 2, 60)).limited).toBe(false);
    const third = await call<{ limited: boolean; retryAfter: number }>('app_rate_limit_hit', key, 2, 60);
    expect(third.limited).toBe(true);
    expect(third.retryAfter).toBeGreaterThan(0);

    await db.query('select public.app_rate_limit_reset($1)', [[key]]);
    expect((await call<{ limited: boolean }>('app_rate_limit_hit', key, 2, 60)).limited).toBe(false);
  });
});

describe('sign-up', () => {
  it('creates the account only after both the email and the phone are verified', async () => {
    const email = challenge();
    const phone = challenge();
    const started = await call<{ signupId: string }>('app_signup_start', {
      name: 'Asha Rao', emailEnc: 'enc-email-a', emailHash: 'email-a', countryCode: '+91',
      phoneEnc: 'enc-phone-a', phoneHash: 'phone-a', passwordHash: 'argon-a', ttlSeconds: 3600, otpTtlSeconds: 300,
    }, email, phone, CTX);
    expect(started).toEqual({ signupId: expect.any(String), expiresAt: expect.any(String) });

    expect(await verify(email, 'wrong')).toEqual({ error: 'OTP_INCORRECT', remaining: 4 });
    expect(await verify(email)).toEqual({
      status: 'PENDING', signupId: started.signupId, verified: ['EMAIL'], pending: ['PHONE'],
    });
    expect(await one(`select count(*)::int as n from app.users where email_hash = 'email-a'`)).toEqual({ n: 0 });

    const s = session();
    const done = await verify(phone, phone.codeHash, [], s);
    expect(done).toMatchObject({ status: 'COMPLETED', userId: expect.any(String), userPublicId: expect.any(String) });

    const user = await one(`
      select u.email_enc, u.password_hash, p.name, c.type as consent, s.refresh_token_hash, s.platform
      from app.users u join app.user_profiles p on p.user_id = u.id
      join app.consents c on c.user_id = u.id join app.user_sessions s on s.user_id = u.id
      where u.email_hash = 'email-a'`);
    expect(user).toEqual({
      email_enc: 'enc-email-a', password_hash: 'argon-a', name: 'Asha Rao', consent: 'AGE_18_PLUS',
      refresh_token_hash: s.refreshHash, platform: 'IOS',
    });
    expect(await one(`select count(*)::int as n from app.signup_requests where email_hash = 'email-a'`)).toEqual({ n: 0 });
    // A used code cannot be used again.
    expect(await verify(phone)).toEqual({ error: 'OTP_INVALID' });
  });

  it('refuses an email or phone that already belongs to an account, storing nothing', async () => {
    await signUp('taken');
    const start = (emailHash: string, phoneHash: string) => {
      const email = challenge();
      return call('app_signup_start', {
        name: 'Someone Else', emailEnc: 'x', emailHash, countryCode: '+91',
        phoneEnc: 'y', phoneHash, passwordHash: 'z', ttlSeconds: 3600, otpTtlSeconds: 300,
      }, email, challenge(), CTX);
    };
    expect(await start('email-taken', 'phone-new')).toEqual({ taken: { email: true, phone: false } });
    expect(await start('email-new', 'phone-taken')).toEqual({ taken: { email: false, phone: true } });
    expect(await start('email-taken', 'phone-taken')).toEqual({ taken: { email: true, phone: true } });
    expect(await one(`select count(*)::int as n from app.signup_requests where name = 'Someone Else'`)).toEqual({ n: 0 });
    expect(await one(`select count(*)::int as n from app.otp_challenges where destination_hash in ('email-taken', 'phone-new', 'email-new')`))
      .toEqual({ n: 0 });
  });

  it('tells sign-up step 1 which addresses are taken', async () => {
    await signUp('check');
    expect(await call('app_contact_taken', 'email-check', 'phone-free')).toEqual({ emailTaken: true, phoneTaken: false });
    expect(await call('app_contact_taken', 'email-free', 'phone-check')).toEqual({ emailTaken: false, phoneTaken: true });
    expect(await call('app_contact_taken', 'email-free', 'phone-free')).toEqual({ emailTaken: false, phoneTaken: false });
    // One address on its own (the app checks each field as soon as it is complete).
    expect(await call('app_contact_taken', 'email-check', null)).toEqual({ emailTaken: true, phoneTaken: false });
    expect(await call('app_contact_taken', null, 'phone-check')).toEqual({ emailTaken: false, phoneTaken: true });
  });
});

describe('OTP guessing', () => {
  it('refuses a code after 5 wrong attempts, even the right one', async () => {
    const { userId } = await signUp('attempts');
    expect(userId).toBeDefined();
    const c = challenge();
    await call('app_otp_start', 'PASSWORD_RESET', 'EMAIL', 'email-attempts', c, 300, CTX);
    for (let i = 0; i < 5; i++) await verify(c, 'wrong');
    expect(await verify(c)).toEqual({ error: 'OTP_ATTEMPTS_EXCEEDED' });
  });

  it('applies the per-address guess limit across challenges, even for the right code', async () => {
    await signUp('limit');
    const limits = [{ key: `otp-verify:${randomUUID()}`, max: 2, window: 3600 }];
    const first = challenge();
    await call('app_otp_start', 'PASSWORD_RESET', 'EMAIL', 'email-limit', first, 300, CTX);
    await verify(first, 'wrong', limits);
    await verify(first, 'wrong', limits);

    const second = challenge();
    await call('app_otp_start', 'PASSWORD_RESET', 'EMAIL', 'email-limit', second, 300, CTX);
    expect(await verify(second, second.codeHash, limits)).toMatchObject({ error: 'RATE_LIMITED' });
  });

  it('keeps only the newest reset code for an address valid', async () => {
    await signUp('newest');
    const older = challenge();
    const newer = challenge();
    await call('app_otp_start', 'PASSWORD_RESET', 'EMAIL', 'email-newest', older, 300, CTX);
    await call('app_otp_start', 'PASSWORD_RESET', 'EMAIL', 'email-newest', newer, 300, CTX);

    expect(await verify(older)).toEqual({ error: 'OTP_EXPIRED' });
    expect(await verify(newer)).toEqual({ status: 'RESET_TOKEN_ISSUED' });
  });

  it('starts no reset for an address without an account, and audits the attempt', async () => {
    const c = challenge();
    expect(await call('app_otp_start', 'PASSWORD_RESET', 'EMAIL', 'email-nobody', c, 300, CTX)).toEqual({ userExists: false });
    expect(await one(`select count(*)::int as n from app.otp_challenges where destination_hash = 'email-nobody'`)).toEqual({ n: 0 });
    expect(await verify(c)).toMatchObject({ error: 'OTP_INVALID' });
    expect(await one(`select count(*)::int as n from app.audit_logs where action = 'auth.password.reset_unknown_account'`))
      .toEqual({ n: 1 });
  });

  it('has no OTP login: only sign-up and password-reset challenges exist', async () => {
    await signUp('no-otp-login');
    await expect(call('app_otp_start', 'LOGIN', 'EMAIL', 'email-no-otp-login', challenge(), 300, CTX)).rejects.toThrow(/invalid purpose/);
    await expect(db.query(
      `insert into app.otp_challenges (public_id, purpose, channel, destination_hash, is_decoy, code_hash, expires_at)
       values ($1, 'LOGIN', 'EMAIL', 'x', true, 'y', now() + interval '5 minutes')`,
      [randomUUID()],
    )).rejects.toThrow(/otp_challenges_purpose_check/);
  });
});

describe('sessions', () => {
  it('resolves an active session to its member and stops after logout', async () => {
    const { userId, userPublicId, session: s } = await signUp('member');
    const member = await call('app_member', userPublicId, s.publicId);
    expect(member).toMatchObject({ userId, userPublicId, tier: 'OBSERVER', kycStatus: 'NOT_STARTED', fullName: 'User member' });

    // A session of another user never resolves, even with a valid session id.
    const other = await signUp('member-other');
    expect(await call('app_member', other.userPublicId, s.publicId)).toBeNull();

    await call('app_logout', userId, member['sessionId'], CTX);
    expect(await call('app_member', userPublicId, s.publicId)).toBeNull();
  });

  it('rotates refresh tokens and revokes the session when an old one is reused', async () => {
    const { userPublicId, session: s } = await signUp('refresh');
    const rotated = await call('app_refresh', s.publicId, s.refreshHash, 'refresh-2', 30, CTX);
    expect(rotated).toMatchObject({ userPublicId, sessionExpiresAt: expect.any(String) });

    // The old token again: theft. The session is revoked, and even the new token stops working.
    expect(await call('app_refresh', s.publicId, s.refreshHash, 'refresh-3', 30, CTX)).toEqual({ error: 'INVALID' });
    expect(await one(`select revoked_reason from app.user_sessions where public_id = $1`, [s.publicId])).toEqual({
      revoked_reason: 'TOKEN_REUSE',
    });
    expect(await call('app_refresh', s.publicId, 'refresh-2', 'refresh-4', 30, CTX)).toEqual({ error: 'INVALID' });
    expect(await call('app_member', userPublicId, s.publicId)).toBeNull();
  });

  it('creates a session after a correct password, and not for a suspended account', async () => {
    const { userId } = await signUp('login');
    const lookup = await call<{ passwordHash: string }>('app_login_lookup', 'EMAIL', 'email-login');
    expect(lookup.passwordHash).toBe('argon-login');
    expect(await call('app_login_complete', userId, session(), CTX)).toMatchObject({ sessionExpiresAt: expect.any(String) });

    await db.query(`update app.users set status = 'SUSPENDED' where id = $1`, [userId]);
    expect(await call('app_login_complete', userId, session(), CTX)).toEqual({ error: 'INVALID' });
  });
});

describe('password reset', () => {
  it('issues a single-use ticket, changes the password and ends every session', async () => {
    const { userPublicId, session: s } = await signUp('reset');
    const c = challenge();
    await call('app_otp_start', 'PASSWORD_RESET', 'EMAIL', 'email-reset', c, 300, CTX);
    expect(await verify(c)).toEqual({ status: 'RESET_TOKEN_ISSUED' });

    const tokenHash = `reset:${c.publicId}`;
    expect(await call('app_reset_lookup', tokenHash)).toMatchObject({ passwordHash: 'argon-reset' });
    expect(await call('app_reset_complete', tokenHash, 'argon-new', CTX)).toEqual({ ok: true });
    expect(await one(`select password_hash from app.users where public_id = $1`, [userPublicId])).toEqual({
      password_hash: 'argon-new',
    });
    expect(await call('app_member', userPublicId, s.publicId)).toBeNull();

    // The ticket is used up.
    expect(await call('app_reset_lookup', tokenHash)).toBeNull();
    expect(await call('app_reset_complete', tokenHash, 'argon-again', CTX)).toEqual({ ok: false });
  });
});

describe('profile and KYC', () => {
  it("validates profile edits and keeps one open KYC submission of the user's own files", async () => {
    const { userId } = await signUp('tier');
    // Which codes exist is checked by the API (src/constants/onboarding.ts); the database keeps the
    // code's format and the Others rule.
    await expect(call('app_update_profile', userId, { jobProfile: 'not a code' }, CTX)).rejects.toThrow(/user_profiles_job_profile_code_check/);
    expect(await call('app_update_profile', userId, { jobProfile: 'OTHERS' }, CTX)).toEqual({
      fields: { otherJob: 'Specify your job profile' },
    });
    const job = 'BUSINESS_OWNER';
    expect(await call('app_update_profile', userId, { jobProfile: job, otherJob: 'Pilot' }, CTX)).toEqual({
      fields: { otherJob: 'Only allowed when the job profile is Others' },
    });
    expect(await call('app_update_profile', userId, { jobProfile: job, experienceYears: 5, location: 'Mumbai' }, CTX)).toEqual({ ok: true });

    // KYC for the tier chosen at sign-up: one open submission, the user's own KYC files only.
    await db.query(`update app.users set requested_tier = 'PRIVE' where id = $1`, [userId]);
    const own = await call<{ id: string; publicId: string }>('app_create_file', userId, 'KYC_DOCUMENT', 'kyc-documents', `${randomUUID()}/id.pdf`, 'application/pdf', 1000);
    const avatar = await call<{ id: string }>('app_create_file', userId, 'AVATAR', 'avatars', `${randomUUID()}/a.png`, 'image/png', 1000);
    const stranger = await signUp('kyc-stranger');
    const foreign = await call<{ id: string }>('app_create_file', stranger.userId, 'KYC_DOCUMENT', 'kyc-documents', `${randomUUID()}/x.pdf`, 'application/pdf', 1000);

    await expect(call('app_kyc_submit', userId, 'PRIVE', [{ fileId: foreign.id, documentType: 'ID_PROOF' }], '2026-10', CTX)).rejects.toThrow(/does not belong/);
    await expect(call('app_kyc_submit', userId, 'PRIVE', [{ fileId: avatar.id, documentType: 'ID_PROOF' }], '2026-10', CTX)).rejects.toThrow(/does not belong/);

    const submissionId = await call<string>('app_kyc_submit', userId, 'PRIVE', [{ fileId: own.id, documentType: 'ID_PROOF' }], '2026-10', CTX);
    expect(submissionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(await one(`select kyc_status from app.users where id = $1`, [userId])).toEqual({ kyc_status: 'PENDING' });
    expect(await one(`select count(*)::int as n from app.consents where user_id = $1 and type = 'KYC'`, [userId])).toEqual({ n: 1 });
    await expect(call('app_kyc_submit', userId, 'PRIVE', [{ fileId: own.id, documentType: 'ID_PROOF' }], null, CTX)).rejects.toThrow(/duplicate key|unique/);

    expect(await one(
      `select s.status, d.file_id::text as file_id, d.document_type from app.kyc_submissions s
       join app.kyc_documents d on d.submission_id = s.id where s.public_id = $1`,
      [submissionId],
    )).toEqual({ status: 'PENDING', file_id: own.id, document_type: 'ID_PROOF' });

    // Avatars must be the user's own AVATAR upload.
    expect(await call('app_update_profile', userId, { avatarFileId: foreign.id }, CTX)).toEqual({
      fields: { avatarFileId: 'Upload the avatar with purpose AVATAR first' },
    });
    expect(await call('app_update_profile', userId, { avatarFileId: avatar.id }, CTX)).toEqual({ ok: true });
  });
});

describe("sign-up in the app's order (all screens first, OTP last)", () => {
  function onboarding(tier: string) {
    return {
      profile: { experienceYears: 5, jobProfile: 'BUSINESS_OWNER', location: 'Mumbai' },
      preferences: {
        focus: ['REAL_ASSETS'],
        risk: ['LOW_LEVEL'],
        style: ['ARBITRAGE', 'BUY_AND_HOLD'],
        sector: ['PRIVATE_EQUITIES'],
      },
      tier,
    };
  }

  const start = (tag: string, data: unknown, email: object | null = challenge(), phone: object | null = challenge()) =>
    call('app_signup_start', {
      name: `User ${tag}`, emailEnc: `enc-email-${tag}`, emailHash: `email-${tag}`, countryCode: '+91',
      phoneEnc: `enc-phone-${tag}`, phoneHash: `phone-${tag}`, passwordHash: `argon-${tag}`,
      ttlSeconds: 3600, otpTtlSeconds: 300, onboarding: data,
    }, email, phone, CTX);

  it('creates the account with profile, preferences and the requested tier in one step', async () => {
    const email = challenge();
    const phone = challenge();
    expect(await start('app-order', onboarding('PRIVE'), email, phone)).toMatchObject({ signupId: expect.any(String) });
    await verify(email);
    const done = await verify(phone);
    expect(done).toMatchObject({ status: 'COMPLETED' });

    const userId = (done as { userId: string }).userId;
    expect(await one(
      `select u.tier, u.requested_tier, u.tier_selected_at is not null as tier_selected,
              p.experience_years, p.location, p.job_profile_code is not null as has_job,
              (select count(distinct type)::int from app.user_preferences where user_id = u.id) as preference_types,
              (select count(*)::int from app.tier_history where user_id = u.id) as history
       from app.users u join app.user_profiles p on p.user_id = u.id where u.id = $1`,
      [userId],
    )).toEqual({
      // Prive is only requested; it is granted when KYC is approved.
      tier: 'OBSERVER', requested_tier: 'PRIVE', tier_selected: true,
      experience_years: 5, location: 'Mumbai', has_job: true, preference_types: 4, history: 1,
    });

    // GET /me gets the codes the user chose; the app shows its own labels.
    const user = await call<{ jobProfileCode: string; preferences: { type: string; code: string }[] }>('app_get_user', userId);
    expect(user.jobProfileCode).toBe('BUSINESS_OWNER');
    expect(user).not.toHaveProperty('jobProfileLabel');
    expect(user.preferences).toEqual([
      { type: 'INVESTMENT_FOCUS', code: 'REAL_ASSETS' },
      { type: 'INVESTMENT_SECTOR', code: 'PRIVATE_EQUITIES' },
      { type: 'INVESTMENT_STYLE', code: 'ARBITRAGE' },
      { type: 'INVESTMENT_STYLE', code: 'BUY_AND_HOLD' },
      { type: 'RISK_LEVEL', code: 'LOW_LEVEL' },
    ]);
  });

  it('grants Observer at once', async () => {
    const email = challenge();
    const phone = challenge();
    await start('app-order-observer', onboarding('OBSERVER'), email, phone);
    await verify(email);
    const done = (await verify(phone)) as { userId: string };
    expect(await one(`select tier, requested_tier, tier_selected_at is not null as selected from app.users where id = $1`, [done.userId]))
      .toEqual({ tier: 'OBSERVER', requested_tier: null, selected: true });
  });

  it('refuses the Others text with another job profile before anything is stored or sent', async () => {
    const data = onboarding('OBSERVER');
    expect(await start('bad-other', { ...data, profile: { ...data.profile, otherJob: 'Pilot' } }))
      .toEqual({ fields: { 'profile.otherJob': 'Only allowed when the job profile is Others' } });
    expect(await one(`select count(*)::int as n from app.signup_requests where email_hash like 'email-bad-%'`)).toEqual({ n: 0 });
  });

  it('creates a Prive account with the phone code alone when no email code was issued', async () => {
    const phone = challenge();
    await start('prive-phone', onboarding('PRIVE'), null, phone);
    const done = (await verify(phone)) as { status: string; userId: string };
    expect(done).toMatchObject({ status: 'COMPLETED' });
    expect(await one(
      `select requested_tier, email_verified_at is null as email_unverified, phone_verified_at is not null as phone_verified
       from app.users where id = $1`,
      [done.userId],
    )).toEqual({ requested_tier: 'PRIVE', email_unverified: true, phone_verified: true });
  });

  it('still needs both codes when both were issued', async () => {
    const email = challenge();
    const phone = challenge();
    await start('both-needed', onboarding('OBSERVER'), email, phone);
    expect(await verify(phone)).toMatchObject({ status: 'PENDING', verified: ['PHONE'], pending: ['EMAIL'] });
  });

  it('creates an Institutional account and its session at once, with no code', async () => {
    const s = session();
    const done = await call<{ status: string; userId: string; userPublicId: string }>('app_signup_create', {
      name: 'User inst', emailEnc: 'enc-email-inst', emailHash: 'email-inst', countryCode: '+91',
      phoneEnc: 'enc-phone-inst', phoneHash: 'phone-inst', passwordHash: 'argon-inst',
      ttlSeconds: 3600, otpTtlSeconds: 300, onboarding: onboarding('INSTITUTIONAL'),
    }, s, '2026-10-27', CTX);
    expect(done).toMatchObject({ status: 'COMPLETED', sessionExpiresAt: expect.any(String) });
    expect(await one(
      `select requested_tier, email_verified_at is null and phone_verified_at is null as unverified,
              (select count(*)::int from app.otp_challenges where destination_hash in ('email-inst', 'phone-inst')) as codes,
              (select count(*)::int from app.signup_requests where email_hash = 'email-inst') as pending
       from app.users where id = $1`,
      [done.userId],
    )).toEqual({ requested_tier: 'INSTITUTIONAL', unverified: true, codes: 0, pending: 0 });
    expect(await call('app_member', done.userPublicId, s.publicId)).not.toBeNull();

    // A second sign-up with the same email is refused like any other.
    expect(await call('app_signup_create', {
      name: 'User inst', emailEnc: 'enc-email-inst', emailHash: 'email-inst', countryCode: '+91',
      phoneEnc: 'enc-phone-inst2', phoneHash: 'phone-inst2', passwordHash: 'argon-inst',
      ttlSeconds: 3600, otpTtlSeconds: 300, onboarding: onboarding('INSTITUTIONAL'),
    }, session(), '2026-10-27', CTX)).toEqual({ taken: { email: true, phone: false } });
  });

  it('stores no onboarding when none is sent (the API always sends it)', async () => {
    const email = challenge();
    const phone = challenge();
    await start('no-onboarding', undefined, email, phone);
    await verify(email);
    const done = (await verify(phone)) as { userId: string };
    expect(await one(`select tier_selected_at is null as not_selected from app.users where id = $1`, [done.userId]))
      .toEqual({ not_selected: true });
  });
});

describe('sign-up options (fixed in the app, not stored)', () => {
  const list = (type: string) => call<{ code: string; label: string }[]>('app_list_options', type);

  it('keeps no copy of the sign-up lists', async () => {
    expect(await one(`select count(*)::int as n from app.lookup_options
      where type not in ('RATING_FACTOR', 'RISK_FACTOR', 'INVESTOR_TYPE')`)).toEqual({ n: 0 });
    for (const type of ['JOB_PROFILE', 'INVESTMENT_SECTOR', 'TIER', 'COUNTRY_CODE']) {
      await expect(db.query(`insert into app.lookup_options (type, code, label) values ($1, 'X', 'x')`, [type]))
        .rejects.toThrow(/lookup_options_type_check/);
    }
  });

  it('stores only well-formed codes for a user\'s choices', async () => {
    const { userId } = await signUp('option-format');
    await expect(db.query(
      `insert into app.user_preferences (user_id, type, option_code) values ($1, 'INVESTMENT_SECTOR', 'Private Equities')`,
      [userId],
    )).rejects.toThrow(/user_preferences_option_code_check/);
  });

  it('has options for every list GET /lookups serves', async () => {
    for (const type of Object.values(LOOKUP_TYPES)) {
      expect((await list(type)).length, type).toBeGreaterThan(0);
    }
  });
});

describe('audit log', () => {
  it('records sensitive actions and cannot be changed', async () => {
    await signUp('audit');
    const { rows } = await db.query<{ action: string }>(
      `select distinct action from app.audit_logs where action in ('auth.register.started', 'auth.register.completed')`,
    );
    expect(rows.map((r) => r.action).sort()).toEqual(['auth.register.completed', 'auth.register.started']);
    await expect(db.query(`update app.audit_logs set action = 'tampered'`)).rejects.toThrow(/append-only/);
    await expect(db.query(`delete from app.audit_logs`)).rejects.toThrow(/append-only/);
  });
});
