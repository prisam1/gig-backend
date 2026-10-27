import { Router } from 'express';
import { idempotencyKeyOf } from '../../lib/idempotency';
import { parse, sendData, sendPage } from '../../lib/http';
import {
  currentUser,
  optionalUser,
  requireFullAccess,
  requireInstitutional,
  requireUser,
  requireVerifiedPrive,
} from '../../middleware/auth';
import { noStore } from '../../middleware/requestContext';
import { getPoolPower, joinPool } from './pool.service';
import { askQuestion, listQuestions } from './questions.service';
import {
  askQuestionBody,
  documentParams,
  financialsQuery,
  joinPoolBody,
  listQuestionsQuery,
  listRoadshowsQuery,
  postOfferBody,
  roadshowIdParams,
} from './roadshows.schemas';
import {
  getDocumentDownload,
  getFinancials,
  getRoadshow,
  listRoadshows,
  postOffer,
} from './roadshows.service';

export const roadshowsRouter = Router();

// GET /roadshows — Public: published roadshows (open ones by default).
roadshowsRouter.get('/', async (req, res) => {
  const { items, meta } = await listRoadshows(parse(listRoadshowsQuery, req.query));
  sendPage(res, items, meta);
});

// GET /roadshows/:id — Public: issue summary, issue terms, risk factors and DD document list.
roadshowsRouter.get('/:id', optionalUser, async (req, res) => {
  const { id } = parse(roadshowIdParams, req.params);
  sendData(res, await getRoadshow(id, req.user));
});

// GET /roadshows/:id/financials?currency=INR — User: 3-year financials in the chosen currency.
roadshowsRouter.get('/:id/financials', requireUser, async (req, res) => {
  const { id } = parse(roadshowIdParams, req.params);
  const { currency } = parse(financialsQuery, req.query);
  sendData(res, await getFinancials(id, currency));
});

// GET /roadshows/:id/documents/:docId — verified Prive and Institutional: 5-minute download URL.
roadshowsRouter.get(
  '/:id/documents/:docId',
  noStore,
  requireUser,
  requireFullAccess,
  async (req, res) => {
    const { id, docId } = parse(documentParams, req.params);
    sendData(res, await getDocumentDownload(id, docId));
  },
);

// GET /roadshows/:id/questions — User: published Ask Me Anything questions and answers.
roadshowsRouter.get('/:id/questions', requireUser, async (req, res) => {
  const { id } = parse(roadshowIdParams, req.params);
  const { items, meta } = await listQuestions(id, parse(listQuestionsQuery, req.query));
  sendPage(res, items, meta);
});

// POST /roadshows/:id/questions — Prive: ask a question; published after moderation.
roadshowsRouter.post('/:id/questions', requireUser, requireVerifiedPrive, async (req, res) => {
  const { id } = parse(roadshowIdParams, req.params);
  const body = parse(askQuestionBody, req.body);
  sendData(res, await askQuestion(currentUser(req), id, body), 201);
});

// POST /roadshows/:id/pool — Prive: join the Power Pool, spending 1 credit.
// Needs an Idempotency-Key header; a retry with the same key and body returns the same membership.
roadshowsRouter.post('/:id/pool', requireUser, requireVerifiedPrive, async (req, res) => {
  const key = idempotencyKeyOf(req);
  const { id } = parse(roadshowIdParams, req.params);
  const body = parse(joinPoolBody, req.body);
  const { membership, replayed } = await joinPool(currentUser(req), id, body, key);
  if (replayed) res.set('Idempotent-Replayed', 'true');
  sendData(res, membership, 201);
});

// GET /roadshows/:id/pool-power — User: participants, capital interest, demand and heat map.
roadshowsRouter.get('/:id/pool-power', requireUser, async (req, res) => {
  const { id } = parse(roadshowIdParams, req.params);
  sendData(res, await getPoolPower(id));
});

// POST /roadshows/:id/offers — Institutional: post an offer for review by GIG.
roadshowsRouter.post('/:id/offers', requireUser, requireInstitutional, async (req, res) => {
  const { id } = parse(roadshowIdParams, req.params);
  const body = parse(postOfferBody, req.body);
  sendData(res, await postOffer(currentUser(req), id, body), 201);
});
