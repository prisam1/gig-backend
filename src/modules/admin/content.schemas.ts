import { z } from 'zod';
import {
  assetClassSchema,
  contentAccessSchema,
  contentStatusSchema,
  countrySchema,
  currencySchema,
  learnFormatSchema,
  uuidSchema,
} from '../../lib/enums';
import { csv, pagination } from '../../lib/http';
import {
  REPRESENTATION_DOCUMENT_TYPES,
  REPRESENTATION_TRACK_STATUSES,
  STAFF_TRACK_STATUSES,
} from '../../types/domain';
import { booleanFlag, staffObjectKey, UPLOAD_MIME_TYPES } from './admin.schemas';

// Create and update bodies for the content GIG manages. Each entity has one map of fields with
// no defaults: the create body adds the defaults, the update body makes every field optional, so
// a PATCH only ever changes the fields it sends. Nullable fields take null to clear them.

const text = (min: number, max: number) =>
  z
    .string()
    .trim()
    .min(min, { message: min === 1 ? 'Required' : `Must be at least ${min} characters` })
    .max(max, { message: `Must be at most ${max} characters` });

const optionalText = (max: number) => text(1, max).nullable();

const url = z.url({ message: 'Must be a valid URL' }).max(1000);

export const slugSchema = z
  .string()
  .trim()
  .max(80)
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, {
    message: 'Use lower-case letters, digits and single dashes',
  });

const tagList = (max: number, tagMax: number) =>
  z
    .array(text(1, tagMax))
    .max(max, { message: `At most ${max}` })
    .refine((list) => new Set(list.map((t) => t.toLowerCase())).size === list.length, {
      message: 'Each entry can be given once',
    });

const hasAtMostTwoDecimals = (v: number) => Math.abs(v * 100 - Math.round(v * 100)) < 1e-6;

/** numeric(18, 2): non-negative, at most 2 decimals, well inside the column's range. */
const money = z
  .number({ message: 'Must be a number' })
  .min(0, { message: 'Cannot be negative' })
  .max(1e15, { message: 'Too large' })
  .refine(hasAtMostTwoDecimals, { message: 'At most 2 decimal places' });

const instant = z.iso.datetime({ offset: true, message: 'Use an ISO 8601 date-time' });
const day = z.iso.date({ message: 'Use YYYY-MM-DD' });

const atLeastOneField = (body: object) => Object.keys(body).length > 0;
const NOTHING_TO_UPDATE = { message: 'Send at least one field to change' };

/** ?state= for lists of soft-deletable content. */
const deletedState = z.enum(['ACTIVE', 'DELETED', 'ALL']).default('ACTIVE');

// ---------------------------------------------------------------------------------------------
// Companies
// ---------------------------------------------------------------------------------------------

const companyFields = {
  /** Generated from the name when omitted. */
  slug: slugSchema,
  name: text(2, 120),
  assetClass: assetClassSchema,
  country: countrySchema,
  logoUrl: url.nullable(),
  description: optionalText(2000),
  verified: z.boolean(),
  /** Replaces all tags, in display order. */
  tags: tagList(20, 40),
};

export const createCompanyBody = z.strictObject({
  ...companyFields,
  slug: companyFields.slug.optional(),
  logoUrl: companyFields.logoUrl.default(null),
  description: companyFields.description.default(null),
  verified: companyFields.verified.default(false),
  tags: companyFields.tags.default([]),
});
export type CreateCompanyInput = z.output<typeof createCompanyBody>;

export const updateCompanyBody = z
  .strictObject(companyFields)
  .partial()
  .refine(atLeastOneField, NOTHING_TO_UPDATE);
export type UpdateCompanyInput = z.output<typeof updateCompanyBody>;

export const listCompaniesQuery = z.object({
  ...pagination,
  q: z.string().trim().min(1).max(100).optional(),
  state: deletedState,
  sort: z.enum(['recent', 'name']).default('recent'),
  filter: z
    .strictObject({
      assetClass: csv(assetClassSchema).optional(),
      country: csv(countrySchema).optional(),
      verified: booleanFlag.optional(),
    })
    .optional(),
});
export type ListCompaniesQuery = z.output<typeof listCompaniesQuery>;

// ---------------------------------------------------------------------------------------------
// Issuers
// ---------------------------------------------------------------------------------------------

