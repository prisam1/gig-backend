import { randomUUID } from 'node:crypto';
import { audit } from '../../lib/audit';
import type { Member } from '../../lib/membership';
import { consume, LIMITS } from '../../lib/rateLimit';
import { validationError } from '../../middleware/errorHandler';
import type { ClientContext } from '../../middleware/requestContext';
import type { FilePurpose } from '../../types/domain';
import { filesRepository } from './files.repository';
import type { CreateUploadUrlInput } from './files.schemas';
import { filesStorage } from './files.storage';

const BUCKET_BY_PURPOSE: Record<FilePurpose, string> = {
  AVATAR: 'avatars',
  KYC_DOCUMENT: 'kyc-documents',
  REVIEW_EVIDENCE: 'review-evidence',
  SIGNATURE: 'signatures',
};

const EXTENSION_BY_MIME: Record<CreateUploadUrlInput['mimeType'], string> = {
  'application/pdf': 'pdf',
  'image/jpeg': 'jpg',
  'image/png': 'png',
};

export const filesService = {
  async createUploadUrl(user: Member, input: CreateUploadUrlInput, ctx: ClientContext) {
    if (input.purpose === 'AVATAR' && input.mimeType === 'application/pdf') {
      throw validationError({ mimeType: 'Avatar must be a JPG or PNG image' });
    }
    await consume(LIMITS.uploadUrlPerUser, user.userPublicId);

    // Each user uploads only into their own folder; reviews and KYC check this prefix.
    const bucket = BUCKET_BY_PURPOSE[input.purpose];
    const objectKey = `${user.userPublicId}/${randomUUID()}.${EXTENSION_BY_MIME[input.mimeType]}`;

    const uploadUrl = await filesStorage.createUploadUrl(bucket, objectKey);
    const file = await filesRepository.create({
      ownerId: user.userId,
      purpose: input.purpose,
      bucket,
      objectKey,
      mimeType: input.mimeType,
      sizeBytes: input.sizeBytes,
    });
    await audit(ctx, 'file.upload_url.created', {
      userId: user.userId,
      metadata: { file: file.publicId, purpose: input.purpose },
    });

    return {
      fileId: file.publicId,
      path: objectKey,
      uploadUrl,
      method: 'PUT',
      contentType: input.mimeType,
    };
  },
};
