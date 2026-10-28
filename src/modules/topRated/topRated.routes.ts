import { Router } from 'express';
import { z } from 'zod';
import { pagination, parse, sendPage } from '../../lib/http';
import { listCompanies } from '../catalog/catalog.service';
import { ratingsService } from '../ratings/ratings.service';

/** `/top-rated`: dashboard leaderboards, highest-rated companies or issuers first. */
export const topRatedRouter = Router();

export const topRatedQuery = z.object({
  ...pagination,
  type: z.enum(['company', 'issuer']).default('company'),
});

// GET /top-rated?type=company|issuer — Public.
topRatedRouter.get('/', async (req, res) => {
  const { type, page, pageSize } = parse(topRatedQuery, req.query);
  const { items, meta } =
    type === 'issuer'
      ? await ratingsService.listIssuers({ page, pageSize, sort: 'top_rated' })
      : await listCompanies({ page, pageSize, sort: 'top_rated' });
  sendPage(res, items, meta);
});
