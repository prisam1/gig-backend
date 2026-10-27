import { supabaseAdmin, unwrap } from '../../lib/supabase';
import type { Tables } from '../../types/database';
import type { FilePurpose } from '../../types/domain';

export interface StoredFile {
  id: number;
  publicId: string;
  purpose: FilePurpose;
  bucket: string;
  objectKey: string;
  mimeType: string;
  sizeBytes: number;
}

const FILE_COLUMNS = 'id, public_id, purpose, bucket, object_key, mime_type, size_bytes';

type FileRow = Pick<
  Tables<'files'>,
  'id' | 'public_id' | 'purpose' | 'bucket' | 'object_key' | 'mime_type' | 'size_bytes'
>;

function toStoredFile(row: FileRow): StoredFile {
  return {
    id: row.id,
    publicId: row.public_id,
    purpose: row.purpose,
    bucket: row.bucket,
    objectKey: row.object_key,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
  };
}

export type NewFile = Omit<StoredFile, 'id' | 'publicId'> & { ownerId: number };

export const filesRepository = {
  async create(file: NewFile): Promise<StoredFile> {
    const row = unwrap(
      await supabaseAdmin
        .from('files')
        .insert({
          owner_id: file.ownerId,
          purpose: file.purpose,
          bucket: file.bucket,
          object_key: file.objectKey,
          mime_type: file.mimeType,
          size_bytes: file.sizeBytes,
        })
        .select(FILE_COLUMNS)
        .single(),
    );
    return toStoredFile(row);
  },

  /** Files with the given public IDs that belong to `ownerId`; unknown or foreign IDs are omitted. */
  async findOwned(ownerId: number, publicIds: string[]): Promise<StoredFile[]> {
    const rows = unwrap(
      await supabaseAdmin
        .from('files')
        .select(FILE_COLUMNS)
        .eq('owner_id', ownerId)
        .in('public_id', publicIds),
    );
    return rows.map(toStoredFile);
  },
};
