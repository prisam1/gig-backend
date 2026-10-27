import type { PostgrestError } from '@supabase/supabase-js';
import { requestHash } from '../../lib/idempotency';
import { PG_UNIQUE_VIOLATION, supabaseAdmin, unwrap } from '../../lib/supabase';
import { HttpError } from '../../middleware/errorHandler';
import { Constants, type Enums } from '../../types/database';
import { getCreditBalance } from '../credits/credits.service';
import type { User } from '../users/users.repository';
import type { JoinPoolInput } from './roadshows.schemas';
import { findPublishedRoadshow, type Currency } from './roadshows.service';

type Expectation = Enums<'pool_expectation'>;

/** All 8 expectations in the app's display order. */
const EXPECTATIONS = Constants.public.Enums.pool_expectation;

/** Joining the Power Pool costs this many credits. */
export const POOL_JOIN_COST = 1;

// ---------------------------------------------------------------------------------------------
// Response shapes
// ---------------------------------------------------------------------------------------------

export interface PoolMembership {
  roadshowId: string;
  capitalInterest: number;
  currency: Currency;
  expectations: Expectation[];
  joinedAt: string;
  creditsRemaining: number;
}

export interface JoinPoolResult {
  membership: PoolMembership;
  /** True when this Idempotency-Key already joined the pool and the membership is returned again. */
  replayed: boolean;
}

export interface PoolPower {
  roadshowId: string;
  currency: Currency;
  participants: number;
  totalCapitalInterest: number;
  averageCapitalInterest: number;
  /** Members asking for each improvement, most demanded first. */
  improvements: { expectation: Expectation; members: number; percent: number }[];
  /**
   * Demand for each improvement by ticket size. Bands are quartiles of the members' capital
   * interest (fewer than 4 while the pool is small); `percent` is of the band's members.
   */
  heatMap: {
    bands: { band: number; minCapital: number; maxCapital: number; members: number }[];
    cells: { band: number; expectation: Expectation; members: number; percent: number }[];
  };
}

// ---------------------------------------------------------------------------------------------
// Join
// ---------------------------------------------------------------------------------------------

/** Keeps the order of EXPECTATIONS, so responses are stable. */
function inDisplayOrder(expectations: readonly Expectation[]): Expectation[] {
  return EXPECTATIONS.filter((e) => expectations.includes(e));
}

/**
 * The membership this Idempotency-Key already created, or null when the user is not in the pool.
 * Already being in the pool under another key is a 409, as is reusing the key with another body.
 */
async function existingMembership(
  user: User,
  roadshowId: string,
  idempotencyKey: string,
  hash: string,
): Promise<JoinPoolResult | null> {
  const member = unwrap(
    await supabaseAdmin
      .from('pool_members')
      .select(
        `capital_interest, idempotency_key, request_hash, created_at,
         roadshow:roadshows!inner(currency), roadshow_improvement_votes(expectation)`,
      )
      .eq('roadshow_id', roadshowId)
      .eq('user_id', user.publicId)
      .maybeSingle(),
  );
  if (!member) return null;

  if (member.idempotency_key !== idempotencyKey) {
    throw new HttpError(409, 'You have already joined this Power Pool', {
      code: 'ALREADY_IN_POOL',
    });
  }
  if (member.request_hash !== hash) {
    throw new HttpError(409, 'Idempotency-Key was already used for a different request', {
      code: 'IDEMPOTENCY_CONFLICT',
    });
  }

  return {
    membership: {
      roadshowId,
      capitalInterest: member.capital_interest,
      currency: member.roadshow.currency,
      expectations: inDisplayOrder(member.roadshow_improvement_votes.map((v) => v.expectation)),
      joinedAt: member.created_at,
      creditsRemaining: await getCreditBalance(user.publicId),
    },
    replayed: true,
  };
}

