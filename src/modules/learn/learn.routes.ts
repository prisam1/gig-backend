import { Router } from 'express';
import { parse, sendData, sendPage } from '../../lib/http';
import { optionalAuth } from '../../middleware/auth';
import { learnIdParams, listLearnQuery } from './learn.schemas';
import { getLearnItem, listLearn } from './learn.service';

export const learnRouter = Router();

// GET /learn — Public: published content. PREMIUM items are `locked` unless the viewer is a
// verified Prive or Institutional member.
learnRouter.get('/', optionalAuth, async (req, res) => {
  const { items, meta } = await listLearn(parse(listLearnQuery, req.query), req.user);
  sendPage(res, items, meta);
});

// GET /learn/:id — Public: content URL (unless locked) and report download (Full members).
learnRouter.get('/:id', optionalAuth, async (req, res) => {
  const { id } = parse(learnIdParams, req.params);
  sendData(res, await getLearnItem(id, req.user));
});
