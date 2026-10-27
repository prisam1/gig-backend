import { supabaseAdmin } from './supabase';

export interface AuthIdentity {
  authUserId: string;
  email: string | null;
  phone: string | null;
}

export const authProvider = {
  /** Resolves a Supabase Auth access token to its user, or null if it is invalid or expired. */
  async verifyAccessToken(token: string): Promise<AuthIdentity | null> {
    const { data, error } = await supabaseAdmin.auth.getUser(token);
    if (error || !data.user) return null;

    return {
      authUserId: data.user.id,
      email: data.user.email || null,
      phone: data.user.phone || null,
    };
  },
};
