import { sql, type Db } from '../../lib/db';
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
  async create(file: NewFile, db: Db = sql): Promise<StoredFile> {
    const [row] = await db<StoredFile[]>`
      insert into app.files (owner_id, purpose, bucket, object_key, mime_type, size_bytes)
      values (${file.ownerId}, ${file.purpose}, ${file.bucket}, ${file.objectKey}, ${file.mimeType},
              ${file.sizeBytes})
      returning id, public_id, purpose, bucket, object_key, mime_type, size_bytes`;
    return row!;
  },

  /** Files with the given public IDs that belong to `ownerId`; unknown or foreign IDs are omitted. */
  async findOwned(ownerId: string, publicIds: string[], db: Db = sql): Promise<StoredFile[]> {
    if (publicIds.length === 0) return [];
    return db<StoredFile[]>`
      select id, public_id, purpose, bucket, object_key, mime_type, size_bytes
      from app.files
      where owner_id = ${ownerId} and public_id in ${db(publicIds)}`;
  },
};
