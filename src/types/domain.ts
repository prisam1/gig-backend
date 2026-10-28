// Value lists of the users, files and KYC tables. They match the CHECK constraints in
// supabase/migrations/20261027140000_files_kyc_follows.sql; change both together.

import { Constants, type Enums } from './database';

export type { KycStatus, Tier, VerifiedTier } from '../lib/membership';

// SIGNATURE (petition signatures) is added by 20261027161000_ratings_representations_support.sql.
export const FILE_PURPOSES = ['AVATAR', 'KYC_DOCUMENT', 'REVIEW_EVIDENCE', 'SIGNATURE'] as const;
export type FilePurpose = (typeof FILE_PURPOSES)[number];

export type FileScanStatus = 'PENDING' | 'CLEAN' | 'INFECTED';

export const KYC_DOCUMENT_TYPES = [
  'ID_PROOF',
  'ADDRESS_PROOF',
  'TAX_ID',
  'INCORPORATION_CERTIFICATE',
  'AUTHORISATION_LETTER',
] as const;
export type KycDocumentType = (typeof KYC_DOCUMENT_TYPES)[number];

export type KycSubmissionStatus = 'PENDING' | 'APPROVED' | 'REJECTED';

// Shared with catalog and reviews, so they come from the public schema's enums.
export const MARKET_COUNTRIES = Constants.public.Enums.market_country;
export type MarketCountry = Enums<'market_country'>;

export const DISPLAY_MODES = Constants.public.Enums.display_mode;
export type DisplayMode = Enums<'display_mode'>;

// Ratings and Representations. They match the CHECK constraints in
// supabase/migrations/20261027170000_ratings.sql and 20261027180000_representations.sql.

export const RATING_FLAGS = ['POSITIVE', 'NEUTRAL', 'NEGATIVE'] as const;
export type RatingFlag = (typeof RATING_FLAGS)[number];

export const RATING_STATUSES = [
  'PENDING_MODERATION',
  'PUBLISHED',
  'CHANGES_REQUESTED',
  'REJECTED',
  'REMOVED',
] as const;
export type RatingStatus = (typeof RATING_STATUSES)[number];

/** The 9-step petition track, in order. */
export const REPRESENTATION_TRACK_STATUSES = [
  'OPEN',
  'CLOSING_SOON',
  'CLOSED',
  'UNDER_REVIEW',
  'SUBMITTED_TO_REGULATOR',
  'MEETING_REQUESTED',
  'MEETING_SCHEDULED',
  'REGULATOR_RESPONDED',
  'RESOLVED',
] as const;
export type RepresentationTrackStatus = (typeof REPRESENTATION_TRACK_STATUSES)[number];

export const REPRESENTATION_DOCUMENT_TYPES = [
  'EVIDENCE',
  'SUBMISSION_PACK',
  'REGULATOR_RESPONSE',
  'MEETING_MINUTES',
] as const;
export type RepresentationDocumentType = (typeof REPRESENTATION_DOCUMENT_TYPES)[number];

// Admin. They match the CHECK constraints in supabase/migrations/20261028090000_admin.sql.

export const STAFF_ROLES = ['ADMIN', 'MODERATOR', 'ANALYST', 'SUPPORT'] as const;
export type StaffRole = (typeof STAFF_ROLES)[number];

export const USER_STATUSES = ['ACTIVE', 'SUSPENDED', 'DELETED'] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

// Roadshows and learn. They match the CHECK constraints in
// supabase/migrations/20261028100000_admin_roadshows_learn.sql.

/** Ask Me Anything categories; "Top Asked" and "Recently Added" are sort orders, not categories. */
export const ROADSHOW_QUESTION_CATEGORIES = ['EQUITY', 'DEBT', 'INSURANCE', 'CRYPTO', 'MUTUAL_FUNDS'] as const;
export type RoadshowQuestionCategory = (typeof ROADSHOW_QUESTION_CATEGORIES)[number];

export const LEARN_CONTENT_TYPES = ['ARTICLE', 'VIDEO', 'PODCAST', 'REPORT', 'COURSE'] as const;
export type LearnContentType = (typeof LEARN_CONTENT_TYPES)[number];
