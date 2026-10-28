import { z } from 'zod';
import {
  assetClassSchema,
  contentAccessSchema,
  countrySchema,
  currencySchema,
  learnFormatSchema,
  questionCategorySchema,
} from '../../lib/enums';
import { csv, pagination } from '../../lib/http';
import { KYC_STATUSES, TIERS } from '../../lib/membership';
import { Constants } from '../../types/database';
import {
  MARKET_COUNTRIES,
  RATING_STATUSES,
  REPRESENTATION_DOCUMENT_TYPES,
  REPRESENTATION_TRACK_STATUSES,
  STAFF_ROLES,
  USER_STATUSES,
} from '../../types/domain';

export const idParams = z.strictObject({ id: z.uuid('Invalid ID') });

const search = z.string().trim().min(1).max(254).optional();
const booleanQuery = z.enum(['true', 'false']).transform((value) => value === 'true');
const hasNoDuplicates = (items: string[]) => new Set(items).size === items.length;

/** Why staff made a change. Stored in the audit log. */
const reason = z
  .string({ message: 'Give a reason' })
  .trim()
  .min(3, 'Give a reason of at least 3 characters')
  .max(500, 'Keep the reason under 500 characters');

const nonEmpty = (body: object) => Object.keys(body).length > 0;

// ---------------------------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------------------------

export const USER_SORTS = ['-createdAt', 'createdAt', 'name', '-lastLoginAt'] as const;

export const listUsersQuery = z.object({
  ...pagination,
  /** An exact email, a phone with country code (+919876543210), a user ID, or part of a name. */
  q: search,
  sort: z.enum(USER_SORTS).default('-createdAt'),
  filter: z
    .strictObject({
      tier: csv(z.enum(TIERS)).optional(),
      kycStatus: csv(z.enum(KYC_STATUSES)).optional(),
      status: csv(z.enum(USER_STATUSES)).optional(),
      role: csv(z.enum(STAFF_ROLES)).optional(),
    })
    .optional(),
});
export type ListUsersQuery = z.infer<typeof listUsersQuery>;

export const updateUserBody = z
  .strictObject({
    /** Prive and Institutional need approved KYC. */
    tier: z.enum(TIERS).optional(),
    /** Suspending signs the user out on every device. */
    status: z.enum(['ACTIVE', 'SUSPENDED']).optional(),
    reason,
  })
  .refine(
    (body) => body.tier !== undefined || body.status !== undefined,
    'Change the tier or the status',
  );
export type UpdateUserInput = z.infer<typeof updateUserBody>;

export const setRolesBody = z.strictObject({
  /** Replaces all of the user's staff roles; [] removes staff access. */
  roles: z
    .array(z.enum(STAFF_ROLES))
    .max(STAFF_ROLES.length)
    .refine(hasNoDuplicates, 'List each role once'),
});

export const pageQuery = z.object(pagination);

// ---------------------------------------------------------------------------------------------
// KYC
// ---------------------------------------------------------------------------------------------

export const listKycQuery = z.object({
  ...pagination,
  filter: z
    .strictObject({
      /** Defaults to PENDING: the review queue. */
      status: csv(z.enum(['PENDING', 'APPROVED', 'REJECTED'])).optional(),
      tier: csv(z.enum(['PRIVE', 'INSTITUTIONAL'])).optional(),
    })
    .optional(),
});
export type ListKycQuery = z.infer<typeof listKycQuery>;

export const approveKycBody = z.strictObject({});

export const rejectKycBody = z.strictObject({
  /** Shown to the user in GET /kyc/submissions/me, so they can fix and resubmit. */
  reason: z
    .string({ message: 'Tell the user why' })
    .trim()
    .min(3, 'Tell the user why in at least 3 characters')
    .max(500, 'Keep the reason under 500 characters'),
});

// ---------------------------------------------------------------------------------------------
// Moderation
// ---------------------------------------------------------------------------------------------

