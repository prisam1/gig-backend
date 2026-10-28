import { z } from 'zod';
import { uuidSchema } from '../../lib/enums';
import { pagination } from '../../lib/http';

/** `upcoming` includes webinars in progress. */
export const WEBINAR_TIMEFRAMES = ['upcoming', 'past'] as const;

// GET /webinars?when=upcoming&page=&pageSize=
export const listWebinarsQuery = z.object({
  ...pagination,
  when: z.enum(WEBINAR_TIMEFRAMES).default('upcoming'),
});
export type ListWebinarsQuery = z.output<typeof listWebinarsQuery>;

export const webinarIdParams = z.object({ id: uuidSchema });
