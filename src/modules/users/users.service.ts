import type { z } from 'zod';
import { audit } from '../../lib/audit';
import { decrypt } from '../../lib/crypto';
import { sql, transaction, type Db } from '../../lib/db';
import { AppError } from '../../middleware/errorHandler';
import type { ClientContext } from '../../middleware/requestContext';
import type { LookupType, preferencesSchema, tierSchema, updateMeSchema } from './users.schemas';

export type Tier = 'OBSERVER' | 'PRIVE' | 'INSTITUTIONAL';

interface Option {
  code: string;
  label: string;
}

const PREFERENCE_KEYS = {
  INVESTMENT_FOCUS: 'focus',
  RISK_LEVEL: 'risk',
  INVESTMENT_STYLE: 'style',
  INVESTMENT_SECTOR: 'sector',
} as const;

export async function listOptions(type: LookupType, db: Db = sql): Promise<Option[]> {
  return db<Option[]>`
    select code, label from app.lookup_options
    where type = ${type} and active
    order by sort_order, label`;
}

// Throws a field error naming the first code that is unknown or no longer offered.
async function assertOptions(db: Db, type: LookupType, codes: string[], field: string): Promise<void> {
  const rows = await db<{ code: string }[]>`
    select code from app.lookup_options where type = ${type} and active and code in ${db(codes)}`;
  const found = new Set(rows.map((r) => r.code));
  const missing = codes.find((c) => !found.has(c));
  if (missing) throw new AppError(400, 'VALIDATION_FAILED', 'Some fields are invalid', { [field]: `Unknown option: ${missing}` });
}

export async function loadUser(userId: string, db: Db = sql) {
  const [row] = await db<
    {
      publicId: string;
      emailEnc: string;
      phoneEnc: string;
      tier: Tier;
      requestedTier: Tier | null;
      kycStatus: string;
      tierSelectedAt: Date | null;
      createdAt: Date;
      name: string;
      experienceYears: number | null;
      jobProfileCode: string | null;
      jobProfileLabel: string | null;
      otherJob: string | null;
      location: string | null;
    }[]
  >`
    select u.public_id, u.email_enc, u.phone_enc, u.tier, u.requested_tier, u.kyc_status,
           u.tier_selected_at, u.created_at, p.name, p.experience_years, p.job_profile_code,
           jl.label as job_profile_label, p.other_job, p.location
    from app.users u
    join app.user_profiles p on p.user_id = u.id
    left join app.lookup_options jl on jl.type = 'JOB_PROFILE' and jl.code = p.job_profile_code
    where u.id = ${userId}`;
  if (!row) throw new AppError(404, 'NOT_FOUND', 'User not found');

  const prefs = await db<{ type: keyof typeof PREFERENCE_KEYS; code: string; label: string }[]>`
    select up.type, up.option_code as code, l.label
    from app.user_preferences up
    join app.lookup_options l on l.type = up.type and l.code = up.option_code
    where up.user_id = ${userId}
    order by l.sort_order`;

  const preferences: Record<(typeof PREFERENCE_KEYS)[keyof typeof PREFERENCE_KEYS], Option[]> = {
    focus: [],
    risk: [],
    style: [],
    sector: [],
  };
  for (const p of prefs) preferences[PREFERENCE_KEYS[p.type]].push({ code: p.code, label: p.label });

  const profileCompleted = row.experienceYears !== null && row.jobProfileCode !== null && row.location !== null;
  const preferencesCompleted = Object.values(preferences).every((list) => list.length > 0);
  const tierSelected = row.tierSelectedAt !== null;

  return {
    id: row.publicId,
    name: row.name,
    email: decrypt(row.emailEnc, 'email'),
    phone: decrypt(row.phoneEnc, 'phone'),
    tier: row.tier,
    requestedTier: row.requestedTier,
    kycStatus: row.kycStatus,
    profile: {
      experienceYears: row.experienceYears,
      jobProfile: row.jobProfileCode ? { code: row.jobProfileCode, label: row.jobProfileLabel } : null,
      otherJob: row.otherJob,
      location: row.location,
    },
    preferences,
    onboarding: {
      profileCompleted,
      preferencesCompleted,
      tierSelected,
      completed: profileCompleted && preferencesCompleted && tierSelected,
    },
    createdAt: row.createdAt,
  };
}
export type UserDto = Awaited<ReturnType<typeof loadUser>>;

