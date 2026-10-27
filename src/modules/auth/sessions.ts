import { randomUUID } from 'node:crypto';
import { env } from '../../config/env';
import { randomToken, sha256 } from '../../lib/crypto';
import { signAccessToken } from '../../lib/tokens';
import type { DeviceInfo } from './auth.schemas';

const MAX_ACTIVE_SESSIONS = 10;

export interface TokenPair {
  tokenType: 'Bearer';
  accessToken: string;
  accessTokenExpiresIn: number;
  refreshToken: string;
  refreshTokenExpiresAt: Date;
}

// Refresh token format: <session public id>.<32 random bytes>. Only the SHA-256 of the
// secret part is stored.
export function parseRefreshToken(token: string): { sessionPublicId: string; secretHash: string } | null {
  const match = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.([A-Za-z0-9_-]{43})$/.exec(
    token,
  );
  if (!match?.[1] || !match[2]) return null;
  return { sessionPublicId: match[1], secretHash: sha256(match[2]) };
}

export function tokenPair(userPublicId: string, sessionPublicId: string, secret: string, expiresAt: string): TokenPair {
  return {
    tokenType: 'Bearer',
    accessToken: signAccessToken(userPublicId, sessionPublicId),
    accessTokenExpiresIn: env.ACCESS_TOKEN_TTL_SECONDS,
    refreshToken: `${sessionPublicId}.${secret}`,
    refreshTokenExpiresAt: new Date(expiresAt),
  };
}

/**
 * A new session's identifiers. `stored` goes to the database (the refresh secret only as a hash);
 * the secret itself is returned to the device once, inside the token pair.
 */
export function newSession(device: DeviceInfo) {
  const publicId = randomUUID();
  const secret = randomToken();
  return {
    publicId,
    secret,
    stored: {
      publicId,
      refreshHash: sha256(secret),
      deviceName: device.name ?? null,
      platform: device.platform,
      idleDays: env.REFRESH_TOKEN_IDLE_DAYS,
      maxDays: env.SESSION_MAX_DAYS,
      maxActive: MAX_ACTIVE_SESSIONS,
    },
  };
}
