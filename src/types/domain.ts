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

export const PREFERENCE_TYPES = DB_ENUMS.preference_type;
export type PreferenceType = Enums<'preference_type'>;

export const LOOKUP_TYPES = DB_ENUMS.lookup_type;
export type LookupType = Enums<'lookup_type'>;

export const KYC_DOCUMENT_TYPES = DB_ENUMS.kyc_document_type;
export type KycDocumentType = Enums<'kyc_document_type'>;
export type KycSubmissionStatus = Enums<'kyc_submission_status'>;
