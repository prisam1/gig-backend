import { Router } from 'express';

export const router = Router();

router.get('/health', (_req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

// Feature routers from src/modules are mounted here, e.g. router.use('/reviews', reviewsRouter).
