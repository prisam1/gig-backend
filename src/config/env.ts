import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  CORS_ORIGIN: z.string().default('*'),
  // Number of proxies in front of the API (load balancer = 1). Needed for real client IPs.
  TRUST_PROXY: z.coerce.number().int().min(0).default(0),

  SUPABASE_URL: z.url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('Invalid environment variables:', z.flattenError(parsed.error).fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
