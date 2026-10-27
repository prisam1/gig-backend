// Users, profile and KYC (Phase 1): sign-up steps 2-3 and tier selection, under /api/v1/me.
import { Router } from 'express';
import { getAuth, requireAuth } from '../../middleware/auth';
import { clientContext } from '../../middleware/requestContext';
import { parse } from '../../middleware/validate';
import { preferencesSchema, tierSchema, updateMeSchema } from './users.schemas';
import * as users from './users.service';

export const meRouter = Router();
meRouter.use(requireAuth);

meRouter.get('/', async (req, res) => {
  res.json({ data: await users.loadUser(getAuth(req).userId) });
});

// Step 2 (professional details) and later profile edits.
meRouter.patch('/', async (req, res) => {
  const data = await users.updateMe(getAuth(req).userId, parse(updateMeSchema, req.body), clientContext(req));
  res.json({ data });
});

// Step 3 (investment details). Replaces all preferences.
meRouter.put('/preferences', async (req, res) => {
  const data = await users.setPreferences(getAuth(req).userId, parse(preferencesSchema, req.body), clientContext(req));
  res.json({ data });
});

meRouter.put('/tier', async (req, res) => {
  const data = await users.selectTier(getAuth(req).userId, parse(tierSchema, req.body), clientContext(req));
  res.json({ data });
});
