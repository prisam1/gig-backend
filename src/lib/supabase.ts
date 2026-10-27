import { createClient } from '@supabase/supabase-js';
import { env } from '../config/env';
import type { Database } from '../types/database';

// Server-side admin client for the catalog and reviews tables (public schema) and Supabase Storage.
// Bypasses Row Level Security; never expose this key. The auth module's tables in the private
// "app" schema go through src/lib/db.ts instead.
export const supabaseAdmin = createClient<Database>(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});
