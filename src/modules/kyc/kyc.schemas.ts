import { z } from 'zod';
import { KYC_DOCUMENT_TYPES } from '../../types/domain';

export const submitKycSchema = z.strictObject({
  documents: z
    .array(
      z.strictObject({
        fileId: z.uuid('Invalid file ID'),
        documentType: z.enum(KYC_DOCUMENT_TYPES),
      }),
    )
    .min(1, 'Upload at least one document')
    .max(5, 'Upload at most 5 documents')
    .refine(
      (docs) => new Set(docs.map((doc) => doc.fileId)).size === docs.length,
      'Each file can be attached once',
    ),
  consentAccepted: z.boolean().default(false),
});

export type SubmitKycInput = z.infer<typeof submitKycSchema>;
