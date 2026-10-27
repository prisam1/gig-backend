// Users, profile and KYC (Phase 1): option lists for the sign-up screens, under /api/v1/lookups.
import { Router } from 'express';
import { z } from 'zod';
import { parse } from '../../middleware/validate';
import { LOOKUP_TYPES } from './users.schemas';
import { listOptions } from './users.service';

const typeSchema = z.enum(Object.keys(LOOKUP_TYPES) as [keyof typeof LOOKUP_TYPES], 'Unknown option list');

export const lookupsRouter = Router();

lookupsRouter.get('/:type', async (req, res) => {
  const type = LOOKUP_TYPES[parse(typeSchema, req.params.type)];
  res.set('Cache-Control', 'public, max-age=300');
  res.json({ data: await listOptions(type) });
});
