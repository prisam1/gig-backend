import { Router } from 'express';
import { companiesRouter } from '../modules/catalog/catalog.routes';
import { reviewsRouter } from '../modules/reviews/reviews.routes';

export const router = Router();

router.get('/health', (_req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

// ---------------------------------------------------------------------------------------------
// Catalog and reviews (Phase 1)
//   GET   /companies                     list with filters
//   GET   /companies/compare?ids=a,b     side-by-side metrics
//   GET   /companies/:id                 header, sentiment split, scorecard
//   GET   /companies/:id/trends          12M / 24M / ALL trends
//   GET   /companies/:id/reviews         published reviews
//   POST  /reviews                       submit the 6-step review
//   GET   /reviews/me                    my reviews
//   GET   /reviews/:id                   review receipt
//   PATCH /reviews/:id/resolution        update resolution status and follow-up note
// ---------------------------------------------------------------------------------------------
router.use('/companies', companiesRouter);
router.use('/reviews', reviewsRouter);
