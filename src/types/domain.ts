// Value lists of the users, files and KYC tables. They match the CHECK constraints in
// supabase/migrations/20261027140000_files_kyc_follows.sql; change both together.

export type { KycStatus, Tier, VerifiedTier } from '../lib/membership';

export const FILE_PURPOSES = ['AVATAR', 'KYC_DOCUMENT', 'REVIEW_EVIDENCE'] as const;
export type FilePurpose = (typeof FILE_PURPOSES)[number];

export const KYC_DOCUMENT_TYPES = [
  'ID_PROOF',
  'ADDRESS_PROOF',
  'TAX_ID',
  'INCORPORATION_CERTIFICATE',
  'AUTHORISATION_LETTER',
] as const;
export type KycDocumentType = (typeof KYC_DOCUMENT_TYPES)[number];

export type KycSubmissionStatus = 'PENDING' | 'APPROVED' | 'REJECTED';
