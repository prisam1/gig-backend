import { Router } from 'express';
import { z } from 'zod';
import { pagination, parse } from '../../lib/http';
import { authUser, requireAuth } from '../../middleware/auth';
import { getCreditStatement } from './credits.service';

const statementQuery = z.object(pagination);

/** `/me/credits`: the signed-in user's credits wallet. */
export const creditsRouter = Router();

creditsRouter.use(requireAuth);

// GET /me/credits?page=&pageSize= — User: balance and ledger (newest first).
creditsRouter.get('/', async (req, res) => {
  const page = parse(statementQuery, req.query);
  const { statement, meta } = await getCreditStatement(authUser(req), page);
  res.status(200).json({ data: statement, meta });
});
