import { Router } from 'express';
import { callDb } from '../lib/db';
import { authRouter } from '../modules/auth/auth.routes';
import { companiesRouter } from '../modules/catalog/catalog.routes';
import { creditsRouter } from '../modules/credits/credits.routes';
import { filesRouter } from '../modules/files/files.routes';
import { kycRouter } from '../modules/kyc/kyc.routes';
import { learnRouter } from '../modules/learn/learn.routes';
import { devicesRouter, notificationsRouter } from '../modules/notifications/notifications.routes';
import { reviewsRouter } from '../modules/reviews/reviews.routes';
import { roadshowsRouter } from '../modules/roadshows/roadshows.routes';
import { savedRouter } from '../modules/saved/saved.routes';
import { lookupsRouter } from '../modules/users/lookups.routes';
import { meRouter, usersRouter } from '../modules/users/users.routes';
import { webinarsRouter } from '../modules/webinars/webinars.routes';
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
    await callDb('app_ping', {});
    res.json({ status: 'ok', database: 'ok' });
  } catch {
    res.status(503).json({ status: 'unavailable', database: 'unreachable' });
  }
});

// Everything below: a per-IP request limit, and no caching of any response by proxies or devices.
router.use(apiRateLimit, noStore);

// ===== Auth and onboarding (Phase 1) =====
router.use('/auth', authRouter);

// ---------------------------------------------------------------------------------------------
// Saved items, credits and notifications (the signed-in user's own data)
//   GET / POST /me/saved                 saved companies, issuers, roadshows and learn content
//   DELETE     /me/saved/:type/:id       remove a saved item
//   GET        /me/credits               balance and ledger
//   GET        /me/notifications         inbox (meta.unread = badge count)
//   POST       /me/notifications/read    mark some or all read
//   POST       /me/devices               register a push token
// Mounted before /me so a request is authenticated once, by its own router.
// ---------------------------------------------------------------------------------------------
router.use('/me/saved', noStore, savedRouter);
router.use('/me/credits', noStore, creditsRouter);
router.use('/me/notifications', noStore, notificationsRouter);
router.use('/me/devices', noStore, devicesRouter);

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
// Learn and webinars
//   GET   /learn                         content list (PREMIUM items locked by tier)
//   GET   /learn/:id                     content, report download (Full), own rating
//   POST  /learn/:id/rating              rate 1-5
//   GET   /webinars                      upcoming or past webinars
//   POST  /webinars/:id/register         register
// ---------------------------------------------------------------------------------------------
router.use('/learn', learnRouter);
router.use('/webinars', webinarsRouter);

// ---------------------------------------------------------------------------------------------
// Roadshows (Phase 2)
//   GET   /roadshows                     list (open by default)
//   GET   /roadshows/:id                 issue summary, terms, risk factors, documents
//   GET   /roadshows/:id/financials      3-year financials in a chosen currency
//   GET   /roadshows/:id/documents/:docId  5-minute DD document download (Prive, Inst.)
//   GET   /roadshows/:id/questions       Ask Me Anything (Top Asked, Recently Added, categories)
//   POST  /roadshows/:id/questions       ask a question (Prive)
//   POST  /roadshows/:id/pool            join the Power Pool for 1 credit (Prive)
//   GET   /roadshows/:id/pool-power      participants, capital interest, demand, heat map
//   POST  /roadshows/:id/offers          post an offer (Inst.)
// ---------------------------------------------------------------------------------------------
router.use('/roadshows', roadshowsRouter);

// ---------------------------------------------------------------------------------------------
// Admin (Phase 1): GIG staff only; routes and permissions in src/modules/admin/admin.routes.ts
//   /admin/users, /admin/kyc, /admin/moderation, /admin/companies, /admin/issuers,
//   /admin/representations, /admin/roadshows, /admin/learn, /admin/credits/grant,
//   /admin/audit-logs
// ---------------------------------------------------------------------------------------------
router.use('/admin', adminRouter);
