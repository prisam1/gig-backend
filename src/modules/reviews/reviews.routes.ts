import { Router } from 'express';
import { parse, sendData, sendPage } from '../../lib/http';
import { authUser, requireAuth, requireVerifiedPrive } from '../../middleware/auth';
import {
  idempotencyHeaders,
  listMyReviewsQuery,
  reviewIdParams,
  submitReviewBody,
  updateResolutionBody,
} from './reviews.schemas';
import { getReview, listMyReviews, submitReview, updateResolution } from './reviews.service';

export const reviewsRouter = Router();

// Prive (KYC verified): submit the 6-step review. Returns the receipt.
// Needs an Idempotency-Key header; a retry with the same key and body returns the same review.
reviewsRouter.post('/', requireAuth, requireVerifiedPrive, async (req, res) => {
  const { 'Idempotency-Key': key } = parse(idempotencyHeaders, {
    'Idempotency-Key': req.get('Idempotency-Key'),
  });
  const body = parse(submitReviewBody, req.body);
  const { receipt, replayed } = await submitReview(authUser(req), body, key);
  if (replayed) res.set('Idempotent-Replayed', 'true');
  sendData(res, receipt, 201);
});

// User: my reviews with moderation status.
reviewsRouter.get('/me', requireAuth, async (req, res) => {
  const query = parse(listMyReviewsQuery, req.query);
  const { items, meta } = await listMyReviews(authUser(req), query);
  sendPage(res, items, meta);
});

// User: the review receipt with status timeline (owner), or a published review (others).
reviewsRouter.get('/:id', requireAuth, async (req, res) => {
  const { id } = parse(reviewIdParams, req.params);
  sendData(res, await getReview(authUser(req), id));
});

// Prive (KYC verified), reviewer only: update resolution status and follow-up note.
reviewsRouter.patch('/:id/resolution', requireAuth, requireVerifiedPrive, async (req, res) => {
  const { id } = parse(reviewIdParams, req.params);
  const body = parse(updateResolutionBody, req.body);
  sendData(res, await updateResolution(authUser(req), id, body));
});
