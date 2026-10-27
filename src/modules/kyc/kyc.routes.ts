import { Router } from 'express';
import { currentUser, requireUser } from '../../middleware/auth';
import { parse } from '../../middleware/validate';
import { submitKycSchema } from './kyc.schemas';
import { kycService } from './kyc.service';

export const kycRouter = Router();

kycRouter.use(requireUser);

kycRouter.post('/submissions', async (req, res) => {
  const input = parse(submitKycSchema, req.body);
  const submission = await kycService.submit(currentUser(req), input, {
    ipAddress: req.ip ?? null,
    appVersion: req.get('x-app-version') ?? null,
  });
  res.status(201).json({ data: submission });
});

kycRouter.get('/submissions/me', async (req, res) => {
  res.json({ data: await kycService.getMine(currentUser(req)) });
});