const issuerFields = {
  slug: slugSchema,
  name: text(2, 120),
  instrument: text(1, 60),
  assetType: text(1, 40),
  exchange: optionalText(60),
  openDate: day.nullable(),
  closeDate: day.nullable(),
  isListed: z.boolean(),
  minLot: z.number().int().positive().nullable(),
  lotUnit: text(1, 20),
  priceMin: money.nullable(),
  priceMax: money.nullable(),
  offerSize: money.nullable(),
  currency: currencySchema,
  useOfFunds: optionalText(200),
  lockIn: optionalText(60),
  prePostRatio: optionalText(30),
  tags: tagList(20, 40),
};

/** Date and price ranges, checked on the values the issuer will have after the change. */
export function issuerRangeErrors(issuer: {
  openDate: string | null;
  closeDate: string | null;
  priceMin: number | null;
  priceMax: number | null;
}): Record<string, string> {
  const fields: Record<string, string> = {};
  if (issuer.openDate && issuer.closeDate && issuer.closeDate < issuer.openDate) {
    fields['closeDate'] = 'Must be on or after the open date';
  }
  if (issuer.priceMin !== null && issuer.priceMax !== null && issuer.priceMax < issuer.priceMin) {
    fields['priceMax'] = 'Must be at least the minimum price';
  }
  return fields;
}

export const createIssuerBody = z.strictObject({
  ...issuerFields,
  slug: issuerFields.slug.optional(),
  exchange: issuerFields.exchange.default(null),
  openDate: issuerFields.openDate.default(null),
  closeDate: issuerFields.closeDate.default(null),
  isListed: issuerFields.isListed.default(false),
  minLot: issuerFields.minLot.default(null),
  lotUnit: issuerFields.lotUnit.default('shares'),
  priceMin: issuerFields.priceMin.default(null),
  priceMax: issuerFields.priceMax.default(null),
  offerSize: issuerFields.offerSize.default(null),
  currency: issuerFields.currency.default('INR'),
  useOfFunds: issuerFields.useOfFunds.default(null),
  lockIn: issuerFields.lockIn.default(null),
  prePostRatio: issuerFields.prePostRatio.default(null),
  tags: issuerFields.tags.default([]),
});
export type CreateIssuerInput = z.output<typeof createIssuerBody>;

export const updateIssuerBody = z
  .strictObject(issuerFields)
  .partial()
  .refine(atLeastOneField, NOTHING_TO_UPDATE);
export type UpdateIssuerInput = z.output<typeof updateIssuerBody>;

export const listIssuersQuery = z.object({
  ...pagination,
  q: z.string().trim().min(1).max(100).optional(),
  state: deletedState,
  filter: z
    .strictObject({
      assetType: csv(z.string().max(40)).optional(),
      listed: booleanFlag.optional(),
    })
    .optional(),
});
export type ListIssuersQuery = z.output<typeof listIssuersQuery>;

// ---------------------------------------------------------------------------------------------
// Representations (petitions)
// ---------------------------------------------------------------------------------------------

const representationFields = {
  slug: slugSchema,
  title: text(5, 200),
  /** The card summary. */
  description: z.string().trim().max(500),
  /** Overview tab: what investors ask for. */
  asks: z.array(text(1, 500)).max(10),
  whyItMatters: z.string().trim().max(4000),
  category: optionalText(60),
  country: countrySchema,
  tags: tagList(10, 40),
  regulators: tagList(10, 120),
  /** Signatures needed. */
  goal: z.number().int().min(1).max(10_000_000),
  /** When signing opens; a future date schedules the petition. */
  opensAt: instant,
  closesAt: instant,
};

export const createRepresentationBody = z
  .strictObject({
    ...representationFields,
    slug: representationFields.slug.optional(),
    description: representationFields.description.default(''),
    asks: representationFields.asks.default([]),
    whyItMatters: representationFields.whyItMatters.default(''),
    category: representationFields.category.default(null),
    tags: representationFields.tags.default([]),
    regulators: representationFields.regulators.default([]),
    opensAt: representationFields.opensAt.optional(),
  })
  .refine((b) => new Date(b.closesAt) > new Date(b.opensAt ?? Date.now()), {
    path: ['closesAt'],
    message: 'Must be after the opening date',
  });
export type CreateRepresentationInput = z.output<typeof createRepresentationBody>;

export const updateRepresentationBody = z
  .strictObject(representationFields)
  .partial()
  .refine(atLeastOneField, NOTHING_TO_UPDATE);
export type UpdateRepresentationInput = z.output<typeof updateRepresentationBody>;

