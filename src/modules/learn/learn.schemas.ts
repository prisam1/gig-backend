import { z } from 'zod';
import { contentAccessSchema, learnFormatSchema, uuidSchema } from '../../lib/enums';
import { csv, pagination } from '../../lib/http';

export const LEARN_SORTS = ['recent', 'top_rated'] as const;
export type LearnSort = (typeof LEARN_SORTS)[number];

// GET /learn?q=&sort=&filter[format]=VIDEO,REPORT&filter[category]=Debt&filter[access]=FREE
export const listLearnQuery = z.object({
  ...pagination,
  q: z.string().trim().max(100).optional(),
  sort: z.enum(LEARN_SORTS).default('recent'),
  filter: z
    .object({
      format: csv(learnFormatSchema).optional(),
      category: csv(z.string().max(60)).optional(),
      access: csv(contentAccessSchema).optional(),
    })
    .strict()
    .optional(),
});
export type ListLearnQuery = z.output<typeof listLearnQuery>;

export const learnIdParams = z.object({ id: uuidSchema });

export const rateLearnBody = z.object({
  rating: z
    .number({ message: 'Rating is required' })
    .int({ message: 'Rating must be a whole number' })
    .min(1, { message: 'Rating must be between 1 and 5' })
    .max(5, { message: 'Rating must be between 1 and 5' }),
});
