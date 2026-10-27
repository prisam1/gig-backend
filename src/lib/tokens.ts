import { randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { env } from '../config/env';
import { AppError } from '../middleware/errorHandler';

const claimsSchema = z.object({ sub: z.uuid(), sid: z.uuid() });

export function signAccessToken(userPublicId: string, sessionPublicId: string): string {
  return jwt.sign({ sid: sessionPublicId }, env.JWT_ACCESS_SECRET, {
    algorithm: 'HS256',
    expiresIn: env.ACCESS_TOKEN_TTL_SECONDS,
    issuer: env.JWT_ISSUER,
    audience: env.JWT_AUDIENCE,
    subject: userPublicId,
    jwtid: randomUUID(),
  });
}

export function verifyAccessToken(token: string): { userPublicId: string; sessionPublicId: string } {
  try {
    const payload = jwt.verify(token, env.JWT_ACCESS_SECRET, {
      algorithms: ['HS256'],
      issuer: env.JWT_ISSUER,
      audience: env.JWT_AUDIENCE,
    });
    const claims = claimsSchema.parse(payload);
    return { userPublicId: claims.sub, sessionPublicId: claims.sid };
  } catch {
    throw new AppError(401, 'UNAUTHENTICATED', 'Invalid or expired access token');
  }
}
