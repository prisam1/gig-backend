import { z } from 'zod';
import { csv, pagination } from '../../lib/http';
import { RATING_FLAGS } from '../../types/domain';

export const issuerIdParams = z.strictObject({ id: z.uuid('Invalid issuer ID') });

// ---------------------------------------------------------------------------------------------
// GET /issuers
// ---------------------------------------------------------------------------------------------

export const ISSUER_SORTS = ['recent', 'closing_soon', 'top_rated', 'most_rated'] as const;
export type IssuerSort = (typeof ISSUER_SORTS)[number];

export const listIssuersQuery = z.object({
  ...pagination,
  /** Matches issuer name or instrument. */
  q: z.string().trim().min(1).max(100).optional(),
  sort: z.enum(ISSUER_SORTS).default('recent'),
  filter: z
    .strictObject({
      assetType: csv(z.string().trim().min(1).max(40)).optional(),
      listed: z
        .enum(['true', 'false'])
        .transform((value) => value === 'true')
        .optional(),
    })
    .optional(),
});
export type ListIssuersQuery = z.infer<typeof listIssuersQuery>;

// ---------------------------------------------------------------------------------------------
// POST /issuers/:id/ratings
// ---------------------------------------------------------------------------------------------

/** Option codes (RATING_FACTOR / RISK_FACTOR lookups); whether they are active is checked later. */
const optionCode = (message: string) => z.string().regex(/^[A-Z0-9_]{1,40}$/, message);

const hasNoDuplicates = (codes: string[]) => new Set(codes).size === codes.length;

export const RISK_FACTORS_PER_RATING = 3;

export const submitRatingBody = z.strictObject({
  overallScore: z
    .number({ message: 'Rate the issuer from 1 to 5' })
    .int('Rate the issuer from 1 to 5')
    .min(1, 'Rate the issuer from 1 to 5')
    .max(5, 'Rate the issuer from 1 to 5'),
  /** A flag for every rating factor; completeness is checked against the active factor list. */
  factors: z
    .array(
      z.strictObject({
        code: optionCode('Unknown rating factor'),
        flag: z.enum(RATING_FLAGS, { message: 'Flag must be POSITIVE, NEUTRAL or NEGATIVE' }),
      }),
    )
    .min(1, 'Flag every rating factor')
    .max(50)
    .refine((factors) => hasNoDuplicates(factors.map((f) => f.code)), 'Flag each factor once'),
  riskFactors: z
    .array(optionCode('Unknown risk factor'))
    .length(RISK_FACTORS_PER_RATING, 'Select exactly 3 risk factors')
    .refine(hasNoDuplicates, 'Select 3 different risk factors'),
});
export type SubmitRatingInput = z.infer<typeof submitRatingBody>;
