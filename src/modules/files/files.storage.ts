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
};
