import { supabaseAdmin } from './supabase';

/** Private files (DD documents, reports) are served only through short-lived signed URLs. */
export const DOWNLOAD_URL_TTL_SECONDS = 5 * 60;

export interface SignedDownload {
  url: string;
  expiresAt: string;
}

/** A 5-minute download URL for an object in a private bucket, saved as `fileName`. */
export async function createSignedDownload(
  bucket: string,
  path: string,
  fileName: string,
): Promise<SignedDownload> {
  const { data, error } = await supabaseAdmin.storage
    .from(bucket)
    .createSignedUrl(path, DOWNLOAD_URL_TTL_SECONDS, { download: fileName });
  if (error) throw new Error(`Storage error: ${error.message}`);

  const expiresAt = new Date(Date.now() + DOWNLOAD_URL_TTL_SECONDS * 1000).toISOString();
  return { url: data.signedUrl, expiresAt };
}

/** The last segment of an object path: `reports/scorecard.pdf` -> `scorecard.pdf`. */
export function fileNameOf(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}