export async function updateMe(userId: string, input: z.infer<typeof updateMeSchema>, ctx: ClientContext) {
  return transaction(async (tx) => {
    const [current] = await tx<{ jobProfileCode: string | null; otherJob: string | null }[]>`
      select job_profile_code, other_job from app.user_profiles where user_id = ${userId} for update`;
    if (!current) throw new AppError(404, 'NOT_FOUND', 'User not found');

    if (input.jobProfile !== undefined) {
      await assertOptions(tx, 'JOB_PROFILE', [input.jobProfile], 'jobProfile');
    }
    const jobProfile = input.jobProfile ?? current.jobProfileCode;
    let otherJob: string | null;
    if (jobProfile === 'OTHERS') {
      otherJob = input.otherJob ?? current.otherJob;
      if (!otherJob) {
        throw new AppError(400, 'VALIDATION_FAILED', 'Some fields are invalid', { otherJob: 'Specify your job profile' });
      }
    } else {
      if (input.otherJob !== undefined) {
        throw new AppError(400, 'VALIDATION_FAILED', 'Some fields are invalid', {
          otherJob: 'Only allowed when the job profile is Others',
        });
      }
      otherJob = null;
    }

    await tx`
      update app.user_profiles set
        name = coalesce(${input.name ?? null}, name),
        experience_years = coalesce(${input.experienceYears ?? null}::smallint, experience_years),
        job_profile_code = ${jobProfile},
        other_job = ${otherJob},
        location = coalesce(${input.location ?? null}, location)
      where user_id = ${userId}`;
    await audit(ctx, 'user.profile.updated', { userId, metadata: { fields: Object.keys(input) } }, tx);
    return loadUser(userId, tx);
  });
}

export async function setPreferences(userId: string, input: z.infer<typeof preferencesSchema>, ctx: ClientContext) {
  return transaction(async (tx) => {
    // Serialises concurrent updates for the same user.
    await tx`select id from app.users where id = ${userId} for update`;

    const groups = [
      ['INVESTMENT_FOCUS', input.focus, 'focus'],
      ['RISK_LEVEL', input.risk, 'risk'],
      ['INVESTMENT_STYLE', input.style, 'style'],
      ['INVESTMENT_SECTOR', input.sector, 'sector'],
    ] as const;
    for (const [type, codes, field] of groups) await assertOptions(tx, type, [...codes], field);

    await tx`delete from app.user_preferences where user_id = ${userId}`;
    const rows = groups.flatMap(([type, codes]) => codes.map((code) => ({ userId, type, optionCode: code })));
    await tx`insert into app.user_preferences ${tx(rows, 'userId', 'type', 'optionCode')}`;

    await audit(ctx, 'user.preferences.updated', { userId }, tx);
    return loadUser(userId, tx);
  });
}

// Observer is granted at once. Prive and Institutional are recorded as requested and granted
// only when KYC is approved (KYC workstream), never by this endpoint.
export async function selectTier(userId: string, input: z.infer<typeof tierSchema>, ctx: ClientContext) {
  return transaction(async (tx) => {
    const [user] = await tx<{ tier: Tier; requestedTier: Tier | null; tierSelectedAt: Date | null }[]>`
      select tier, requested_tier, tier_selected_at from app.users where id = ${userId} for update`;
    if (!user) throw new AppError(404, 'NOT_FOUND', 'User not found');

    const before = await loadUser(userId, tx);
    if (!before.onboarding.profileCompleted || !before.onboarding.preferencesCompleted) {
      throw new AppError(409, 'ONBOARDING_INCOMPLETE', 'Complete your professional and investment details first');
    }

    const target = input.tier;
    const toTier: Tier = target === 'OBSERVER' ? 'OBSERVER' : user.tier;
    const requested: Tier | null = target === 'OBSERVER' || target === user.tier ? null : target;
    const changed = toTier !== user.tier || requested !== user.requestedTier || !user.tierSelectedAt;

    if (changed) {
      await tx`
        update app.users set tier = ${toTier}, requested_tier = ${requested},
          tier_selected_at = coalesce(tier_selected_at, now())
        where id = ${userId}`;
      await tx`
        insert into app.tier_history (user_id, from_tier, to_tier, requested_tier, reason)
        values (${userId}, ${user.tier}, ${toTier}, ${requested}, 'USER_SELECTED')`;
      await audit(ctx, 'user.tier.selected', { userId, metadata: { from: user.tier, to: toTier, requested } }, tx);
    }

    return { user: await loadUser(userId, tx), nextStep: requested ? 'KYC_REQUIRED' : 'NONE' };
  });
}