/** Errors raised by public.join_roadshow_pool. */
const JOIN_ERRORS: Record<string, () => HttpError> = {
  ROADSHOW_NOT_FOUND: () => new HttpError(404, 'Roadshow not found'),
  POOL_NOT_ENABLED: () =>
    new HttpError(409, 'This roadshow has no Power Pool', { code: 'POOL_NOT_ENABLED' }),
  ROADSHOW_CLOSED: () => new HttpError(409, 'This roadshow is closed', { code: 'ROADSHOW_CLOSED' }),
  EXPECTATIONS_INVALID: () =>
    new HttpError(400, 'Validation failed', {
      fields: { expectations: 'Pick at least 3 expectations' },
    }),
  INSUFFICIENT_CREDITS: () =>
    new HttpError(402, `Joining the Power Pool needs ${POOL_JOIN_COST} credit`, {
      code: 'INSUFFICIENT_CREDITS',
    }),
};

function joinError(error: PostgrestError): Error {
  const known = JOIN_ERRORS[error.message];
  return known ? known() : error;
}

/**
 * Prive: joins the Power Pool and spends 1 credit, in one transaction. A retry with the same
 * Idempotency-Key and body returns the same membership without spending again.
 */
export async function joinPool(
  user: User,
  roadshowId: string,
  input: JoinPoolInput,
  idempotencyKey: string,
): Promise<JoinPoolResult> {
  const hash = requestHash(input);
  const existing = await existingMembership(user, roadshowId, idempotencyKey, hash);
  if (existing) return existing;

  const roadshow = await findPublishedRoadshow(roadshowId);
  const { data, error } = await supabaseAdmin
    .rpc('join_roadshow_pool', {
      p_user_id: user.publicId,
      p_roadshow_id: roadshowId,
      p_capital_interest: input.capitalInterest,
      p_expectations: input.expectations,
      p_idempotency_key: idempotencyKey,
      p_request_hash: hash,
    })
    .single();

  if (error) {
    // A concurrent retry joined first: answer with that membership.
    if (error.message === 'ALREADY_IN_POOL' || error.code === PG_UNIQUE_VIOLATION) {
      const raced = await existingMembership(user, roadshowId, idempotencyKey, hash);
      if (raced) return raced;
    }
    throw joinError(error);
  }

  return {
    membership: {
      roadshowId,
      capitalInterest: input.capitalInterest,
      currency: roadshow.currency,
      expectations: inDisplayOrder(input.expectations),
      joinedAt: data.joined_at,
      creditsRemaining: data.credits_remaining,
    },
    replayed: false,
  };
}

// ---------------------------------------------------------------------------------------------
// Pool power
// ---------------------------------------------------------------------------------------------

const percentOf = (part: number, whole: number) =>
  whole === 0 ? 0 : Math.round((1000 * part) / whole) / 10;

const roundMoney = (value: number) => Math.round(value * 100) / 100;

export async function getPoolPower(roadshowId: string): Promise<PoolPower> {
  const roadshow = await findPublishedRoadshow(roadshowId);
  const rows = unwrap(
    await supabaseAdmin.rpc('roadshow_pool_power', { p_roadshow_id: roadshowId }),
  );

  // One row per (band, expectation): the band totals repeat on each of its rows.
  const bands = new Map<number, PoolPower['heatMap']['bands'][number] & { capital: number }>();
  for (const row of rows) {
    bands.set(row.band, {
      band: row.band,
      minCapital: row.band_min,
      maxCapital: row.band_max,
      members: row.band_members,
      capital: row.band_capital,
    });
  }
  const bandList = [...bands.values()].sort((a, b) => a.band - b.band);
  const participants = bandList.reduce((n, b) => n + b.members, 0);
  const totalCapital = bandList.reduce((sum, b) => sum + b.capital, 0);

  const improvements = EXPECTATIONS.map((expectation) => {
    const members = rows
      .filter((r) => r.expectation === expectation)
      .reduce((n, r) => n + r.votes, 0);
    return { expectation, members, percent: percentOf(members, participants) };
  }).sort((a, b) => b.members - a.members);

  return {
    roadshowId,
    currency: roadshow.currency,
    participants,
    totalCapitalInterest: roundMoney(totalCapital),
    averageCapitalInterest: participants === 0 ? 0 : roundMoney(totalCapital / participants),
    improvements,
    heatMap: {
      bands: bandList.map(({ capital: _capital, ...band }) => band),
      cells: rows.map((r) => ({
        band: r.band,
        expectation: r.expectation,
        members: r.votes,
        percent: percentOf(r.votes, r.band_members),
      })),
    },
  };
}
