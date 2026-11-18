import { Router } from 'express';
import { parse, sendData } from '../../lib/http';
import { authUser, requireAuth } from '../../middleware/auth';
import {
  idempotencyHeaders,
  reviewIdParams,
  submitReviewBody,
  updateResolutionBody,
} from './reviews.schemas';
import { submitReview, updateResolution } from './reviews.service';

export const reviewsRouter = Router();

// Any signed-in member (as in the app): submit the 6-step review. Returns the receipt.
// Needs an Idempotency-Key header; a retry with the same key and body returns the same review.
reviewsRouter.post('/', requireAuth, async (req, res) => {
  const { 'Idempotency-Key': key } = parse(idempotencyHeaders, {
    'Idempotency-Key': req.get('Idempotency-Key'),
  });
  const body = parse(submitReviewBody, req.body);
  const { receipt, replayed } = await submitReview(authUser(req), body, key);
  if (replayed) res.set('Idempotent-Replayed', 'true');
  sendData(res, receipt, 201);
});

// The reviewer only: update resolution status and follow-up note.
reviewsRouter.patch('/:id/resolution', requireAuth, async (req, res) => {
  const { id } = parse(reviewIdParams, req.params);
  const body = parse(updateResolutionBody, req.body);
  sendData(res, await updateResolution(authUser(req), id, body));
});
