import { supabaseAdmin, unwrap } from '../../lib/supabase';
import type { KycDocumentType, KycSubmissionStatus, VerifiedTier } from '../../types/domain';

export interface KycSubmission {
  publicId: string;
  tier: VerifiedTier;
  status: KycSubmissionStatus;
  reason: string | null;
  submittedAt: string;
  reviewedAt: string | null;
  documents: { fileId: string; documentType: KycDocumentType }[];
}

export interface NewKycSubmission {
  userId: number;
  tier: VerifiedTier;
  documents: { fileId: number; documentType: KycDocumentType }[];
  consent: {
    type: string;
    version: string;
    ipAddress: string | null;
    appVersion: string | null;
  } | null;
}

export const kycRepository = {
  /** Saves the submission, its documents and consent, and marks the user PENDING, atomically. */
  async submit(submission: NewKycSubmission): Promise<string> {
    return unwrap(
      await supabaseAdmin.rpc('submit_kyc', {
        p_user_id: submission.userId,
        p_tier: submission.tier,
        p_documents: submission.documents.map((doc) => ({
          file_id: doc.fileId,
          document_type: doc.documentType,
        })),
        p_consent: submission.consent && {
          type: submission.consent.type,
          version: submission.consent.version,
          ip_address: submission.consent.ipAddress,
          app_version: submission.consent.appVersion,
        },
      }),
    );
  },

  async findLatest(userId: number): Promise<KycSubmission | null> {
    const row = unwrap(
      await supabaseAdmin
        .from('kyc_submissions')
        .select(
          'public_id, tier, status, reason, created_at, reviewed_at, kyc_documents(document_type, files(public_id))',
        )
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle(),
    );
    if (!row) return null;

    return {
      publicId: row.public_id,
      tier: row.tier,
      status: row.status,
      reason: row.reason,
      submittedAt: row.created_at,
      reviewedAt: row.reviewed_at,
      documents: row.kyc_documents.map((doc) => ({
        fileId: doc.files.public_id,
        documentType: doc.document_type,
      })),
    };
  },
};
