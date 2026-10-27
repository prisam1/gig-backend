import { createClient } from '@supabase/supabase-js';
import { env } from '../config/env';

// Server-side admin client: bypasses Row Level Security. Never expose this key to the app.
export const supabaseAdmin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// Per-request client that acts as the signed-in user, so RLS policies apply.
export function supabaseForUser(accessToken: string) {
  return createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
}
