import { DatabaseError, PG_UNIQUE_VIOLATION } from '../../lib/supabase';
import { HttpError, validationError, type FieldErrors } from '../../middleware/errorHandler';
import { filesRepository } from '../files/files.repository';
import type { User } from '../users/users.repository';
import { kycRepository } from './kyc.repository';
import type { SubmitKycInput } from './kyc.schemas';

/** Version of the KYC consent text shown in the app; bump it when the wording changes. */
export const KYC_CONSENT_VERSION = '2026-10';

export interface RequestMeta {
  ipAddress: string | null;
  appVersion: string | null;
}

function alreadyPending(): HttpError {
  return new HttpError(409, 'A KYC submission is already under review', 'KYC_ALREADY_PENDING');
}

/** Maps each document's public file ID to its internal ID, rejecting files the user cannot attach. */
async function resolveDocumentFiles(user: User, documents: SubmitKycInput['documents']) {
  const files = await filesRepository.findOwned(
    user.id,
    documents.map((doc) => doc.fileId),
  );
  const filesByPublicId = new Map(files.map((file) => [file.publicId, file]));

  const fields: FieldErrors = {};
  const resolved = documents.map((doc, index) => {
    const file = filesByPublicId.get(doc.fileId);
    if (!file || file.purpose !== 'KYC_DOCUMENT') {
      fields[`documents.${index}.fileId`] = 'Upload this file with purpose KYC_DOCUMENT first';
    }
    return { fileId: file?.id ?? 0, documentType: doc.documentType };
  });

  if (Object.keys(fields).length > 0) throw validationError(fields);
  return resolved;
}

export const kycService = {
  async submit(user: User, input: SubmitKycInput, meta: RequestMeta) {
    const tier = user.requestedTier;
    if (!tier) {
      throw new HttpError(
        409,
        'Choose the Prive or Institutional tier before submitting KYC',
        'TIER_NOT_REQUESTED',
      );
    }
    if (user.kycStatus === 'PENDING') throw alreadyPending();
    if (tier === 'PRIVE' && !input.consentAccepted) {
      throw validationError({ consentAccepted: 'Consent is required for Prive verification' });
    }

    const documents = await resolveDocumentFiles(user, input.documents);

    try {
      const id = await kycRepository.submit({
        userId: user.id,
        tier,
        documents,
        consent: input.consentAccepted
          ? { type: 'KYC', version: KYC_CONSENT_VERSION, ...meta }
          : null,
      });
      return { id, tier, status: 'PENDING' as const };
    } catch (error) {
      // The one-pending-submission index catches two submissions racing each other.
      if (error instanceof DatabaseError && error.code === PG_UNIQUE_VIOLATION)
        throw alreadyPending();
      throw error;
    }
  },

  async getMine(user: User) {
    const submission = await kycRepository.findLatest(user.id);

    return {
      kycStatus: user.kycStatus,
      tier: user.tier,
      requestedTier: user.requestedTier,
      submission: submission && {
        id: submission.publicId,
        tier: submission.tier,
        status: submission.status,
        rejectionReason: submission.status === 'REJECTED' ? submission.reason : null,
        submittedAt: submission.submittedAt,
        reviewedAt: submission.reviewedAt,
        documents: submission.documents,
      },
    };
  },
};
