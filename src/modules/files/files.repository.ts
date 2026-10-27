import { callDb } from '../../lib/db';
import type { FilePurpose } from '../../types/domain';

export interface StoredFile {
  id: string;
  publicId: string;
  purpose: FilePurpose;
  bucket: string;
  objectKey: string;
  mimeType: string;
  sizeBytes: number;
}

export type NewFile = Omit<StoredFile, 'id' | 'publicId'> & { ownerId: string };

export const filesRepository = {
  create(file: NewFile): Promise<StoredFile> {
    return callDb('app_create_file', {
      p_owner_id: file.ownerId,
      p_purpose: file.purpose,
      p_bucket: file.bucket,
      p_object_key: file.objectKey,
      p_mime_type: file.mimeType,
      p_size_bytes: file.sizeBytes,
    });
  },

  /** Files with the given public IDs that belong to `ownerId`; unknown or foreign IDs are omitted. */
  async findOwned(ownerId: string, publicIds: string[]): Promise<StoredFile[]> {
    if (publicIds.length === 0) return [];
    return callDb('app_find_owned_files', { p_owner_id: ownerId, p_public_ids: publicIds });
  },
};
