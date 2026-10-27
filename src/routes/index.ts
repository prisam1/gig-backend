import { Router } from 'express';
import { supabaseAdmin } from '../lib/supabase';
import { noStore } from '../middleware/requestContext';
import { companiesRouter } from '../modules/catalog/catalog.routes';
import { filesRouter } from '../modules/files/files.routes';
import { kycRouter } from '../modules/kyc/kyc.routes';
import { lookupsRouter } from '../modules/lookups/lookups.routes';
import { reviewsRouter } from '../modules/reviews/reviews.routes';
import { meRouter, usersRouter } from '../modules/users/users.routes';

export const router = Router();

router.get('/health', (_req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

// Readiness: the process can also reach the database.
router.get('/health/ready', async (_req, res) => {
  const { error } = await supabaseAdmin.from('lookup_options').select('code').limit(1);
  if (error) {
    res.status(503).json({ status: 'unavailable', database: 'unreachable' });
    return;
  }
  res.json({ status: 'ok', database: 'ok' });
});

// Sign-up, login, OTP and sessions are handled by Supabase Auth in the app. The API accepts its
// access tokens (src/lib/auth.ts) and creates the GIG user on the first request.

// ===== Users, profile and KYC (Phase 1) =====
router.use('/me', noStore, meRouter);
router.use('/users', usersRouter);
router.use('/files', filesRouter);
router.use('/kyc', noStore, kycRouter);
router.use('/lookups', lookupsRouter);

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