/** Reviews, issuer ratings and roadshow (Ask Me Anything) questions. */
export const MODERATION_TYPES = ['REVIEW', 'RATING', 'QUESTION'] as const;
export type ModerationType = (typeof MODERATION_TYPES)[number];

export const MODERATION_DECISIONS = ['APPROVE', 'REQUEST_CHANGES', 'REJECT', 'REMOVE'] as const;

export const moderationQueueQuery = z.object({
  ...pagination,
  filter: z
    .strictObject({
      type: csv(z.enum(MODERATION_TYPES)).optional(),
      /** Defaults to PENDING_MODERATION. */
      status: csv(z.enum(RATING_STATUSES)).optional(),
    })
    .optional(),
});
export type ModerationQueueQuery = z.infer<typeof moderationQueueQuery>;

export const moderationItemQuery = z.object({ type: z.enum(MODERATION_TYPES) });

export const moderationDecisionBody = z
  .strictObject({
    type: z.enum(MODERATION_TYPES),
    decision: z.enum(MODERATION_DECISIONS),
    /** Shown to the author. Required for every decision except APPROVE. */
    note: z.string().trim().min(3, 'Write at least 3 characters').max(2000).optional(),
  })
  .refine((body) => body.decision === 'APPROVE' || body.note !== undefined, {
    message: 'Explain the decision to the author',
    path: ['note'],
  });
export type ModerationDecisionInput = z.infer<typeof moderationDecisionBody>;

// ---------------------------------------------------------------------------------------------
// Content (shared)
// ---------------------------------------------------------------------------------------------

const slug = z
  .string()
  .trim()
  .min(2)
  .max(80)
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'Use lowercase letters, digits and single hyphens');

const tags = (max: number, maxLength = 40) =>
  z
    .array(z.string().trim().min(1).max(maxLength))
    .max(max, `At most ${max} entries`)
    .refine(hasNoDuplicates, 'List each entry once');

const nullableText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .transform((value) => (value === '' ? null : value));

export const contentListQuery = {
  ...pagination,
  q: z.string().trim().min(1).max(100).optional(),
};

// ---------------------------------------------------------------------------------------------
// Companies
// ---------------------------------------------------------------------------------------------

const companyFields = {
  slug,
  name: z.string().trim().min(2).max(120),
  assetClass: assetClassSchema,
  country: countrySchema,
  logoUrl: z.url().max(500).nullable(),
  description: nullableText(2000),
  verified: z.boolean(),
  tags: tags(20),
};

export const createCompanyBody = z.strictObject({
  ...companyFields,
  logoUrl: companyFields.logoUrl.optional(),
  description: companyFields.description.optional(),
  verified: companyFields.verified.default(false),
  tags: companyFields.tags.default([]),
});
export const updateCompanyBody = z
  .strictObject(companyFields)
  .partial()
  .refine(nonEmpty, 'Change at least one field');
/** A create or a partial update: only the fields being set. */
export type CompanyInput = z.infer<typeof updateCompanyBody>;

export const listCompaniesQuery = z.object({
  ...contentListQuery,
  filter: z
    .strictObject({
      assetClass: csv(assetClassSchema).optional(),
      country: csv(countrySchema).optional(),
      verified: booleanQuery.optional(),
      deleted: booleanQuery.optional(),
    })
    .optional(),
});
export type ListCompaniesQuery = z.infer<typeof listCompaniesQuery>;

// ---------------------------------------------------------------------------------------------
// Issuers
// ---------------------------------------------------------------------------------------------

// numeric(18, 2) in the database; 10^15 keeps every value exact in JavaScript too.
const amount = z.number().nonnegative().max(1e15).nullable();
const isoDate = z.iso.date('Use YYYY-MM-DD').nullable();

