import { supabaseAdmin } from '../../lib/supabase';

export const filesStorage = {
  /** A one-time URL the app PUTs the file to. Supabase keeps it valid for 2 hours. */
  async createUploadUrl(bucket: string, objectKey: string): Promise<string> {
    const { data, error } = await supabaseAdmin.storage
      .from(bucket)
      .createSignedUploadUrl(objectKey);
    if (error) throw new Error(`Storage error: ${error.message}`);
    return data.signedUrl;
  },

  /** URL of an object in a public bucket (avatars). */
  publicUrl(bucket: string, objectKey: string): string {
    return supabaseAdmin.storage.from(bucket).getPublicUrl(objectKey).data.publicUrl;
  },

  /** Whether the app has finished uploading the object. Throws on storage errors other than 4xx. */
  async exists(bucket: string, objectKey: string): Promise<boolean> {
    const { data } = await supabaseAdmin.storage.from(bucket).exists(objectKey);
    return data;
  },

  /** Writes (or overwrites) an object, e.g. a generated receipt PDF. */
  async upload(
    bucket: string,
    objectKey: string,
    body: Uint8Array,
    contentType: string,
  ): Promise<void> {
    const { error } = await supabaseAdmin.storage
      .from(bucket)
      .upload(objectKey, body, { contentType, upsert: true });
    if (error) throw new Error(`Storage error: ${error.message}`);
  },

  /** A short-lived download URL for an object in a private bucket. */
  async createDownloadUrl(
    bucket: string,
    objectKey: string,
    expiresInSeconds: number,
  ): Promise<string> {
    const { data, error } = await supabaseAdmin.storage
      .from(bucket)
      .createSignedUrl(objectKey, expiresInSeconds);
    if (error) throw new Error(`Storage error: ${error.message}`);
    return data.signedUrl;
  },
};
