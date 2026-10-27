import { randomUUID } from 'node:crypto';
import { validationError } from '../../middleware/errorHandler';
import type { User } from '../users/users.repository';
import type { FilePurpose } from '../../types/domain';
import { filesRepository } from './files.repository';
import type { CreateUploadUrlInput } from './files.schemas';
import { filesStorage } from './files.storage';

const BUCKET_BY_PURPOSE: Record<FilePurpose, string> = {
  AVATAR: 'avatars',
  KYC_DOCUMENT: 'kyc-documents',
  REVIEW_EVIDENCE: 'review-evidence',
};

const EXTENSION_BY_MIME: Record<CreateUploadUrlInput['mimeType'], string> = {
  'application/pdf': 'pdf',
  'image/jpeg': 'jpg',
  'image/png': 'png',
};

export const filesService = {
  async createUploadUrl(user: User, input: CreateUploadUrlInput) {
    if (input.purpose === 'AVATAR' && input.mimeType === 'application/pdf') {
      throw validationError({ mimeType: 'Avatar must be a JPG or PNG image' });
    }

    const bucket = BUCKET_BY_PURPOSE[input.purpose];
    const objectKey = `${user.publicId}/${randomUUID()}.${EXTENSION_BY_MIME[input.mimeType]}`;

    const uploadUrl = await filesStorage.createUploadUrl(bucket, objectKey);
    const file = await filesRepository.create({
      ownerId: user.id,
      purpose: input.purpose,
      bucket,
      objectKey,
      mimeType: input.mimeType,
      sizeBytes: input.sizeBytes,
    });

    return { fileId: file.publicId, uploadUrl, method: 'PUT', contentType: input.mimeType };
  },
};
