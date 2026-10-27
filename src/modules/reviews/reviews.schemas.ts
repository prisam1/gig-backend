import { z } from 'zod';
import {
  assetClassSchema,
  countrySchema,
  displayModeSchema,
  investmentStatusSchema,
  reinvestStatusSchema,
  resolutionBucketSchema,
  resolutionStatusSchema,
  reviewStatusSchema,
  sentimentSchema,
  uuidSchema,
} from '../../lib/enums';
import { csv, pagination } from '../../lib/http';

/** Bumped whenever the wording of the reviewer declarations changes. */
export const DECLARATIONS_VERSION = '2026-10';

// Option codes for the app's lists (same values as the review_tags / review_attachments checks).
export const APPRECIATION_CODES = [
  'TRANSPARENT_COMMUNICATION',
  'TIMELY_PAYOUTS',
  'PRODUCT_PERFORMANCE',
  'CUSTOMER_SERVICE',
  'EASE_OF_ONBOARDING',
  'CLAIM_SETTLEMENT',
  'DIGITAL_EXPERIENCE',
  'ETHICAL_CONDUCT',
  'OTHER',
] as const;

export const CONCERN_CODES = [
  'MIS_SELLING',
  'DELAY_IN_RESPONSE',
  'NON_FULFILMENT',
  'HIDDEN_CHARGES',
  'CLAIM_REJECTION',
  'POOR_PERFORMANCE',
  'EXIT_DIFFICULTY',
  'DOCUMENTATION_ISSUE',
  'OTHER',
] as const;

export const CONTACT_STATUS_CODES = [
  'NOT_CONTACTED',
  'CONTACTED_NO_RESPONSE',
  'IN_DISCUSSION',
  'RESOLVED',
  'NOT_RESOLVED',
] as const;

export const EVIDENCE_TYPE_CODES = ['EMAIL', 'STATEMENT', 'POLICY_DOCUMENT', 'SCREENSHOT'] as const;

const option = <T extends readonly [string, ...string[]]>(codes: T) =>
  z.enum(codes, { message: 'Unknown option' });

/** Header that makes POST /reviews safe to retry. */
export { idempotencyHeaders } from '../../lib/idempotency';

const reviewText = (label: string) =>
  z
    .string({ message: `${label} is required` })
    .trim()
    .min(10, { message: `${label} must be at least 10 characters` })
    .max(800, { message: `${label} must be at most 800 characters` });

const metric = z
  .number({ message: 'Rate all 5 metrics' })
  .int()
  .min(1, { message: 'Rate all 5 metrics' })
  .max(5, { message: 'Rating must be between 1 and 5' });

const mustAccept = (message: string) => z.literal(true, { message });

/**
 * A supporting document already uploaded to the private "review-evidence" Storage bucket,
 * under the reviewer's own folder: `<user_id>/<file name>`.
 */
const evidenceItem = z.object({
  path: z
    .string()
    .regex(/^[0-9a-f-]{36}\/[A-Za-z0-9._-]{1,200}$/, { message: 'Invalid file path' }),
  docType: option(EVIDENCE_TYPE_CODES),
});

const currentYear = () => new Date().getUTCFullYear();

const baseReview = z.object({
  // Step 1: entity and product
  companyId: uuidSchema,
  country: countrySchema,
  assetClass: assetClassSchema,
  productScheme: z.string().trim().max(200).default(''),
  /** A year, or "OLDER" for anything before the years the app lists. */
  investmentYear: z.union([
    z
      .number()
      .int()
      .min(1950)
      .refine((y) => y <= currentYear(), { message: 'Year cannot be in the future' }),
    z.literal('OLDER'),
  ]),
  investmentStatus: investmentStatusSchema,

  // Step 4: metrics
  metrics: z.object({
    transparency: metric,
    responsiveness: metric,
    easeOfProcess: metric,
    trustworthiness: metric,
    overallSatisfaction: metric,
  }),

  // Step 5: resolution
  resolutionStatus: resolutionStatusSchema,
  followUpNote: z
    .string()
    .trim()
    .max(400, { message: 'Follow-up note must be at most 400 characters' })
    .optional(),

  // Step 6: declarations and privacy
  displayMode: displayModeSchema.default('FULL_NAME'),
  declarations: z.object({
    kycVerified: mustAccept('Confirm you are a KYC verified investor'),
    genuine: mustAccept('Confirm this review reflects your genuine experience'),
    understandInsights: mustAccept('Confirm you understand how GIG uses aggregated insights'),
    allowContact: z.boolean().default(false),
  }),
});

const positiveReview = baseReview.extend({
  sentiment: z.literal('Positive'),
  appreciations: z
    .array(option(APPRECIATION_CODES))
    .min(1, { message: 'Select at least one appreciation' })
    .max(9),
  detailedReview: reviewText('Review'),
  reinvestStatus: reinvestStatusSchema,
  evidence: z.array(evidenceItem).max(5).default([]),
});

const neutralReview = baseReview.extend({
  sentiment: z.literal('Neutral'),
  mixedReview: reviewText('What was average or mixed'),
  detailedReview: reviewText('Review'),
  evidence: z.array(evidenceItem).max(5).default([]),
});

const negativeReview = baseReview.extend({
  sentiment: z.literal('Negative'),
  concerns: z
    .array(option(CONCERN_CODES))
    .min(1, { message: 'Select at least one concern' })
    .max(9),
  contactStatus: z
    .array(option(CONTACT_STATUS_CODES))
    .min(1, { message: 'Select at least one contact status' })
    .max(5),
  negativeDescription: reviewText('Description'),
  detailedReview: reviewText('Review').optional(),
  evidence: z
    .array(evidenceItem)
    .min(1, { message: 'Attach at least one supporting document' })
    .max(5),
});

export const submitReviewBody = z.discriminatedUnion('sentiment', [
  positiveReview,
  neutralReview,
  negativeReview,
]);
export type SubmitReviewInput = z.output<typeof submitReviewBody>;

export const reviewIdParams = z.object({ id: uuidSchema });

export const updateResolutionBody = z.object({
  resolutionStatus: resolutionStatusSchema,
  /** Omit to keep the current note; send null to clear it. */
  followUpNote: z
    .string()
    .trim()
    .max(400, { message: 'Follow-up note must be at most 400 characters' })
    .nullable()
    .optional(),
});
export type UpdateResolutionInput = z.output<typeof updateResolutionBody>;

export const REVIEW_SORTS = ['recent', 'oldest', 'highest', 'lowest'] as const;
export type ReviewSort = (typeof REVIEW_SORTS)[number];

// GET /companies/:id/reviews?sort=&page=&pageSize=&filter[sentiment]=Negative&...
export const listCompanyReviewsQuery = z.object({
  ...pagination,
  sort: z.enum(REVIEW_SORTS).default('recent'),
  filter: z
    .object({
      sentiment: csv(sentimentSchema).optional(),
      resolution: csv(resolutionBucketSchema).optional(),
      assetClass: csv(assetClassSchema).optional(),
      investedStatus: csv(investmentStatusSchema).optional(),
      year: csv(
        z
          .string()
          .regex(/^\d{4}$/)
          .transform(Number),
      ).optional(),
    })
    .strict()
    .optional(),
});
export type ListCompanyReviewsQuery = z.output<typeof listCompanyReviewsQuery>;

// GET /reviews/me?status=&page=&pageSize=
export const listMyReviewsQuery = z.object({
  ...pagination,
  status: csv(reviewStatusSchema).optional(),
});
export type ListMyReviewsQuery = z.output<typeof listMyReviewsQuery>;
