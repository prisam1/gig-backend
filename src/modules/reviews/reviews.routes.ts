import { Router } from 'express';
import { parse, sendData } from '../../lib/http';
import { authUser, requireAuth, requireVerifiedPrive } from '../../middleware/auth';
import {
  idempotencyHeaders,
  reviewIdParams,
  submitReviewBody,
  updateResolutionBody,
} from './reviews.schemas';
import { submitReview, updateResolution } from './reviews.service';

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

// Prive (KYC verified), reviewer only: update resolution status and follow-up note.
reviewsRouter.patch('/:id/resolution', requireAuth, requireVerifiedPrive, async (req, res) => {
  const { id } = parse(reviewIdParams, req.params);
  const body = parse(updateResolutionBody, req.body);
  sendData(res, await updateResolution(authUser(req), id, body));
});
