import { z } from 'zod';

/** The tabs whose filter sheet shows counts. */
export const FILTER_SECTIONS = ['reviews', 'representations', 'ratings', 'roadshows'] as const;
export type FilterSection = (typeof FILTER_SECTIONS)[number];

// GET /filters/counts?section=reviews
export const filterCountsQuery = z.strictObject({
  section: z.enum(FILTER_SECTIONS, { message: 'Unknown section' }),
});
export type FilterCountsQuery = z.output<typeof filterCountsQuery>;

/** One option's number: a count of items, or a percentage of them. */
export const filterCountSchema = z.strictObject({
  value: z.number().int().nonnegative(),
  unit: z.enum(['count', 'percent']),
});
export type FilterCount = z.output<typeof filterCountSchema>;

/** Counts by the sheet's option id ("Positive", "MF", "India", "2024", ...). */
export const filterCountsSchema = z.record(z.string().min(1), filterCountSchema);
export type FilterCounts = z.output<typeof filterCountsSchema>;
