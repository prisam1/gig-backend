import { Constants, type Enums } from './database';

// Every enum comes from the database types, so a schema change shows up as a compile error.
const DB_ENUMS = Constants.public.Enums;

export const TIERS = DB_ENUMS.membership_tier;
export type Tier = Enums<'membership_tier'>;

/** Tiers that require an approved KYC submission. */
export type VerifiedTier = Enums<'verified_tier'>;

export type KycStatus = Enums<'kyc_status'>;
export type UserStatus = Enums<'user_status'>;

export const FILE_PURPOSES = DB_ENUMS.file_purpose;
export type FilePurpose = Enums<'file_purpose'>;
export type FileScanStatus = Enums<'file_scan_status'>;

export const PREFERENCE_TYPES = DB_ENUMS.preference_type;
export type PreferenceType = Enums<'preference_type'>;

export const LOOKUP_TYPES = DB_ENUMS.lookup_type;
export type LookupType = Enums<'lookup_type'>;

export const KYC_DOCUMENT_TYPES = DB_ENUMS.kyc_document_type;
export type KycDocumentType = Enums<'kyc_document_type'>;
export type KycSubmissionStatus = Enums<'kyc_submission_status'>;

export const MARKET_COUNTRIES = DB_ENUMS.market_country;
export type MarketCountry = Enums<'market_country'>;

export const DISPLAY_MODES = DB_ENUMS.display_mode;
export type DisplayMode = Enums<'display_mode'>;

// Ratings
export const RATING_FLAGS = DB_ENUMS.rating_flag;
export type RatingFlag = Enums<'rating_flag'>;

export const RATING_STATUSES = DB_ENUMS.rating_status;
export type RatingStatus = Enums<'rating_status'>;

// Representations
export const REPRESENTATION_TRACK_STATUSES = DB_ENUMS.representation_track_status;
export type RepresentationTrackStatus = Enums<'representation_track_status'>;

export type RepresentationDocumentType = Enums<'representation_document_type'>;
