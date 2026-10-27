import { Router } from 'express';
import { sql } from '../lib/db';
import { authRouter } from '../modules/auth/auth.routes';
import { lookupsRouter } from '../modules/users/lookups.routes';
import { meRouter } from '../modules/users/users.routes';
import { noStore } from '../middleware/requestContext';

export const router = Router();

router.get('/health', (_req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

// Liveness: the process is up. Readiness: it can also reach the database.
router.get('/health/live', (_req, res) => {
  res.json({ status: 'ok' });
});

router.get('/health/ready', async (_req, res) => {
  try {
    await sql`select 1`;
    res.json({ status: 'ok', database: 'ok' });
  } catch {
    res.status(503).json({ status: 'unavailable', database: 'unreachable' });
  }
});

// ===== Auth and onboarding (Phase 1) =====
router.use('/auth', noStore, authRouter);

// ===== Users, profile and KYC (Phase 1) =====
// Only the sign-up steps so far: /me, /me/preferences, /me/tier, /lookups/:type.
router.use('/me', noStore, meRouter);
router.use('/lookups', lookupsRouter);

// Feature routers from src/modules are mounted here, e.g. router.use('/reviews', reviewsRouter).
