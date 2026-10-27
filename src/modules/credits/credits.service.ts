import type { PageMeta } from '../../lib/http';
import { fetchPage, supabaseAdmin, unwrap } from '../../lib/supabase';
import type { Enums, Tables } from '../../types/database';
import type { User } from '../users/users.repository';

export interface CreditEntry {
  id: number;
  /** Positive for credits received, negative for credits spent. */
  delta: number;
  balanceAfter: number;
  reason: Enums<'credit_reason'>;
  /** What the credits were spent on or granted for, e.g. { type: "ROADSHOW", id }. */
  ref: { type: string; id: string | null } | null;
  note: string | null;
  createdAt: string;
}

export interface CreditStatement {
  balance: number;
  entries: CreditEntry[];
}

function toEntry(row: Tables<'credit_ledger'>): CreditEntry {
  return {
    id: row.id,
    delta: row.delta,
    balanceAfter: row.balance_after,
    reason: row.reason,
    ref: row.ref_type === null ? null : { type: row.ref_type, id: row.ref_id },
    note: row.note,
    createdAt: row.created_at,
  };
}

/** The cached balance on public.users (always the sum of the user's ledger). */
export async function getCreditBalance(userPublicId: string): Promise<number> {
  const row = unwrap(
    await supabaseAdmin
      .from('users')
      .select('credit_balance')
      .eq('public_id', userPublicId)
      .single(),
  );
  return row.credit_balance;
}

/** Balance and ledger, newest entry first. */
export async function getCreditStatement(
  user: User,
  page: { page: number; pageSize: number },
): Promise<{ statement: CreditStatement; meta: PageMeta }> {
  const build = (head: boolean) =>
    supabaseAdmin
      .from('credit_ledger')
      .select('*', { count: 'exact', head })
      .eq('user_id', user.publicId);

  const [balance, { rows, meta }] = await Promise.all([
    getCreditBalance(user.publicId),
    fetchPage(page, {
      rows: (from, to) => build(false).order('id', { ascending: false }).range(from, to),
      count: () => build(true),
    }),
  ]);
  return { statement: { balance, entries: rows.map(toEntry) }, meta };
}
