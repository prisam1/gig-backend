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