const issuerFields = {
  slug,
  name: z.string().trim().min(2).max(120),
  instrument: z.string().trim().min(1).max(60),
  assetType: z.string().trim().min(1).max(40),
  exchange: nullableText(60),
  openDate: isoDate,
  closeDate: isoDate,
  isListed: z.boolean(),
  minLot: z.number().int().positive().nullable(),
  lotUnit: z.string().trim().min(1).max(20),
  priceMin: amount,
  priceMax: amount,
  offerSize: amount,
  currency: z.enum(['INR', 'USD', 'EUR', 'GBP', 'AED']),
  useOfFunds: nullableText(200),
  lockIn: nullableText(60),
  prePostRatio: nullableText(30),
  tags: tags(20),
};

// Cross-field rules the database also enforces; checked here when both values are in the request.
function checkIssuerRanges(
  body: Partial<Record<keyof typeof issuerFields, unknown>>,
  ctx: z.RefinementCtx,
) {
  const { priceMin, priceMax, openDate, closeDate } = body;
  if (typeof priceMin === 'number' && typeof priceMax === 'number' && priceMax < priceMin) {
    ctx.addIssue({
      code: 'custom',
      path: ['priceMax'],
      message: 'Must be at least the minimum price',
    });
  }
  if (typeof openDate === 'string' && typeof closeDate === 'string' && closeDate < openDate) {
    ctx.addIssue({
      code: 'custom',
      path: ['closeDate'],
      message: 'Must be on or after the open date',
    });
  }
}

export const createIssuerBody = z
  .strictObject({
    ...issuerFields,
    exchange: issuerFields.exchange.optional(),
    openDate: issuerFields.openDate.optional(),
    closeDate: issuerFields.closeDate.optional(),
    isListed: issuerFields.isListed.default(false),
    minLot: issuerFields.minLot.optional(),
    lotUnit: issuerFields.lotUnit.default('shares'),
    priceMin: issuerFields.priceMin.optional(),
    priceMax: issuerFields.priceMax.optional(),
    offerSize: issuerFields.offerSize.optional(),
    currency: issuerFields.currency.default('INR'),
    useOfFunds: issuerFields.useOfFunds.optional(),
    lockIn: issuerFields.lockIn.optional(),
    prePostRatio: issuerFields.prePostRatio.optional(),
    tags: issuerFields.tags.default([]),
  })
  .superRefine(checkIssuerRanges);
export const updateIssuerBody = z
  .strictObject(issuerFields)
  .partial()
  .refine(nonEmpty, 'Change at least one field')
  .superRefine(checkIssuerRanges);
/** A create or a partial update: only the fields being set. */
export type IssuerInput = z.infer<typeof updateIssuerBody>;

export const listIssuersAdminQuery = z.object({
  ...contentListQuery,
  filter: z
    .strictObject({
      assetType: csv(z.string().trim().min(1).max(40)).optional(),
      listed: booleanQuery.optional(),
      deleted: booleanQuery.optional(),
    })
    .optional(),
});
export type ListIssuersAdminQuery = z.infer<typeof listIssuersAdminQuery>;

// ---------------------------------------------------------------------------------------------
// Representations
// ---------------------------------------------------------------------------------------------

const timestamp = z.iso.datetime({ offset: true, message: 'Use an ISO 8601 date-time' });

const representationFields = {
  slug,
  title: z.string().trim().min(5).max(200),
  description: z.string().trim().max(500),
  asks: tags(10, 300),
  whyItMatters: z.string().trim().max(4000),
  category: nullableText(60),
  country: z.enum(MARKET_COUNTRIES),
  tags: tags(10),
  regulators: tags(10, 100),
  /** Signatures needed. */
  goal: z.number().int().min(1).max(100_000_000),
  /** When the petition appears in the app; defaults to now. */
  opensAt: timestamp,
  closesAt: timestamp,
};

function checkWindow(
  body: { opensAt?: string | null | undefined; closesAt?: string | undefined },
  ctx: z.RefinementCtx,
) {
  const opens = body.opensAt ? Date.parse(body.opensAt) : undefined;
  const closes = body.closesAt ? Date.parse(body.closesAt) : undefined;
  if (closes !== undefined && closes <= (opens ?? Date.now())) {
    ctx.addIssue({ code: 'custom', path: ['closesAt'], message: 'Must be after the opening time' });
  }
}

