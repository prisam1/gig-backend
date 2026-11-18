import { Router } from 'express';
import { z } from 'zod';
import { callDb } from '../../lib/db';
import { sendData } from '../../lib/http';
import { HttpError } from '../../middleware/errorHandler';
import { parse } from '../../middleware/validate';

/**
 * `/content/:key`: blocks of screen content stored as the app shows them (public.app_content),
 * e.g. `review.compare` (the Compare screen) and `filters.sheet` (the filter sheet).
 */
export const contentRouter = Router();

const contentKeyParams = z.strictObject({
  key: z.string().regex(/^[a-z0-9]+(\.[a-z0-9-]+)+$/, 'Unknown content'),
});

// GET /content/:key — Public: one stored content block.
contentRouter.get('/:key', async (req, res) => {
  const { key } = parse(contentKeyParams, req.params);
  const value = await callDb('app_get_content', { p_key: key });
  if (value === null || value === undefined) throw new HttpError(404, 'Content not found');
  sendData(res, value);
});
