import { Router } from 'express';
import { lookupsService } from './lookups.service';

export const lookupsRouter = Router();

lookupsRouter.get('/:type', async (req, res) => {
  res.json({ data: await lookupsService.listBySlug(req.params.type) });
});
