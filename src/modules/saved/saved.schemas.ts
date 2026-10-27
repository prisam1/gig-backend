import { z } from 'zod';
import { savedEntityTypeSchema, uuidSchema } from '../../lib/enums';
import { csv, pagination } from '../../lib/http';

// GET /me/saved?type=COMPANY,ROADSHOW&page=&pageSize=
export const listSavedQuery = z.object({
  ...pagination,
  type: csv(savedEntityTypeSchema).optional(),
});
export type ListSavedQuery = z.output<typeof listSavedQuery>;

// POST /me/saved { type, id } and DELETE /me/saved/:type/:id
export const savedItemRef = z.object({
  type: savedEntityTypeSchema,
  id: uuidSchema,
});
export type SavedItemRef = z.output<typeof savedItemRef>;
