import { Router } from 'express';
import { getAuth, requireAuth } from '../../middleware/auth';
import { clientContext } from '../../middleware/requestContext';
import { parse } from '../../middleware/validate';
import { createUploadUrlSchema } from './files.schemas';
import { filesService } from './files.service';

export const filesRouter = Router();

filesRouter.use(requireAuth);

filesRouter.post('/upload-url', async (req, res) => {
  const input = parse(createUploadUrlSchema, req.body);
  res.status(201).json({ data: await filesService.createUploadUrl(getAuth(req), input, clientContext(req)) });
});
