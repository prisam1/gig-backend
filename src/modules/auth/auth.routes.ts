// Auth and onboarding (Phase 1): authentication endpoints under /api/v1/auth.
import { Router } from 'express';
import { getAuth, requireAuth } from '../../middleware/auth';
import { clientContext } from '../../middleware/requestContext';
import { parse } from '../../middleware/validate';
import {
  forgotPasswordSchema,
  loginSchema,
  otpSendSchema,
  otpVerifySchema,
  refreshSchema,
  registerSchema,
  resetPasswordSchema,
} from './auth.schemas';
import * as auth from './auth.service';

export const authRouter = Router();

// Step 1 of sign-up: name, email, phone, password, 18+ confirmation. Sends both OTPs.
authRouter.post('/register', async (req, res) => {
  const data = await auth.register(parse(registerSchema, req.body), clientContext(req));
  res.status(202).json({ data });
});

// Resend the code of a sign-up or password-reset challenge ({ challengeId }).
authRouter.post('/otp/send', async (req, res) => {
  const data = await auth.sendOtpRequest(parse(otpSendSchema, req.body), clientContext(req));
  res.status(202).json({ data });
});

// Returns tokens (sign-up complete), sign-up progress, or a password reset token.
authRouter.post('/otp/verify', async (req, res) => {
  const data = await auth.verifyOtp(parse(otpVerifySchema, req.body), clientContext(req));
  res.json({ data });
});

authRouter.post('/login', async (req, res) => {
  const data = await auth.login(parse(loginSchema, req.body), clientContext(req));
  res.json({ data });
});

authRouter.post('/refresh', async (req, res) => {
  const data = await auth.refresh(parse(refreshSchema, req.body), clientContext(req));
  res.json({ data });
});

authRouter.post('/logout', requireAuth, async (req, res) => {
  await auth.logout(getAuth(req), clientContext(req));
  res.status(204).end();
});

authRouter.post('/password/forgot', async (req, res) => {
  const { identifier } = parse(forgotPasswordSchema, req.body);
  const data = await auth.forgotPassword(identifier, clientContext(req));
  res.status(202).json({ data });
});

authRouter.post('/password/reset', async (req, res) => {
  const data = await auth.resetPassword(parse(resetPasswordSchema, req.body), clientContext(req));
  res.json({ data });
});
