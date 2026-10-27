import { Router } from 'express';
import { parse, sendData, sendPage } from '../../lib/http';
import { authUser, optionalAuth, requireAuth } from '../../middleware/auth';
import { learnIdParams, listLearnQuery, rateLearnBody } from './learn.schemas';
import { getLearnItem, listLearn, rateLearnItem } from './learn.service';

export const learnRouter = Router();

// GET /learn — Public: published content. PREMIUM items are `locked` unless the viewer is a
// verified Prive or Institutional member.
learnRouter.get('/', optionalAuth, async (req, res) => {
  const { items, meta } = await listLearn(parse(listLearnQuery, req.query), req.user);
  sendPage(res, items, meta);
});

// GET /learn/:id — Public: content URL (unless locked), report download (Full members) and the
// member's own rating.
learnRouter.get('/:id', optionalAuth, async (req, res) => {
  const { id } = parse(learnIdParams, req.params);
  sendData(res, await getLearnItem(id, req.user));
});

// POST /learn/:id/rating — User: rate 1-5 (again to change it). Returns the new average.
learnRouter.post('/:id/rating', requireAuth, async (req, res) => {
  const { id } = parse(learnIdParams, req.params);
  const { rating } = parse(rateLearnBody, req.body);
  sendData(res, await rateLearnItem(id, authUser(req), rating));
});
