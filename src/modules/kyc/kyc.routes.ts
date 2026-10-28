import { Router } from 'express';
import { getAuth, requireAuth } from '../../middleware/auth';
import { clientContext } from '../../middleware/requestContext';
import { parse } from '../../middleware/validate';
import { submitKycSchema } from './kyc.schemas';
import { kycService } from './kyc.service';

export const kycRouter = Router();

kycRouter.use(requireAuth);

kycRouter.post('/submissions', async (req, res) => {
  const input = parse(submitKycSchema, req.body);
  const submission = await kycService.submit(getAuth(req), input, clientContext(req));
  res.status(201).json({ data: submission });
});
