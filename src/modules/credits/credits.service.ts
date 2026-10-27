import type { PageMeta } from '../../lib/http';
import { fetchPage, supabaseAdmin, unwrap } from '../../lib/supabase';
import type { Enums, Tables } from '../../types/database';
import type { AuthUser } from '../../middleware/auth';

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

/** The balance after the user's latest ledger entry (0 before any). */
export async function getCreditBalance(userPublicId: string): Promise<number> {
  const rows = unwrap(
    await supabaseAdmin
      .from('credit_ledger')
      .select('balance_after')
      .eq('user_id', userPublicId)
      .order('id', { ascending: false })
      .limit(1),
  );
  return rows[0]?.balance_after ?? 0;
}

/** Balance and ledger, newest entry first. */
export async function getCreditStatement(
  user: AuthUser,
  page: { page: number; pageSize: number },
): Promise<{ statement: CreditStatement; meta: PageMeta }> {
  const build = (head: boolean) =>
    supabaseAdmin
      .from('credit_ledger')
      .select('*', { count: 'exact', head })
      .eq('user_id', user.id);

  const [balance, { rows, meta }] = await Promise.all([
    getCreditBalance(user.id),
    fetchPage(page, {
      rows: (from, to) => build(false).order('id', { ascending: false }).range(from, to),
      count: () => build(true),
    }),
  ]);
  return { statement: { balance, entries: rows.map(toEntry) }, meta };
}