export const listRepresentationsQuery = z.object({
  ...pagination,
  q: z.string().trim().min(1).max(100).optional(),
  /** ALL includes deleted petitions. */
  state: z.enum(['ACTIVE', 'ALL']).default('ACTIVE'),
  filter: z
    .strictObject({
      /** The effective status members see. */
      status: csv(z.enum(REPRESENTATION_TRACK_STATUSES)).optional(),
    })
    .optional(),
});
export type ListAdminRepresentationsQuery = z.output<typeof listRepresentationsQuery>;

/** A staff upload (POST /admin/uploads, target REPRESENTATION_DOCUMENT) to attach. */
const representationDocument = z.strictObject({
  title: text(1, 200),
  documentType: z.enum(REPRESENTATION_DOCUMENT_TYPES),
  path: staffObjectKey,
  mimeType: z.enum(UPLOAD_MIME_TYPES),
  sizeBytes: z
    .number()
    .int()
    .min(1)
    .max(25 * 1024 * 1024, { message: 'At most 25 MB' }),
});
export type RepresentationDocumentInput = z.output<typeof representationDocument>;

const documentList = z
  .array(representationDocument)
  .max(10)
  .refine((docs) => new Set(docs.map((d) => d.path)).size === docs.length, {
    message: 'Each file can be attached once',
  });

export const representationStatusBody = z.strictObject({
  status: z.enum(STAFF_TRACK_STATUSES),
  /** Shown in the timeline and sent to every signer. */
  note: text(1, 2000).optional(),
  /** E.g. the submission pack, the regulator's response or meeting minutes. */
  documents: documentList.default([]),
});
export type RepresentationStatusInput = z.output<typeof representationStatusBody>;

export const representationDocumentsBody = z.strictObject({
  documents: documentList.refine((docs) => docs.length > 0, {
    message: 'Attach at least one document',
  }),
});

export const signaturesQuery = z.object({
  ...pagination,
  includeRemoved: booleanFlag.default(false),
});

export const signatureParams = z.strictObject({ id: uuidSchema, signatureId: uuidSchema });

// ---------------------------------------------------------------------------------------------
// Roadshows
// ---------------------------------------------------------------------------------------------

const roadshowFields = {
  slug: slugSchema,
  issuerId: uuidSchema,
  title: text(2, 160),
  summary: optionalText(4000),
  typeOfIssue: text(1, 60),
  instruments: text(1, 60),
  noOfInstruments: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable(),
  offerPrice: money.nullable(),
  /** Currency of the offer price, capital interest and financials. */
  currency: currencySchema,
  lockIn: optionalText(60),
  maturity: optionalText(60),
  convertibility: optionalText(60),
  callable: z.boolean(),
  couponRate: z
    .number()
    .min(0)
    .max(100)
    .refine(hasAtMostTwoDecimals, { message: 'At most 2 decimal places' })
    .nullable(),
  riskFactors: z.array(text(1, 200)).max(20),
  opensAt: instant.nullable(),
  closesAt: instant,
  poolEnabled: z.boolean(),
  /** PUBLISHED makes it visible to members (published_at is set the first time). */
  status: contentStatusSchema,
};

export const createRoadshowBody = z
  .strictObject({
    ...roadshowFields,
    slug: roadshowFields.slug.optional(),
    summary: roadshowFields.summary.default(null),
    noOfInstruments: roadshowFields.noOfInstruments.default(null),
    offerPrice: roadshowFields.offerPrice.default(null),
    currency: roadshowFields.currency.default('INR'),
    lockIn: roadshowFields.lockIn.default(null),
    maturity: roadshowFields.maturity.default(null),
    convertibility: roadshowFields.convertibility.default(null),
    callable: roadshowFields.callable.default(false),
    couponRate: roadshowFields.couponRate.default(null),
    riskFactors: roadshowFields.riskFactors.default([]),
    opensAt: roadshowFields.opensAt.default(null),
    poolEnabled: roadshowFields.poolEnabled.default(false),
    status: roadshowFields.status.default('DRAFT'),
  })
  .refine((b) => !b.opensAt || new Date(b.closesAt) > new Date(b.opensAt), {
    path: ['closesAt'],
    message: 'Must be after the opening date',
  });
export type CreateRoadshowInput = z.output<typeof createRoadshowBody>;

export const updateRoadshowBody = z
  .strictObject(roadshowFields)
  .partial()
  .refine(atLeastOneField, NOTHING_TO_UPDATE);
