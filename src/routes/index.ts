import { Router } from 'express';
import { callDb } from '../lib/db';
import { authRouter } from '../modules/auth/auth.routes';
import { companiesRouter } from '../modules/catalog/catalog.routes';
import { filesRouter } from '../modules/files/files.routes';
import { kycRouter } from '../modules/kyc/kyc.routes';
import { reviewsRouter } from '../modules/reviews/reviews.routes';
import { lookupsRouter } from '../modules/users/lookups.routes';
import { meRouter, usersRouter } from '../modules/users/users.routes';
import { apiRateLimit, noStore } from '../middleware/requestContext';
import { issuersRouter, ratingsRouter } from '../modules/ratings/ratings.routes';
import { representationsRouter } from '../modules/representations/representations.routes';
import { adminRouter } from '../modules/admin/admin.routes';

export const router = Router();

router.get('/health', (_req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

// Liveness: the process is up. Readiness: it can also reach the database.
router.get('/health/live', (_req, res) => {
  res.json({ status: 'ok' });
});

router.get('/health/ready', async (_req, res) => {
  try {
    await callDb('app_ping');
    res.json({ status: 'ok', database: 'ok' });
  } catch {
    res.status(503).json({ status: 'unavailable', database: 'unreachable' });
  }
});

// Everything below: a per-IP request limit, and no caching of any response by proxies or devices.
router.use(apiRateLimit, noStore);

// ===== Auth and onboarding (Phase 1) =====
router.use('/auth', authRouter);

// ===== Users, profile and KYC (Phase 1) =====
router.use('/me', meRouter);
router.use('/users', usersRouter);
router.use('/files', filesRouter);
router.use('/kyc', kycRouter);
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

// ---------------------------------------------------------------------------------------------
// Ratings (Phase 1)
//   GET   /issuers                         issuers list and offer details
//   GET   /issuers/:id                     issuer offer details
//   GET   /issuers/:id/rating-summary      aggregate score (Prive: weighted, full breakdown)
//   POST  /issuers/:id/ratings             submit a rating; returns the receipt
//   GET   /ratings/me                      my ratings
// ---------------------------------------------------------------------------------------------
router.use('/issuers', issuersRouter);
router.use('/ratings', ratingsRouter);

// ---------------------------------------------------------------------------------------------
// Representations (Phase 1)
//   GET   /representations                 petitions with goal, signatures, days left, status
//   GET   /representations/:id             overview, evidence, signers, my signature
//   GET   /representations/:id/timeline    track status history
//   POST  /representations/:id/signatures  sign; returns signature ID and receipt PDF
//   GET   /representations/:id/submission  download the submitted petition pack
// ---------------------------------------------------------------------------------------------
router.use('/representations', representationsRouter);

// ---------------------------------------------------------------------------------------------
// Admin (Phase 1): GIG staff only; routes and permissions in src/modules/admin/admin.routes.ts
//   /admin/users, /admin/kyc, /admin/moderation, /admin/companies, /admin/issuers,
//   /admin/representations, /admin/credits/grant, /admin/audit-logs
// ---------------------------------------------------------------------------------------------
router.use('/admin', adminRouter);
