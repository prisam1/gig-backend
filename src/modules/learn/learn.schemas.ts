import { z } from 'zod';
import { contentAccessSchema, learnFormatSchema, uuidSchema } from '../../lib/enums';
import { csv, pagination } from '../../lib/http';

export const LEARN_SORTS = [
  'recent',
  'top_rated',
  /** The app's list order. */
  'display',
  /** The app's rating figure, highest first ("Most Relevant", "Improving Trend"). */
  'rating_desc',
  /** The app's "avg" figure, highest first ("Trending", "Most Reviewed"). */
  'avg_desc',
] as const;
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
