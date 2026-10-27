import { Router } from 'express';
import { sendData, sendPage } from '../../lib/http';
import { readIdempotencyKey, REPLAYED_HEADER } from '../../lib/idempotency';
import {
  getAuth,
  optionalAuth,
  requireAuth,
  requireFullAccess,
  requireVerifiedPrive,
} from '../../middleware/auth';
import { clientContext } from '../../middleware/requestContext';
import { parse } from '../../middleware/validate';
import {
  listRepresentationsQuery,
  representationIdParams,
  signRepresentationBody,
} from './representations.schemas';
import { representationsService } from './representations.service';

export const representationsRouter = Router();

// GET /representations — Public: petitions with goal, signatures, days left and track status.
representationsRouter.get('/', async (req, res) => {
  const { items, meta } = await representationsService.list(
    parse(listRepresentationsQuery, req.query),
  );
  sendPage(res, items, meta);
});

// GET /representations/:id — Public: overview, evidence, signers; plus your own signature and its
// receipt when signed in.
representationsRouter.get('/:id', optionalAuth, async (req, res) => {
  const { id } = parse(representationIdParams, req.params);
  sendData(res, await representationsService.get(id, req.auth));
});

// GET /representations/:id/timeline — Public: the 9-step track and its status history.
representationsRouter.get('/:id/timeline', async (req, res) => {
  const { id } = parse(representationIdParams, req.params);
  sendData(res, await representationsService.timeline(id));
});

// GET /representations/:id/submission — Prive (KYC verified) and Institutional: download link for
// the submitted petition pack.
representationsRouter.get('/:id/submission', requireAuth, requireFullAccess, async (req, res) => {
  const { id } = parse(representationIdParams, req.params);
  sendData(res, await representationsService.submissionPack(id));
});

// POST /representations/:id/signatures — Prive (KYC verified): sign with a display choice, an
// optional investor type, a signature file and both consents. Needs an Idempotency-Key header;
// returns the signature ID (GIG-XXXXXXXXX) and a link to the receipt PDF.
representationsRouter.post(
  '/:id/signatures',
  requireAuth,
  requireVerifiedPrive,
  async (req, res) => {
    const { id } = parse(representationIdParams, req.params);
    const idempotencyKey = readIdempotencyKey(req);
    const input = parse(signRepresentationBody, req.body);

    const { result, replayed } = await representationsService.sign(
      getAuth(req),
      id,
      input,
      idempotencyKey,
      clientContext(req),
    );
    if (replayed) res.set(REPLAYED_HEADER, 'true');
    sendData(res, result, 201);
  },
);
