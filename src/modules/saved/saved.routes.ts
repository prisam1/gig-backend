import { Router } from 'express';
import { parse, sendData, sendPage } from '../../lib/http';
import { currentUser, requireUser } from '../../middleware/auth';
import { listSavedQuery, savedItemRef } from './saved.schemas';
import { listSaved, removeSavedItem, saveItem } from './saved.service';

/** `/me/saved`: companies, issuers, roadshows and learn content the user bookmarked. */
export const savedRouter = Router();

savedRouter.use(requireUser);

// GET /me/saved?type=COMPANY,ROADSHOW — newest first, with a summary of each item.
savedRouter.get('/', async (req, res) => {
  const query = parse(listSavedQuery, req.query);
  const { items, meta } = await listSaved(currentUser(req), query);
  sendPage(res, items, meta);
});

// POST /me/saved { type, id }
savedRouter.post('/', async (req, res) => {
  const ref = parse(savedItemRef, req.body);
  sendData(res, await saveItem(currentUser(req), ref), 201);
});

// DELETE /me/saved/:type/:id
savedRouter.delete('/:type/:id', async (req, res) => {
  const ref = parse(savedItemRef, req.params);
  await removeSavedItem(currentUser(req), ref);
  res.status(204).end();
});
