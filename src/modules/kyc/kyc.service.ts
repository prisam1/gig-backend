import { isUniqueViolation } from '../../lib/db';
import type { Member } from '../../lib/membership';
import { consume, LIMITS } from '../../lib/rateLimit';
import { HttpError, validationError, type FieldErrors } from '../../middleware/errorHandler';
import type { ClientContext } from '../../middleware/requestContext';
import { filesRepository } from '../files/files.repository';
import { filesStorage } from '../files/files.storage';
import { kycRepository } from './kyc.repository';
import type { SubmitKycInput } from './kyc.schemas';

/** Version of the KYC consent text shown in the app; bump it when the wording changes. */
export const KYC_CONSENT_VERSION = '2026-10';

function alreadyPending(): HttpError {
  return new HttpError(409, 'A KYC submission is already under review', {
    code: 'KYC_ALREADY_PENDING',
  });
}

/** Maps each document's public file ID to its internal ID, rejecting files the user cannot attach. */
async function resolveDocumentFiles(user: Member, documents: SubmitKycInput['documents']) {
  const files = await filesRepository.findOwned(
    user.userId,
    documents.map((doc) => doc.fileId),
  );
  const filesByPublicId = new Map(files.map((file) => [file.publicId, file]));

  const fields: FieldErrors = {};
  const resolved = await Promise.all(
    documents.map(async (doc, index) => {
      const file = filesByPublicId.get(doc.fileId);
      if (!file || file.purpose !== 'KYC_DOCUMENT') {
        fields[`documents.${index}.fileId`] = 'Upload this file with purpose KYC_DOCUMENT first';
      } else if (!(await filesStorage.exists(file.bucket, file.objectKey))) {
        fields[`documents.${index}.fileId`] = 'File has not been uploaded yet';
      }
      return { fileId: file?.id ?? '', documentType: doc.documentType };
    }),
  );

  if (Object.keys(fields).length > 0) throw validationError(fields);
  return resolved;
}

export const kycService = {
  async submit(user: Member, input: SubmitKycInput, ctx: ClientContext) {
    const tier = user.requestedTier;
    if (!tier) {
      throw new HttpError(409, 'Choose the Prive or Institutional tier before submitting KYC', {
        code: 'TIER_NOT_REQUESTED',
      });
    }
    if (user.kycStatus === 'PENDING') throw alreadyPending();
    if (tier === 'PRIVE' && !input.consentAccepted) {
      throw validationError({ consentAccepted: 'Consent is required for Prive verification' });
    }
    await consume(LIMITS.kycSubmitPerUser, user.userPublicId);

    const documents = await resolveDocumentFiles(user, input.documents);

    try {
      const id = await kycRepository.submit(
        {
          userId: user.userId,
          tier,
          documents,
          consentVersion: input.consentAccepted ? KYC_CONSENT_VERSION : null,
        },
        ctx,
      );
      return { id, tier, status: 'PENDING' as const };
    } catch (error) {
      // The one-pending-submission index catches two submissions racing each other.
      if (isUniqueViolation(error)) throw alreadyPending();
      throw error;
    }
  },
};
