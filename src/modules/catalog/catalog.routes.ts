import { Router } from 'express';
import { parse, sendData, sendPage } from '../../lib/http';
import { authUser, optionalAuth, requireAuth, requireFullAccess } from '../../middleware/auth';
import { listCompanyReviewsQuery } from '../reviews/reviews.schemas';
import { listCompanyReviews } from '../reviews/reviews.service';
import { companyIdParams, compareQuery, listCompaniesQuery, trendsQuery } from './catalog.schemas';
import { compareCompanies, getCompany, getCompanyTrends, listCompanies } from './catalog.service';

export const companiesRouter = Router();

// GET /companies — Public: list with filters (sort, sentiment, asset class, resolution,
// avg score, country, invested status, year).
companiesRouter.get('/', async (req, res) => {
  const query = parse(listCompaniesQuery, req.query);
  const { items, meta } = await listCompanies(query);
  sendPage(res, items, meta);
});

// GET /companies/compare?ids=a,b — User: side-by-side metrics.
companiesRouter.get('/compare', requireAuth, async (req, res) => {
  const { ids } = parse(compareQuery, req.query);
  sendData(res, await compareCompanies(ids, authUser(req)));
});

// GET /companies/:id — Public: header, sentiment split, scorecard (Prive: full analytics).
companiesRouter.get('/:id', optionalAuth, async (req, res) => {
  const { id } = parse(companyIdParams, req.params);
  sendData(res, await getCompany(id, req.user));
});

// GET /companies/:id/trends?range=12M|24M|ALL — verified Prive / Institutional.
companiesRouter.get('/:id/trends', requireAuth, requireFullAccess, async (req, res) => {
  const { id } = parse(companyIdParams, req.params);
  const { range } = parse(trendsQuery, req.query);
  sendData(res, await getCompanyTrends(id, range));
});

// GET /companies/:id/reviews — Public: Observer gets summaries; Prive / Inst. get full reviews.
companiesRouter.get('/:id/reviews', optionalAuth, async (req, res) => {
  const { id } = parse(companyIdParams, req.params);
  const query = parse(listCompanyReviewsQuery, req.query);
  const { items, meta } = await listCompanyReviews(id, query, req.user);
  sendPage(res, items, meta);
});
