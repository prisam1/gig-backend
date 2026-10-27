import { Router } from 'express';
import { sendData, sendPage } from '../../lib/http';
import { readIdempotencyKey, REPLAYED_HEADER } from '../../lib/idempotency';
import {
  currentUser,
  optionalUser,
  requireUser,
  requireFullAccess,
  requireVerifiedPrive,
} from '../../middleware/auth';
import { noStore } from '../../middleware/requestContext';
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
// receipt when signed in. The response is per user, so it is never cached.
representationsRouter.get('/:id', noStore, optionalUser, async (req, res) => {
  const { id } = parse(representationIdParams, req.params);
  sendData(res, await representationsService.get(id, req.user));
});

// GET /representations/:id/timeline — Public: the 9-step track and its status history.
representationsRouter.get('/:id/timeline', async (req, res) => {
  const { id } = parse(representationIdParams, req.params);
  sendData(res, await representationsService.timeline(id));
});

// GET /representations/:id/submission — Prive (KYC verified) and Institutional: download link for
// the submitted petition pack.
representationsRouter.get(
  '/:id/submission',
  noStore,
  requireUser,
  requireFullAccess,
  async (req, res) => {
    const { id } = parse(representationIdParams, req.params);
    sendData(res, await representationsService.submissionPack(id));
  },
);

// POST /representations/:id/signatures — Prive (KYC verified): sign with a display choice, an
// optional investor type, a signature file and both consents. Needs an Idempotency-Key header;
// returns the signature ID (GIG-XXXXXXXXX) and a link to the receipt PDF.
representationsRouter.post(
  '/:id/signatures',
  noStore,
  requireUser,
  requireVerifiedPrive,
  async (req, res) => {
    const { id } = parse(representationIdParams, req.params);
    const idempotencyKey = readIdempotencyKey(req);
    const input = parse(signRepresentationBody, req.body);

    const { result, replayed } = await representationsService.sign(
      currentUser(req),
      id,
      input,
      { ipAddress: req.ip ?? null, appVersion: req.get('x-app-version') ?? null },
      idempotencyKey,
    );
    if (replayed) res.set(REPLAYED_HEADER, 'true');
    sendData(res, result, 201);
  },
);
