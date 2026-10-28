// Users and profile (Phase 1): the signed-in user's own profile under /api/v1/me.
import { Router } from 'express';
import { getAuth, requireAuth } from '../../middleware/auth';
import { clientContext } from '../../middleware/requestContext';
import { parse } from '../../middleware/validate';
import { updateMeSchema } from './users.schemas';
import * as users from './users.service';

export const meRouter = Router();
meRouter.use(requireAuth);

meRouter.get('/', async (req, res) => {
  res.json({ data: await users.loadUser(getAuth(req).userId) });
});

// Profile edits, including the avatar (uploaded after the account exists).
meRouter.patch('/', async (req, res) => {
  const data = await users.updateMe(getAuth(req).userId, parse(updateMeSchema, req.body), clientContext(req));
  res.json({ data });
});
