// The signed-in member: session, tier, KYC status and name. Owned by the auth module; every
// other module reads users through here. Tokens are resolved to a member by src/lib/auth.ts.

export const TIERS = ['OBSERVER', 'PRIVE', 'INSTITUTIONAL'] as const;
export type Tier = (typeof TIERS)[number];

/** Tiers that are granted only after KYC approval. */
export type VerifiedTier = Exclude<Tier, 'OBSERVER'>;

export const KYC_STATUSES = ['NOT_STARTED', 'PENDING', 'APPROVED', 'REJECTED'] as const;
export type KycStatus = (typeof KYC_STATUSES)[number];

export interface Member {
  userId: string;
  /** The user id other modules store (reviews.user_id, file folders). */
  userPublicId: string;
  sessionId: string;
  sessionPublicId: string;
  tier: Tier;
  /** Prive or Institutional chosen at sign-up and waiting for KYC approval. */
  requestedTier: VerifiedTier | null;
  kycStatus: KycStatus;
  /** Shown on reviews per the reviewer's display mode. Empty until the profile step is done. */
  fullName: string;
}