export const createRepresentationBody = z
  .strictObject({
    ...representationFields,
    description: representationFields.description.default(''),
    asks: representationFields.asks.default([]),
    whyItMatters: representationFields.whyItMatters.default(''),
    category: representationFields.category.optional(),
    tags: representationFields.tags.default([]),
    regulators: representationFields.regulators.default([]),
    opensAt: representationFields.opensAt.optional(),
  })
  .superRefine(checkWindow);
export const updateRepresentationBody = z
  .strictObject(representationFields)
  .partial()
  .refine(nonEmpty, 'Change at least one field')
  .superRefine((body, ctx) => {
    // With only one end of the window in the request, the database checks it against the other.
    if (body.opensAt && body.closesAt) checkWindow(body, ctx);
  });
/** A create or a partial update: only the fields being set. */
export type RepresentationInput = z.infer<typeof updateRepresentationBody>;

export const listRepresentationsAdminQuery = z.object({
  ...contentListQuery,
  filter: z
    .strictObject({
      status: csv(z.enum(REPRESENTATION_TRACK_STATUSES)).optional(),
      country: csv(z.enum(MARKET_COUNTRIES)).optional(),
      deleted: booleanQuery.optional(),
    })
    .optional(),
});
export type ListRepresentationsAdminQuery = z.infer<typeof listRepresentationsAdminQuery>;

/** The statuses GIG staff set; Open, Closing Soon and Closed follow the signing window. */
export const STAFF_TRACK_STATUSES = REPRESENTATION_TRACK_STATUSES.slice(3) as [
  'UNDER_REVIEW',
  'SUBMITTED_TO_REGULATOR',
  'MEETING_REQUESTED',
  'MEETING_SCHEDULED',
  'REGULATOR_RESPONDED',
  'RESOLVED',
];

export const MAX_DOCUMENT_BYTES = 25 * 1024 * 1024;
const documentMimeType = z.enum(['application/pdf', 'image/jpeg', 'image/png'], {
  error: 'Only PDF, JPG and PNG files are allowed',
});

export const documentUploadUrlBody = z.strictObject({
  mimeType: documentMimeType,
  sizeBytes: z
    .number()
    .int()
    .positive()
    .max(MAX_DOCUMENT_BYTES, { error: 'File must be 25 MB or smaller' }),
});
export type DocumentUploadUrlInput = z.infer<typeof documentUploadUrlBody>;

const documentInput = z.strictObject({
  /** The objectKey returned by POST /admin/representations/:id/documents/upload-url. */
  objectKey: z
    .string()
    .regex(
      /^[0-9a-f-]{36}\/[0-9a-f-]{36}\.(pdf|jpg|png)$/,
      'Upload the file through upload-url first',
    ),
  title: z.string().trim().min(1).max(200),
  documentType: z.enum(REPRESENTATION_DOCUMENT_TYPES),
  mimeType: documentMimeType,
  sizeBytes: z.number().int().positive().max(MAX_DOCUMENT_BYTES),
});
export type DocumentInput = z.infer<typeof documentInput>;

const documentList = z
  .array(documentInput)
  .max(10, 'Attach at most 10 documents at a time')
  .refine((docs) => hasNoDuplicates(docs.map((d) => d.objectKey)), 'Attach each file once');

export const addDocumentsBody = z.strictObject({
  documents: documentList.min(1, 'Attach at least one document'),
});

export const representationStatusBody = z.strictObject({
  status: z.enum(STAFF_TRACK_STATUSES, { message: 'Choose a status from Under Review onwards' }),
  /** Shown on the petition's timeline. */
  note: z.string().trim().min(1).max(2000).optional(),
  /** Submission pack, regulator response, meeting minutes, ... for this step. */
  documents: documentList.default([]),
});
export type RepresentationStatusInput = z.infer<typeof representationStatusBody>;

// ---------------------------------------------------------------------------------------------
// Roadshows (public.roadshows, 20261027201000_roadshows.sql)
// ---------------------------------------------------------------------------------------------

