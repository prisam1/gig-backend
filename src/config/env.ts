import { z } from 'zod';

// 32 random bytes, base64-encoded. Generate with:
// node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
const key32 = z
  .string()
  .refine((v) => Buffer.from(v, 'base64').length === 32, 'Must be 32 bytes, base64-encoded');

// OTP delivery methods that are refused in production. Real SMS and email providers join the
// enum below as they are added.
const DEV_ONLY_OTP_DELIVERY: ReadonlySet<string> = new Set(['console']);

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(4000),
    CORS_ORIGIN: z.string().default('*'),
    // Number of proxies in front of the API (load balancer = 1). Needed for real client IPs.
    TRUST_PROXY: z.coerce.number().int().min(0).default(0),

    SUPABASE_URL: z.url(),
    SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),

    JWT_ACCESS_SECRET: key32,
    JWT_ISSUER: z.string().default('gig-backend'),
    JWT_AUDIENCE: z.string().default('gig-app'),
    ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(900),
    REFRESH_TOKEN_IDLE_DAYS: z.coerce.number().int().min(1).max(90).default(30),
    SESSION_MAX_DAYS: z.coerce.number().int().min(1).max(365).default(90),

    // Column-level encryption of PII (AES-256-GCM) and keyed hashes for lookups.
    DATA_ENCRYPTION_KEY: key32,
    BLIND_INDEX_KEY: key32,

    // How OTP codes reach users. "console" prints them to the server log and is refused in production.
    OTP_DELIVERY: z.enum(['console']).default('console'),
  })
  .superRefine((e, ctx) => {
    const keys = [e.JWT_ACCESS_SECRET, e.DATA_ENCRYPTION_KEY, e.BLIND_INDEX_KEY];
    if (new Set(keys).size !== keys.length) {
      ctx.addIssue({ code: 'custom', path: ['BLIND_INDEX_KEY'], message: 'Each secret key must be different' });
    }
    if (e.NODE_ENV === 'production') {
      if (e.CORS_ORIGIN === '*') {
        ctx.addIssue({ code: 'custom', path: ['CORS_ORIGIN'], message: 'Must list exact origins in production' });
      }
      if (DEV_ONLY_OTP_DELIVERY.has(e.OTP_DELIVERY)) {
        ctx.addIssue({ code: 'custom', path: ['OTP_DELIVERY'], message: 'Console OTP delivery is not allowed in production' });
      }
    }
  });

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('Invalid environment variables:', z.flattenError(parsed.error).fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
