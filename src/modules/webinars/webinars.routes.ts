import { Router } from 'express';
import { parse, sendData, sendPage } from '../../lib/http';
import { currentUser, requireUser } from '../../middleware/auth';
import { listWebinarsQuery, webinarIdParams } from './webinars.schemas';
import { listWebinars, registerForWebinar } from './webinars.service';

export const webinarsRouter = Router();

webinarsRouter.use(requireUser);

// GET /webinars?when=upcoming|past — User: webinars with registration status and recordings
// (Observers get recordings after a delay).
webinarsRouter.get('/', async (req, res) => {
  const query = parse(listWebinarsQuery, req.query);
  const { items, meta } = await listWebinars(currentUser(req), query);
  sendPage(res, items, meta);
});

// POST /webinars/:id/register — User: register (PREMIUM webinars: verified Prive and Inst.).
webinarsRouter.post('/:id/register', async (req, res) => {
  const { id } = parse(webinarIdParams, req.params);
  sendData(res, await registerForWebinar(currentUser(req), id), 201);
});
