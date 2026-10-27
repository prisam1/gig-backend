import type { JwtPayload } from '@supabase/supabase-js';
import { z } from 'zod';

// Integration point with the auth/onboarding module, which owns user profiles, tiers and KYC.
// Catalog and reviews only need the three values below. To switch to that module's profile table,
// change `loadMembership` alone; nothing else in this module reads user data.

export const TIERS = ['OBSERVER', 'PRIVE', 'INSTITUTIONAL'] as const;
export type Tier = (typeof TIERS)[number];

export const KYC_STATUSES = ['NOT_STARTED', 'PENDING', 'APPROVED', 'REJECTED'] as const;
export type KycStatus = (typeof KYC_STATUSES)[number];

export interface Membership {
  tier: Tier;
  kycStatus: KycStatus;
  /** Shown on reviews per the reviewer's display mode. */
  fullName: string;
}

// Interim source: Supabase Auth metadata carried in the verified access token.
// app_metadata can only be written with the service role, so users cannot raise their own tier.
const appMetadata = z
  .object({
    tier: z.enum(TIERS).catch('OBSERVER'),
    kyc_status: z.enum(KYC_STATUSES).catch('NOT_STARTED'),
  })
  .catch({ tier: 'OBSERVER', kyc_status: 'NOT_STARTED' });

const userMetadata = z
  .object({ full_name: z.string().trim().max(120).catch('') })
  .catch({ full_name: '' });

export async function loadMembership(_userId: string, claims: JwtPayload): Promise<Membership> {
  const app = appMetadata.parse(claims.app_metadata ?? {});
  const user = userMetadata.parse(claims.user_metadata ?? {});
  return { tier: app.tier, kycStatus: app.kyc_status, fullName: user.full_name };
}