export type UpdateRoadshowInput = z.output<typeof updateRoadshowBody>;

export const listAdminRoadshowsQuery = z.object({
  ...pagination,
  q: z.string().trim().min(1).max(100).optional(),
  filter: z.strictObject({ status: csv(contentStatusSchema).optional() }).optional(),
});
export type ListAdminRoadshowsQuery = z.output<typeof listAdminRoadshowsQuery>;

const figure = z.number().min(-1e15).max(1e15).nullable().optional();

export const FINANCIAL_METRICS = [
  'revenue',
  'ebitda',
  'netProfit',
  'totalAssets',
  'totalLiabilities',
  'netWorth',
  'totalDebt',
  'cashAndEquivalents',
  'operatingCashFlow',
  'eps',
] as const;

const fiscalYear = z.strictObject({
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
export type FiscalYearInput = z.output<typeof fiscalYear>;

/** Replaces every fiscal year, in the roadshow's currency. */
export const financialsBody = z.strictObject({
  years: z
    .array(fiscalYear)
    .max(10)
    .refine((years) => new Set(years.map((y) => y.fiscalYear)).size === years.length, {
      message: 'Each fiscal year can be given once',
    }),
});

export const ROADSHOW_DOCUMENT_TYPES = [
  'PROSPECTUS',
  'FINANCIAL_STATEMENT',
  'LEGAL_OPINION',
  'RATING_REPORT',
  'DUE_DILIGENCE',
  'OTHER',
] as const;

export const roadshowDocumentBody = z.strictObject({
  title: text(1, 160),
  docType: z.enum(ROADSHOW_DOCUMENT_TYPES),
  /** From POST /admin/uploads with target ROADSHOW_DOCUMENT (PDF). */
  path: staffObjectKey.refine((p) => p.endsWith('.pdf'), {
    message: 'Due-diligence documents must be PDFs',
  }),
  sizeBytes: z.number().int().positive().nullable().default(null),
  sortOrder: z.number().int().min(0).max(1000).default(0),
});
export type RoadshowDocumentInput = z.output<typeof roadshowDocumentBody>;

export const roadshowDocumentParams = z.strictObject({ id: uuidSchema, docId: uuidSchema });

export const questionParams = z.strictObject({ id: uuidSchema, qid: uuidSchema });

export const answerQuestionBody = z.strictObject({
  answer: text(1, 4000),
  /** Pin to the "Top Asked" tab. */
  featured: z.boolean().optional(),
});

// ---------------------------------------------------------------------------------------------
// Learn
// ---------------------------------------------------------------------------------------------

const learnFields = {
  title: text(2, 200),
  summary: optionalText(2000),
  format: learnFormatSchema,
  category: optionalText(60),
  /** PREMIUM: for verified Prive and Institutional members. */
  access: contentAccessSchema,
  thumbnailUrl: url.nullable(),
  contentUrl: url.nullable(),
  durationSeconds: z
    .number()
    .int()
    .positive()
    .max(24 * 3600)
    .nullable(),
  /** From POST /admin/uploads with target LEARN_REPORT (PDF). */
  downloadPath: staffObjectKey
    .refine((p) => p.endsWith('.pdf'), { message: 'Reports must be PDFs' })
    .nullable(),
  status: contentStatusSchema,
};

export const createLearnBody = z.strictObject({
  ...learnFields,
  summary: learnFields.summary.default(null),
  category: learnFields.category.default(null),
  access: learnFields.access.default('FREE'),
  thumbnailUrl: learnFields.thumbnailUrl.default(null),
  contentUrl: learnFields.contentUrl.default(null),
  durationSeconds: learnFields.durationSeconds.default(null),
  downloadPath: learnFields.downloadPath.default(null),
  status: learnFields.status.default('DRAFT'),
});
export type CreateLearnInput = z.output<typeof createLearnBody>;

export const updateLearnBody = z
  .strictObject(learnFields)
  .partial()
  .refine(atLeastOneField, NOTHING_TO_UPDATE);
export type UpdateLearnInput = z.output<typeof updateLearnBody>;

export const listAdminLearnQuery = z.object({
  ...pagination,
  q: z.string().trim().min(1).max(100).optional(),
  filter: z
    .strictObject({
      status: csv(contentStatusSchema).optional(),
      format: csv(learnFormatSchema).optional(),
      access: csv(contentAccessSchema).optional(),
    })
    .optional(),
});
export type ListAdminLearnQuery = z.output<typeof listAdminLearnQuery>;
