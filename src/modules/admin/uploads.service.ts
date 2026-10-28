import { randomUUID } from 'node:crypto';
import { audit } from '../../lib/audit';
import type { Member } from '../../lib/membership';
import { validationError } from '../../middleware/errorHandler';
import type { ClientContext } from '../../middleware/requestContext';
import { filesStorage } from '../files/files.storage';
import type { Permission } from './admin.access';
import type { UploadMimeType, UploadTarget, UploadUrlInput } from './admin.schemas';

const MB = 1024 * 1024;

/** Each staff upload target: its private bucket, accepted types and size cap (as the bucket sets). */
export const UPLOAD_TARGET_CONFIG: Record<
  UploadTarget,
  { bucket: string; mimeTypes: readonly UploadMimeType[]; maxBytes: number; permission: Permission }
> = {
  REPRESENTATION_DOCUMENT: {
    bucket: 'representation-documents',
    mimeTypes: ['application/pdf', 'image/jpeg', 'image/png'],
    maxBytes: 25 * MB,
    permission: 'representations.track',
  },
  ROADSHOW_DOCUMENT: {
    bucket: 'roadshow-documents',
    mimeTypes: ['application/pdf'],
    maxBytes: 50 * MB,
    permission: 'content.manage',
  },
  LEARN_REPORT: {
    bucket: 'learn-reports',
    mimeTypes: ['application/pdf'],
    maxBytes: 50 * MB,
    permission: 'content.manage',
  },
};

const EXTENSION_BY_MIME: Record<UploadMimeType, string> = {
  'application/pdf': 'pdf',
  'image/jpeg': 'jpg',
  'image/png': 'png',
};

/**
 * A one-time upload URL for a staff document. The returned `path` is then sent when attaching the
 * document to a petition, roadshow or learn item, which checks the upload finished.
 */
export async function createStaffUploadUrl(
  actor: Member,
  input: UploadUrlInput,
  ctx: ClientContext,
) {
  const target = UPLOAD_TARGET_CONFIG[input.target];
  if (!target.mimeTypes.includes(input.mimeType)) {
    throw validationError({ mimeType: 'This document must be a PDF' });
  }
  if (input.sizeBytes > target.maxBytes) {
    throw validationError({ sizeBytes: `At most ${target.maxBytes / MB} MB` });
  }

  const path = `staff/${randomUUID()}.${EXTENSION_BY_MIME[input.mimeType]}`;
  const uploadUrl = await filesStorage.createUploadUrl(target.bucket, path);
  await audit(ctx, 'admin.upload_url.created', {
    userId: actor.userId,
    metadata: { target: input.target, bucket: target.bucket, path },
  });
  return { bucket: target.bucket, path, uploadUrl, method: 'PUT', contentType: input.mimeType };
}

/** Field errors for staff uploads that are not in `bucket` yet. */
export async function missingUploads(
  bucket: string,
  paths: { field: string; path: string }[],
): Promise<Record<string, string>> {
  const fields: Record<string, string> = {};
  await Promise.all(
    paths.map(async ({ field, path }) => {
      if (!(await filesStorage.exists(bucket, path)))
        fields[field] = 'File has not been uploaded yet';
    }),
  );
  return fields;
}
