import { audit } from '../../lib/audit';
import { sql, transaction } from '../../lib/db';
import type { ClientContext } from '../../middleware/requestContext';
import type { KycDocumentType, KycSubmissionStatus, VerifiedTier } from '../../types/domain';

export interface KycSubmission {
  publicId: string;
  tier: VerifiedTier;
  status: KycSubmissionStatus;
  reason: string | null;
  submittedAt: Date;
  reviewedAt: Date | null;
  documents: { fileId: string; documentType: KycDocumentType }[];
}

export interface NewKycSubmission {
  userId: string;
  tier: VerifiedTier;
  documents: { fileId: string; documentType: KycDocumentType }[];
  /** The consent version the user accepted, or null when none is needed. */
  consentVersion: string | null;
}

export const kycRepository = {
  /** Saves the submission, its documents and consent, and marks the user PENDING, atomically. */
  async submit(submission: NewKycSubmission, ctx: ClientContext): Promise<string> {
    return transaction(async (tx) => {
      const [created] = await tx<{ id: string; publicId: string }[]>`
        insert into app.kyc_submissions (user_id, tier)
        values (${submission.userId}, ${submission.tier})
        returning id, public_id`;
      const documents = submission.documents.map((doc) => ({
        submissionId: created!.id,
        fileId: doc.fileId,
        documentType: doc.documentType,
      }));
      await tx`insert into app.kyc_documents ${tx(documents, 'submissionId', 'fileId', 'documentType')}`;

      if (submission.consentVersion) {
        await tx`
          insert into app.consents (user_id, type, version, accepted_at, ip, user_agent, app_version)
          values (${submission.userId}, 'KYC', ${submission.consentVersion}, now(), ${ctx.ip},
                  ${ctx.userAgent}, ${ctx.appVersion})`;
      }
      await tx`update app.users set kyc_status = 'PENDING' where id = ${submission.userId}`;
      await audit(
        ctx,
        'kyc.submitted',
        { userId: submission.userId, metadata: { submission: created!.publicId, tier: submission.tier } },
        tx,
      );
      return created!.publicId;
    });
  },

  async findLatest(userId: string): Promise<KycSubmission | null> {
    const [row] = await sql<KycSubmission[]>`
      select s.public_id, s.tier, s.status, s.reason, s.created_at as submitted_at, s.reviewed_at,
             coalesce(
               json_agg(json_build_object('fileId', f.public_id, 'documentType', d.document_type))
                 filter (where d.file_id is not null),
               '[]'
             ) as documents
      from app.kyc_submissions s
      left join app.kyc_documents d on d.submission_id = s.id
      left join app.files f on f.id = d.file_id
      where s.user_id = ${userId}
      group by s.id
      order by s.created_at desc
      limit 1`;
    return row ?? null;
  },
};
