// Keeps src/lib/dbFunctions.ts and the migrations in lockstep: every declared function exists with
// exactly the declared arguments, every app_* function is declared, and real results from the
// auth, profile, KYC and file functions pass callDb's result checks (ratings and representations
// are covered the same way by ratings_representations.db.test.ts).

import type { PGlite } from '@electric-sql/pglite';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { callDb, DatabaseError, dbTransport } from '../../src/lib/db';
import { DB_FUNCTIONS, READ_ONLY_DB_FUNCTIONS } from '../../src/lib/dbFunctions';
import { callFunction, createTestDatabase } from './pglite';

const CTX = { ip: '203.0.113.9', userAgent: 'vitest', appVersion: '1.0.0', requestId: 'req-contract' };
const SESSION = { deviceName: 'Test phone', platform: 'IOS', idleDays: 30, maxDays: 90, maxActive: 10 } as const;

let db: PGlite;

beforeAll(async () => {
  db = await createTestDatabase();
});

afterAll(async () => {
  await db.close();
});

beforeEach(() => {
  vi.spyOn(dbTransport, 'rpc').mockImplementation((fn, args) =>
    callFunction(db, fn, args, (code, message) => new DatabaseError(code, message)),
  );
});

const code = () => {
  const publicId = randomUUID();
  return { publicId, codeHash: `code:${publicId}`, decoyHash: `decoy:${publicId}` };
};
const session = () => ({ ...SESSION, publicId: randomUUID(), refreshHash: `refresh:${randomUUID()}` });

describe('declared functions match the database', () => {
  it('retries exactly the functions the SQL declares read-only (stable)', async () => {
    const { rows } = await db.query<{ name: string }>(`
      select p.proname as name from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname like 'app\\_%' and p.provolatile in ('s', 'i') order by 1`);
    expect(rows.map((r) => r.name)).toEqual([...READ_ONLY_DB_FUNCTIONS].sort());
  });

  it('declares exactly the app_* functions the migrations create', async () => {
    const { rows } = await db.query<{ name: string }>(`
      select p.proname as name from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname like 'app\\_%' order by 1`);
    expect(rows.map((r) => r.name)).toEqual(Object.keys(DB_FUNCTIONS).sort());
  });

  it.each(Object.entries(DB_FUNCTIONS))('%s takes exactly the declared arguments', async (name, spec) => {
    const { rows } = await db.query<{ arg: string }>(
      `select unnest(p.proargnames) as arg from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = $1`,
      [name],
    );
    expect(rows.map((r) => r.arg).sort()).toEqual(Object.keys(spec.args.shape).sort());
  });
});

