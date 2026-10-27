import { Router } from 'express';
import { sendData, sendPage } from '../../lib/http';
import { readIdempotencyKey, REPLAYED_HEADER } from '../../lib/idempotency';
import { getAuth, optionalAuth, requireAuth, requireVerifiedPrive } from '../../middleware/auth';
import { clientContext } from '../../middleware/requestContext';
import { parse } from '../../middleware/validate';
import {
  issuerIdParams,
  listIssuersQuery,
  listMyRatingsQuery,
  submitRatingBody,
} from './ratings.schemas';
import { ratingsService } from './ratings.service';

export const issuersRouter = Router();

// GET /issuers — Public: issuers list with offer terms and aggregate score.
issuersRouter.get('/', async (req, res) => {
  const { items, meta } = await ratingsService.listIssuers(parse(listIssuersQuery, req.query));
  sendPage(res, items, meta);
});

// GET /issuers/:id — Public: offer details.
issuersRouter.get('/:id', async (req, res) => {
  const { id } = parse(issuerIdParams, req.params);
  sendData(res, await ratingsService.getIssuer(id));
});

// GET /issuers/:id/rating-summary — Public: aggregate score; verified Prive / Institutional also
// get the weighted score and the full breakdown.
issuersRouter.get('/:id/rating-summary', optionalAuth, async (req, res) => {
  const { id } = parse(issuerIdParams, req.params);
  sendData(res, await ratingsService.getRatingSummary(id, req.user));
});

// POST /issuers/:id/ratings — Prive (KYC verified): overall 1-5, all factor flags, exactly 3 risk
// factors. Needs an Idempotency-Key header; returns the receipt.
issuersRouter.post('/:id/ratings', requireAuth, requireVerifiedPrive, async (req, res) => {
  const { id } = parse(issuerIdParams, req.params);
  const idempotencyKey = readIdempotencyKey(req);
  const input = parse(submitRatingBody, req.body);

  const { result, replayed } = await ratingsService.submitRating(
    getAuth(req),
    id,
    input,
    idempotencyKey,
    clientContext(req),
  );
  if (replayed) res.set(REPLAYED_HEADER, 'true');
  sendData(res, result, 201);
});

export const ratingsRouter = Router();

// GET /ratings/me — User: my ratings with moderation status.
ratingsRouter.get('/me', requireAuth, async (req, res) => {
  const { items, meta } = await ratingsService.listMyRatings(
    getAuth(req),
    parse(listMyRatingsQuery, req.query),
  );
  sendPage(res, items, meta);
});