const contentStatus = z.enum(Constants.public.Enums.content_status);

/** A financial figure in the roadshow's currency; losses are negative. */
const figure = z.number().min(-1e15).max(1e15).nullable().optional();

const financialYear = z.strictObject({
  fiscalYear: z.number().int().min(1990).max(2100),
  revenue: figure,
  ebitda: figure,
  netProfit: figure,
  totalAssets: figure,
  totalLiabilities: figure,
  netWorth: figure,
  totalDebt: figure,
  cashAndEquivalents: figure,
  operatingCashFlow: figure,
  eps: figure,
});

const roadshowFields = {
  slug,
  issuerId: z.uuid('Invalid issuer ID'),
  title: z.string().trim().min(2).max(160),
  summary: nullableText(4000),
  /** e.g. IPO, NCD, Rights issue. */
  typeOfIssue: z.string().trim().min(1).max(60),
  instruments: z.string().trim().min(1).max(60),
  noOfInstruments: z.number().int().positive().max(1e15).nullable(),
  offerPrice: amount,
  /** Of the offer price, capital interest and financials. */
  currency: currencySchema,
  lockIn: nullableText(60),
  maturity: nullableText(60),
  convertibility: nullableText(60),
  callable: z.boolean(),
  couponRate: z.number().min(0).max(100).nullable(),
  riskFactors: tags(20, 300),
  /** When the Power Pool opens; null opens it as soon as the roadshow is published. */
  opensAt: timestamp.nullable(),
  closesAt: timestamp,
  poolEnabled: z.boolean(),
  /** DRAFT, PUBLISHED (shown in the app; the first publication time is kept) or ARCHIVED. */
  status: contentStatus,
  /** Replaces every fiscal year; the app shows the latest 3. */
  financials: z
    .array(financialYear)
    .max(10, 'At most 10 fiscal years')
    .refine(
      (years) => new Set(years.map((y) => y.fiscalYear)).size === years.length,
      'List each fiscal year once',
    ),
};

export const createRoadshowBody = z
  .strictObject(roadshowFields)
  .partial()
  .required({
    slug: true,
    issuerId: true,
    title: true,
    typeOfIssue: true,
    instruments: true,
    closesAt: true,
  })
  .superRefine(checkWindow);
export const updateRoadshowBody = z
  .strictObject(roadshowFields)
  .partial()
  .refine(nonEmpty, 'Change at least one field')
  .superRefine((body, ctx) => {
    if (body.opensAt && body.closesAt) checkWindow(body, ctx);
  });
export type RoadshowInput = z.infer<typeof updateRoadshowBody>;

export const listRoadshowsAdminQuery = z.object({
  ...contentListQuery,
  filter: z
    .strictObject({
      issuer: z.uuid('Invalid issuer ID').optional(),
      /** Defaults to DRAFT and PUBLISHED; ask for ARCHIVED to see archived roadshows. */
      status: csv(contentStatus).optional(),
      /** Published, opened and not yet closed. */
      open: booleanQuery.optional(),
    })
    .optional(),
});
export type ListRoadshowsAdminQuery = z.infer<typeof listRoadshowsAdminQuery>;

export const questionParams = z.strictObject({
  id: z.uuid('Invalid roadshow ID'),
  questionId: z.uuid('Invalid question ID'),
});

export const listQuestionsQuery = z.object({
  ...pagination,
  filter: z
    .strictObject({
      status: csv(z.enum(Constants.public.Enums.question_status)).optional(),
      category: csv(questionCategorySchema).optional(),
      answered: booleanQuery.optional(),
    })
    .optional(),
});
export type ListQuestionsQuery = z.infer<typeof listQuestionsQuery>;

export const answerQuestionBody = z.strictObject({
  /** The issuer's answer, published by GIG. Sending it again replaces the answer. */
  answer: z.string({ message: 'Write the answer' }).trim().min(1, 'Write the answer').max(4000),
  /** Picks the question for the "Top Asked" tab (true) or takes it off (false). */
  featured: z.boolean().optional(),
});
export type AnswerQuestionInput = z.infer<typeof answerQuestionBody>;

