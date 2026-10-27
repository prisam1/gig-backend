import { z } from 'zod';
import { csv, pagination } from '../../lib/http';
import { DISPLAY_MODES, MARKET_COUNTRIES, REPRESENTATION_TRACK_STATUSES } from '../../types/domain';

export const representationIdParams = z.strictObject({ id: z.uuid('Invalid representation ID') });

// ---------------------------------------------------------------------------------------------
// GET /representations
// ---------------------------------------------------------------------------------------------

export const REPRESENTATION_SORTS = ['closing_soon', 'recent', 'most_signed', 'progress'] as const;
export type RepresentationSort = (typeof REPRESENTATION_SORTS)[number];

export const listRepresentationsQuery = z.object({
  ...pagination,
  /** Matches title, summary or tags. */
  q: z.string().trim().min(1).max(100).optional(),
  sort: z.enum(REPRESENTATION_SORTS).default('closing_soon'),
  filter: z
    .strictObject({
      status: csv(z.enum(REPRESENTATION_TRACK_STATUSES)).optional(),
      country: csv(z.enum(MARKET_COUNTRIES)).optional(),
      openForSigning: z
        .enum(['true', 'false'])
        .transform((value) => value === 'true')
        .optional(),
    })
    .optional(),
});
export type ListRepresentationsQuery = z.infer<typeof listRepresentationsQuery>;

// ---------------------------------------------------------------------------------------------
// POST /representations/:id/signatures
// ---------------------------------------------------------------------------------------------

const mustAccept = z.literal(true, { message: 'Accept both consent declarations to sign' });

export const signRepresentationBody = z.strictObject({
  /** Full name, initials, or anonymous (counted but never shown). */
  displayMode: z.enum(DISPLAY_MODES, { message: 'Choose how your name is shown' }),
  /** Optional INVESTOR_TYPE lookup code; whether it is active is checked later. */
  investorType: z
    .string()
    .regex(/^[A-Z0-9_]{1,40}$/, 'Unknown investor type')
    .nullish()
    .transform((value) => value ?? null),
  /** A file uploaded through POST /files/upload-url with purpose SIGNATURE (PDF or image). */
  signatureFileId: z.uuid('Upload your signature first'),
  consents: z.strictObject({
    /** "I support this representation being submitted to the regulator(s) listed." */
    supportSubmission: mustAccept,
    /** "I understand my signature is a digital endorsement and may be included in aggregate reporting." */
    digitalEndorsement: mustAccept,
  }),
});
export type SignRepresentationInput = z.infer<typeof signRepresentationBody>;
