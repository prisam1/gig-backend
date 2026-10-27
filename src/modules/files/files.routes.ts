import { Router } from 'express';
import { currentUser, requireUser } from '../../middleware/auth';
import { parse } from '../../middleware/validate';
import { createUploadUrlSchema } from './files.schemas';
import { filesService } from './files.service';

export const filesRouter = Router();

filesRouter.use(requireUser);

filesRouter.post('/upload-url', async (req, res) => {
  const input = parse(createUploadUrlSchema, req.body);
  res.status(201).json({ data: await filesService.createUploadUrl(currentUser(req), input) });
});
