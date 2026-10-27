import { z } from 'zod';
import {
  assetClassSchema,
  countrySchema,
  investmentStatusSchema,
  resolutionBucketSchema,
  sentimentSchema,
  uuidSchema,
} from '../../lib/enums';
import { csv, pagination } from '../../lib/http';

export const COMPANY_SORTS = [
  'relevant',
  'recent',
  'trending',
  'top_rated',
  'most_reviewed',
  'improving',
] as const;
export type CompanySort = (typeof COMPANY_SORTS)[number];

/** `2024` or `before_2021`. */
const yearCode = z
  .string()
  .regex(/^(\d{4}|before_\d{4})$/, { message: 'Use a year (2024) or before_YYYY' });

const scoreCode = z.enum(['1', '2', '3', '4', '5']).transform(Number);

// GET /companies?q=&sort=&page=&pageSize=&filter[sentiment]=Positive,Neutral&...
export const listCompaniesQuery = z.object({
  ...pagination,
  q: z.string().trim().max(100).optional(),
  sort: z.enum(COMPANY_SORTS).default('relevant'),
  filter: z
    .object({
      sentiment: csv(sentimentSchema).optional(),
      assetClass: csv(assetClassSchema).optional(),
      resolution: csv(resolutionBucketSchema).optional(),
      score: csv(scoreCode).optional(),
      country: csv(countrySchema).optional(),
      investedStatus: csv(investmentStatusSchema).optional(),
      year: csv(yearCode).optional(),
    })
    .strict()
    .optional(),
});
export type ListCompaniesQuery = z.output<typeof listCompaniesQuery>;

export const companyIdParams = z.object({ id: uuidSchema });

// GET /companies/compare?ids=a,b
export const compareQuery = z.object({
  ids: csv(uuidSchema).pipe(
    z.array(z.string()).min(2, { message: 'Compare at least 2 companies' }).max(4, {
      message: 'Compare at most 4 companies',
    }),
  ),
});

export const TREND_RANGES = ['12M', '24M', 'ALL'] as const;
export type TrendRange = (typeof TREND_RANGES)[number];

export const trendsQuery = z.object({
  range: z.enum(TREND_RANGES).default('12M'),
});
