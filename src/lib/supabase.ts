import { createClient } from '@supabase/supabase-js';
import { env } from '../config/env';

// Server-side admin client for Supabase Storage. Bypasses Row Level Security; never expose this key.
// Database queries go through src/lib/db.ts instead.
export const supabaseAdmin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});
