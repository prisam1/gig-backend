import { Router } from 'express';
import { filesRouter } from '../modules/files/files.routes';
import { kycRouter } from '../modules/kyc/kyc.routes';
import { lookupsRouter } from '../modules/lookups/lookups.routes';
import { meRouter, usersRouter } from '../modules/users/users.routes';

export const router = Router();

router.get('/health', (_req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

// Users, profile and KYC (Phase 1)

router.use('/me', meRouter);
router.use('/users', usersRouter);
router.use('/files', filesRouter);
router.use('/kyc', kycRouter);
router.use('/lookups', lookupsRouter);
