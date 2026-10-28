import { z } from 'zod';
import {
  currencySchema,
  poolExpectationSchema,
  questionCategorySchema,
  uuidSchema,
} from '../../lib/enums';
import { csv, pagination } from '../../lib/http';

export const roadshowIdParams = z.object({ id: uuidSchema });
export const documentParams = z.object({ id: uuidSchema, docId: uuidSchema });

// ---------------------------------------------------------------------------------------------
// Roadshow list and financials
// ---------------------------------------------------------------------------------------------

export const ROADSHOW_SORTS = ['closing_soon', 'recent'] as const;
export type RoadshowSort = (typeof ROADSHOW_SORTS)[number];

/** OPEN: still taking interest (closes in the future). */
export const ROADSHOW_STATES = ['OPEN', 'CLOSED', 'ALL'] as const;

const booleanFlag = z.enum(['true', 'false']).transform((v) => v === 'true');

// GET /roadshows?q=&state=OPEN&sort=closing_soon&filter[poolEnabled]=true&page=&pageSize=
export const listRoadshowsQuery = z.object({
  ...pagination,
  q: z.string().trim().max(100).optional(),
  state: z.enum(ROADSHOW_STATES).default('OPEN'),
  sort: z.enum(ROADSHOW_SORTS).default('closing_soon'),
  filter: z
    .object({
      poolEnabled: booleanFlag.optional(),
      currency: csv(currencySchema).optional(),
    })
    .strict()
    .optional(),
});
export type ListRoadshowsQuery = z.output<typeof listRoadshowsQuery>;

// GET /roadshows/:id/financials?currency=USD (default: the roadshow's own currency)
export const financialsQuery = z.object({
  currency: currencySchema.optional(),
});

// ---------------------------------------------------------------------------------------------
// Ask Me Anything
// ---------------------------------------------------------------------------------------------

/** `top` is the app's "Top Asked" tab, `recent` its "Recently Added" tab. */
export const QUESTION_SORTS = ['top', 'recent'] as const;
export type QuestionSort = (typeof QUESTION_SORTS)[number];

// GET /roadshows/:id/questions?sort=top&category=EQUITY,DEBT&q=&page=&pageSize=
export const listQuestionsQuery = z.object({
  ...pagination,
  q: z.string().trim().max(100).optional(),
  sort: z.enum(QUESTION_SORTS).default('recent'),
  category: csv(questionCategorySchema).optional(),
});
export type ListQuestionsQuery = z.output<typeof listQuestionsQuery>;

export const askQuestionBody = z.object({
  question: z
    .string({ message: 'Question is required' })
    .trim()
    .min(10, { message: 'Question must be at least 10 characters' })
    .max(500, { message: 'Question must be at most 500 characters' }),
  category: questionCategorySchema.default('GENERAL'),
});
export type AskQuestionInput = z.output<typeof askQuestionBody>;

// ---------------------------------------------------------------------------------------------
// Power Pool and offers
// ---------------------------------------------------------------------------------------------

/** numeric(18, 2) holds up to 10^16; keep well inside it. */
const MAX_AMOUNT = 1e15;

const hasAtMostTwoDecimals = (v: number) => Math.abs(v * 100 - Math.round(v * 100)) < 1e-6;

const amount = (label: string) =>
  z
    .number({ message: `${label} must be a number` })
    .positive({ message: `${label} must be more than 0` })
    .max(MAX_AMOUNT, { message: `${label} is too large` })
    .refine(hasAtMostTwoDecimals, { message: `${label} can have at most 2 decimal places` });

const percentage = (min: number, max: number) =>
  z
    .number({ message: 'Must be a number' })
    .min(min, { message: `Must be at least ${min}` })
    .max(max, { message: `Must be at most ${max}` });

const terms = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max, { message: `Must be at most ${max} characters` });

export const MIN_POOL_EXPECTATIONS = 3;

export const joinPoolBody = z.object({
  /** In the roadshow's currency. */
  capitalInterest: amount('Capital interest'),
  expectations: z
    .array(poolExpectationSchema)
    .min(MIN_POOL_EXPECTATIONS, { message: 'Pick at least 3 expectations' })
    .max(poolExpectationSchema.options.length)
    .refine((list) => new Set(list).size === list.length, {
      message: 'Each expectation can be picked once',
    }),
});
export type JoinPoolInput = z.output<typeof joinPoolBody>;

export const postOfferBody = z
  .object({
    offerPrice: amount('Offer price').optional(),
    /** Defaults to the roadshow's currency. */
    currency: currencySchema.optional(),
    expectedRoi: percentage(-100, 1000).optional(),
    expectedIrr: percentage(-100, 1000).optional(),
    entryLoad: percentage(0, 100).optional(),
    exitLoad: percentage(0, 100).optional(),
    lockInMonths: z.number().int().min(0).max(600).optional(),
    minInvestment: amount('Minimum investment').optional(),
    allotmentTerms: terms(400).optional(),
    paymentTerms: terms(400).optional(),
    notes: terms(2000).optional(),
  })
  .strict()
  .refine(
    (offer) =>
      offer.offerPrice !== undefined ||
      offer.expectedRoi !== undefined ||
      offer.expectedIrr !== undefined,
    { message: 'Give an offer price, expected ROI or expected IRR' },
  );
export type PostOfferInput = z.output<typeof postOfferBody>;
