import { randomUUID } from 'node:crypto';
import { env } from '../../config/env';
import { randomToken, sha256 } from '../../lib/crypto';
import type { Db } from '../../lib/db';
import { signAccessToken } from '../../lib/tokens';
import type { ClientContext } from '../../middleware/requestContext';
import type { DeviceInfo } from './auth.schemas';

const MAX_ACTIVE_SESSIONS = 10;
const DAY_MS = 86_400_000;

export type RevokeReason =
  | 'LOGOUT'
  | 'REVOKED_BY_USER'
  | 'PASSWORD_RESET'
  | 'TOKEN_REUSE'
  | 'SESSION_LIMIT'
  | 'ADMIN';

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

function tokenPair(userPublicId: string, sessionPublicId: string, secret: string, expiresAt: Date): TokenPair {
  return {
    tokenType: 'Bearer',
    accessToken: signAccessToken(userPublicId, sessionPublicId),
    accessTokenExpiresIn: env.ACCESS_TOKEN_TTL_SECONDS,
    refreshToken: `${sessionPublicId}.${secret}`,
    refreshTokenExpiresAt: expiresAt,
  };
}

export async function createSession(
  tx: Db,
  user: { id: string; publicId: string },
  device: DeviceInfo,
  ctx: ClientContext,
): Promise<TokenPair> {
  // Keep at most MAX_ACTIVE_SESSIONS devices; the least recently used ones are signed out.
  await tx`
    update app.user_sessions set revoked_at = now(), revoked_reason = 'SESSION_LIMIT'
    where id in (
      select id from app.user_sessions
      where user_id = ${user.id} and revoked_at is null
      order by last_used_at desc
      offset ${MAX_ACTIVE_SESSIONS - 1}
    )`;

  const publicId = randomUUID();
  const secret = randomToken();
  const now = Date.now();
  const absoluteExpiresAt = new Date(now + env.SESSION_MAX_DAYS * DAY_MS);
  const expiresAt = new Date(Math.min(now + env.REFRESH_TOKEN_IDLE_DAYS * DAY_MS, absoluteExpiresAt.getTime()));

  await tx`
    insert into app.user_sessions (public_id, user_id, refresh_token_hash, device_name, platform,
      app_version, ip, user_agent, expires_at, absolute_expires_at)
    values (${publicId}, ${user.id}, ${sha256(secret)}, ${device.name ?? null}, ${device.platform},
      ${ctx.appVersion}, ${ctx.ip}, ${ctx.userAgent}, ${expiresAt}, ${absoluteExpiresAt})`;
  await tx`update app.users set last_login_at = now() where id = ${user.id}`;

  return tokenPair(user.publicId, publicId, secret, expiresAt);
}

export async function rotateSession(
  tx: Db,
  session: { id: string; publicId: string; absoluteExpiresAt: Date },
  userPublicId: string,
  ctx: ClientContext,
): Promise<TokenPair> {
  const secret = randomToken();
  const expiresAt = new Date(
    Math.min(Date.now() + env.REFRESH_TOKEN_IDLE_DAYS * DAY_MS, session.absoluteExpiresAt.getTime()),
  );
  await tx`
    update app.user_sessions set
      previous_refresh_token_hash = refresh_token_hash,
      refresh_token_hash = ${sha256(secret)},
      expires_at = ${expiresAt},
      last_used_at = now(),
      ip = ${ctx.ip},
      user_agent = ${ctx.userAgent},
      app_version = coalesce(${ctx.appVersion}, app_version)
    where id = ${session.id}`;
  return tokenPair(userPublicId, session.publicId, secret, expiresAt);
}

export async function revokeAllSessions(tx: Db, userId: string, reason: RevokeReason, exceptSessionId?: string) {
  await tx`
    update app.user_sessions set revoked_at = now(), revoked_reason = ${reason}
    where user_id = ${userId} and revoked_at is null
      and id <> ${exceptSessionId ?? '0'}`;
}
