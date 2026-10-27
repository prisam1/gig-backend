import { z } from 'zod';
import { FILE_PURPOSES } from '../../types/domain';

export const MAX_FILE_BYTES = 10 * 1024 * 1024;

export const createUploadUrlSchema = z.object({
  purpose: z.enum(FILE_PURPOSES),
  mimeType: z.enum(['application/pdf', 'image/jpeg', 'image/png'], {
    error: 'Only PDF, JPG and PNG files are allowed',
  }),
  sizeBytes: z
    .number()
    .int()
    .positive()
    .max(MAX_FILE_BYTES, { error: 'File must be 10 MB or smaller' }),
});

export type CreateUploadUrlInput = z.infer<typeof createUploadUrlSchema>;