// ---------------------------------------------------------------------------------------------
// Learn (public.learn_items, 20261027200000_learn_saved_credits_notifications.sql)
// ---------------------------------------------------------------------------------------------

/** Private "learn-reports" bucket for downloadable reports. */
export const LEARN_REPORTS_BUCKET = 'learn-reports';

const learnFields = {
  title: z.string().trim().min(2).max(200),
  summary: nullableText(2000),
  format: learnFormatSchema,
  category: nullableText(60),
  /** PREMIUM content is for Full members (verified Prive and Institutional). */
  access: contentAccessSchema,
  thumbnailUrl: z.url().max(500).nullable(),
  /** Stream or article URL; for PREMIUM items the app returns it to Full members only. */
  contentUrl: z.url().max(1000).nullable(),
  durationSeconds: z.number().int().positive().max(1_000_000).nullable(),
  /** A PDF already uploaded to the learn-reports bucket, e.g. reports/scorecard.pdf. */
  downloadPath: z
    .string()
    .max(300)
    .regex(/^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/, 'Use a path like reports/scorecard.pdf')
    // No . or .. segments: the path names one object, never a step up.
    .refine(
      (path) => !path.split('/').some((segment) => /^\.+$/.test(segment)),
      'Use a path like reports/scorecard.pdf',
    )
    .nullable(),
  /** DRAFT, PUBLISHED (the first publication time is kept) or ARCHIVED. */
  status: contentStatus,
};

export const createLearnBody = z
  .strictObject(learnFields)
  .partial()
  .required({ title: true, format: true });
export const updateLearnBody = z
  .strictObject(learnFields)
  .partial()
  .refine(nonEmpty, 'Change at least one field');
export type LearnInput = z.infer<typeof updateLearnBody>;

export const listLearnAdminQuery = z.object({
  ...contentListQuery,
  filter: z
    .strictObject({
      format: csv(learnFormatSchema).optional(),
      access: csv(contentAccessSchema).optional(),
      /** Defaults to DRAFT and PUBLISHED; ask for ARCHIVED to see archived items. */
      status: csv(contentStatus).optional(),
    })
    .optional(),
});
export type ListLearnAdminQuery = z.infer<typeof listLearnAdminQuery>;

// ---------------------------------------------------------------------------------------------
// Credits
// ---------------------------------------------------------------------------------------------

export const grantCreditsBody = z.strictObject({
  userId: z.uuid('Invalid user ID'),
  /** Positive grants, negative revokes. The balance never goes below zero. */
  delta: z
    .number({ message: 'Give the number of credits' })
    .int('Credits are whole numbers')
    .min(-1000, 'At most 1000 credits at a time')
    .max(1000, 'At most 1000 credits at a time')
    .refine((value) => value !== 0, 'Grant or revoke at least 1 credit'),
  /** Saved as the ledger entry's note (at most 400 characters). */
  reason: reason.max(400, 'Keep the reason under 400 characters'),
});
export type GrantCreditsInput = z.infer<typeof grantCreditsBody>;

// ---------------------------------------------------------------------------------------------
// Audit trail
// ---------------------------------------------------------------------------------------------

export const auditLogsQuery = z.object({
  ...pagination,
  filter: z
    .strictObject({
      /** Exact actions (admin.kyc.approved) or a prefix ending in .* (admin.*). */
      action: csv(
        z
          .string()
          .regex(
            /^[a-z0-9_]+(\.[a-z0-9_]+)*(\.\*)?$/,
            'Use an action name such as admin.kyc.approved or admin.*',
          ),
      ).optional(),
      /** Entries made by this user or about them. */
      user: z.uuid('Invalid user ID').optional(),
      from: timestamp.optional(),
      to: timestamp.optional(),
    })
    .optional(),
});
export type AuditLogsQuery = z.infer<typeof auditLogsQuery>;
