import { supabaseAdmin, unwrap } from '../../lib/supabase';
import type { LookupType } from '../../types/domain';

export interface LookupOption {
  code: string;
  label: string;
}

export const lookupsRepository = {
  async findActive(type: LookupType): Promise<LookupOption[]> {
    return unwrap(
      await supabaseAdmin
        .from('lookup_options')
        .select('code, label')
        .eq('type', type)
        .eq('active', true)
        .order('sort_order'),
    );
  },

  /** Returns the subset of `codes` that are active options of `type`. */
  async findActiveCodes(type: LookupType, codes: string[]): Promise<string[]> {
    const rows = unwrap(
      await supabaseAdmin
        .from('lookup_options')
        .select('code')
        .eq('type', type)
        .eq('active', true)
        .in('code', codes),
    );
    return rows.map((row) => row.code);
  },
};
