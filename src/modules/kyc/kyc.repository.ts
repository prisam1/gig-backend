import { callDb } from '../../lib/db';
import type { ClientContext } from '../../middleware/requestContext';
import type { KycDocumentType, VerifiedTier } from '../../types/domain';

export interface NewKycSubmission {
  userId: string;
  tier: VerifiedTier;
  documents: { fileId: string; documentType: KycDocumentType }[];
  /** The consent version the user accepted, or null when none is needed. */
  consentVersion: string | null;
}

export const kycRepository = {
  /** Saves the submission, its documents and consent, and marks the user PENDING, atomically. */
  submit(submission: NewKycSubmission, ctx: ClientContext): Promise<string> {
    return callDb('app_kyc_submit', {
      p_user_id: submission.userId,
      p_tier: submission.tier,
      p_documents: submission.documents,
      p_consent_version: submission.consentVersion,
      p_ctx: ctx,
    });
  },

};