describe('real results pass the declared result shapes', () => {
  it('sign-up with onboarding, sessions, profile, files and KYC', async () => {
    expect(await callDb('app_ping', {})).toBe(true);
    await callDb('app_purge_expired', {});
    expect(await callDb('app_rate_limit_hit', { p_key: `k:${randomUUID()}`, p_max: 5, p_window_seconds: 60 })).toEqual({
      limited: false,
      retryAfter: expect.any(Number),
    });
    await callDb('app_audit', { p_ctx: CTX, p_action: 'contract.test', p_user_id: null, p_metadata: {} });

    // Sign-up with the professional and investment details and the tier: both codes verified
    // creates the account, its profile and preferences, and a session.
    const option = async (type: string) => (await callDb('app_list_options', { p_type: type })).find((o) => o.code !== 'OTHERS')!.code;
    const onboarding = {
      profile: { experienceYears: 4, jobProfile: await option('JOB_PROFILE'), location: 'Pune' },
      preferences: {
        focus: [await option('INVESTMENT_FOCUS')],
        risk: [await option('RISK_LEVEL')],
        style: [await option('INVESTMENT_STYLE')],
        sector: [await option('INVESTMENT_SECTOR')],
      },
      tier: 'PRIVE' as const,
    };
    const email = code();
    const phone = code();
    const started = await callDb('app_signup_start', {
      p_signup: {
        name: 'Contract User', emailEnc: 'enc-e', emailHash: 'contract-email', countryCode: '+91',
        phoneEnc: 'enc-p', phoneHash: 'contract-phone', passwordHash: 'argon', ttlSeconds: 3600, otpTtlSeconds: 300,
        onboarding,
      },
      p_email_challenge: email,
      p_phone_challenge: phone,
      p_ctx: CTX,
    });
    if ('fields' in started) throw new Error(`unexpected field errors: ${JSON.stringify(started.fields)}`);
    expect(started.expiresAt).toBeInstanceOf(Date);
    expect(await callDb('app_otp_peek', { p_public_id: email.publicId })).toEqual({ destinationHash: 'contract-email' });

    const verify = (c: ReturnType<typeof code>, s = session()) =>
      callDb('app_otp_verify', {
        p_public_id: c.publicId, p_code_hash: c.codeHash, p_max_attempts: 5, p_limits: [], p_session: s,
        p_reset: { tokenHash: `reset:${c.publicId}`, ttlSeconds: 600 }, p_age_consent_version: '2026-10-27', p_ctx: CTX,
      });
    expect(await verify(email)).toMatchObject({ status: 'PENDING', verified: ['EMAIL'], pending: ['PHONE'] });
    const first = session();
    const done = await verify(phone, first);
    if (!('status' in done) || done.status !== 'COMPLETED') throw new Error(`expected COMPLETED, got ${JSON.stringify(done)}`);
    expect(done.sessionExpiresAt).toBeInstanceOf(Date);
    const userId = done.userId;

    const member = await callDb('app_member', { p_user_public_id: done.userPublicId, p_session_public_id: first.publicId });
    expect(member).toMatchObject({ userId, tier: 'OBSERVER', requestedTier: 'PRIVE', fullName: 'Contract User' });

    // Login, refresh, OTP and reset.
    expect(await callDb('app_login_lookup', { p_channel: 'EMAIL', p_id_hash: 'contract-email' })).toMatchObject({ userId, status: 'ACTIVE' });
    expect(await callDb('app_login_complete', { p_user_id: userId, p_session: session(), p_ctx: CTX })).toEqual({
      sessionExpiresAt: expect.any(Date),
    });
    expect(
      await callDb('app_refresh', {
        p_session_public_id: first.publicId, p_secret_hash: first.refreshHash, p_new_secret_hash: 'next', p_idle_days: 30, p_ctx: CTX,
      }),
    ).toEqual({ userPublicId: done.userPublicId, sessionExpiresAt: expect.any(Date) });
    const resetCode = code();
    expect(
      await callDb('app_otp_start', {
        p_purpose: 'PASSWORD_RESET', p_channel: 'EMAIL', p_destination_hash: 'contract-email', p_challenge: resetCode,
        p_ttl_seconds: 300, p_ctx: CTX,
      }),
    ).toEqual({ userExists: true });
    expect(
      await callDb('app_otp_resend', {
        p_public_id: resetCode.publicId, p_challenge: resetCode, p_cooldown_seconds: 45, p_max_sends: 5, p_ttl_seconds: 300,
        p_limit: { key: `send:${randomUUID()}`, max: 5, window: 3600 },
      }),
    ).toMatchObject({ error: 'OTP_RESEND_COOLDOWN' });
    expect(await verify(resetCode)).toEqual({ status: 'RESET_TOKEN_ISSUED' });
    expect(await callDb('app_reset_lookup', { p_token_hash: `reset:${resetCode.publicId}` })).toMatchObject({ userId });
    expect(await callDb('app_reset_complete', { p_token_hash: `reset:${resetCode.publicId}`, p_password_hash: 'new', p_ctx: CTX })).toEqual({ ok: true });

    // Profile.
    expect(await callDb('app_update_profile', { p_user_id: userId, p_changes: { location: 'Mumbai' }, p_ctx: CTX })).toEqual({ ok: true });
    const me = await callDb('app_get_user', { p_user_id: userId });
    expect(me).toMatchObject({ tier: 'OBSERVER', requestedTier: 'PRIVE', experienceYears: 4, location: 'Mumbai', followers: 0 });
    expect(me?.preferences).toHaveLength(4);

    // Files and KYC.
    const file = await callDb('app_create_file', {
      p_owner_id: userId, p_purpose: 'KYC_DOCUMENT', p_bucket: 'kyc-documents', p_object_key: `${randomUUID()}/id.pdf`,
      p_mime_type: 'application/pdf', p_size_bytes: 2048,
    });
    expect(await callDb('app_find_owned_files', { p_owner_id: userId, p_public_ids: [file.publicId] })).toEqual([file]);
    expect(await callDb('app_kyc_submit', {
      p_user_id: userId, p_tier: 'PRIVE', p_documents: [{ fileId: file.id, documentType: 'ID_PROOF' }], p_consent_version: '2026-10', p_ctx: CTX,
    })).toEqual(expect.any(String));

    // Logout.
    await callDb('app_logout', { p_user_id: userId, p_session_id: member!.sessionId, p_ctx: CTX });
    await callDb('app_rate_limit_reset', { p_keys: ['none'] });
  });

  it('rejects a result that does not match its declared shape', async () => {
    vi.spyOn(dbTransport, 'rpc').mockResolvedValue({ limited: 'no', retryAfter: 1 });
    await expect(callDb('app_rate_limit_hit', { p_key: 'k', p_max: 1, p_window_seconds: 1 })).rejects.toThrow(
      /Unexpected result from app_rate_limit_hit/,
    );
  });

  it('rejects arguments that do not match their declared shape before calling the database', async () => {
    const rpc = vi.spyOn(dbTransport, 'rpc');
    // A runtime mistake TypeScript would also reject at compile time.
    await expect(callDb('app_member', { p_user_public_id: 'not-a-uuid', p_session_public_id: randomUUID() })).rejects.toThrow(
      /Invalid arguments for app_member/,
    );
    expect(rpc).not.toHaveBeenCalled();
  });
});
