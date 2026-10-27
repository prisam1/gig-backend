// The repository queries: filters, ordering, paging and row mapping, against a fake Supabase client.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ratingsRepository } from '../../src/modules/ratings/ratings.repository';
import {
  representationsRepository,
  type Representation,
} from '../../src/modules/representations/representations.repository';
import { allChainArgs, chainArgs, fake } from '../helpers/fakeSupabase';

vi.mock('../../src/lib/supabase', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/lib/supabase')>();
  const { fake } = await import('../helpers/fakeSupabase');
  return { ...original, supabaseAdmin: fake.client };
});

const representation = { internalId: 7, id: 'rep-1' } as Representation;

const file = (scanStatus: string, key = 'rep/doc.pdf') => ({
  bucket: 'representation-documents',
  object_key: key,
  mime_type: 'application/pdf',
  size_bytes: 100,
  scan_status: scanStatus,
});

beforeEach(() => fake.reset());

describe('ratings repository', () => {
  it('searches issuers by name or instrument, filters, sorts and pages', async () => {
    fake.on('from:issuer_cards', { data: [], count: 0 });

    await ratingsRepository.findIssuers({
      page: 2,
      pageSize: 10,
      q: 'Alpha_1',
      sort: 'top_rated',
      filter: { assetType: ['Equity'], listed: true },
    });

    const call = fake.callsTo('from:issuer_cards')[0];
    expect(chainArgs(call, 'ilike')).toEqual(['search_text', '%alpha\\_1%']);
    expect(chainArgs(call, 'in')).toEqual(['asset_type', ['Equity']]);
    expect(chainArgs(call, 'eq')).toEqual(['is_listed', true]);
    expect(allChainArgs(call, 'order')).toEqual([
      ['average_score', { ascending: false, nullsFirst: false }],
      ['rating_count', { ascending: false, nullsFirst: false }],
      ['id'],
    ]);
    expect(chainArgs(call, 'range')).toEqual([10, 19]);
  });

  it('returns an empty page with the real total past the last page', async () => {
    fake.on('from:issuer_cards', (call) =>
      (call.chain[0]?.args[1] as { head?: boolean }).head
        ? { count: 3 }
        : { error: { code: 'PGRST103', message: 'Requested range not satisfiable' } },
    );
    expect(await ratingsRepository.findIssuers({ page: 9, pageSize: 20, sort: 'recent' })).toEqual({
      items: [],
      total: 3,
    });
  });

  it('parses the stats JSON and rejects a malformed shape', async () => {
    const row = {
      issuer_id: 'i1',
      rating_count: 1,
      average_score: 4,
      weighted_score: 4,
      score_distribution: { '1': 0, '2': 0, '3': 0, '4': 1, '5': 0 },
      factor_breakdown: { GENERAL: { POSITIVE: 100, NEUTRAL: 0, NEGATIVE: 0 } },
      risk_counts: { CREDIT: 1 },
      last_rating_at: null,
    };
    fake.on('from:issuer_stats', { data: row });
    expect((await ratingsRepository.findStats('i1'))?.factorBreakdown.GENERAL?.POSITIVE).toBe(100);

    fake.on('from:issuer_stats', { data: { ...row, risk_counts: { CREDIT: 'many' } } });
    await expect(ratingsRepository.findStats('i1')).rejects.toThrow();
  });

  it("reads only the user's own, not-deleted rating", async () => {
    fake.on('from:issuer_ratings', { data: null });
    await ratingsRepository.findOwn(1, 'r1');
    const call = fake.callsTo('from:issuer_ratings')[0];
    expect(allChainArgs(call, 'eq')).toEqual([
      ['user_id', 1],
      ['public_id', 'r1'],
    ]);
    expect(chainArgs(call, 'is')).toEqual(['deleted_at', null]);
  });
});

describe('representations repository', () => {
  const doc = (id: string, scanStatus: string) => ({
    public_id: id,
    title: id,
    document_type: 'EVIDENCE',
    file: file(scanStatus),
  });

  it('never offers documents the virus scan flagged', async () => {
    fake.on('from:representation_documents', {
      data: [doc('clean', 'CLEAN'), doc('infected', 'INFECTED'), doc('pending', 'PENDING')],
    });
    const evidence = await representationsRepository.findEvidence(representation);
    expect(evidence.map((d) => d.id)).toEqual(['clean', 'pending']);
  });

  it('hides infected documents in the status history and submission packs', async () => {
    fake.on('from:representation_status_history', {
      data: [
        {
          from_status: null,
          to_status: 'SUBMITTED_TO_REGULATOR',
          note: null,
          occurred_at: '2026-11-20T00:00:00Z',
          representation_documents: [doc('pack', 'CLEAN'), doc('bad', 'INFECTED')],
        },
      ],
    });
    const [change] = await representationsRepository.findStatusHistory(representation);
    expect(change?.documents.map((d) => d.id)).toEqual(['pack']);

    fake.on('from:representation_documents', {
      data: [doc('latest', 'INFECTED'), doc('older', 'CLEAN')],
    });
    expect((await representationsRepository.findLatestSubmissionPack(representation))?.id).toBe(
      'older',
    );
    const call = fake.callsTo('from:representation_documents').at(-1);
    expect(allChainArgs(call, 'eq')).toEqual([
      ['representation_id', 7],
      ['document_type', 'SUBMISSION_PACK'],
    ]);
  });

  it("reads only the user's valid, not-deleted signature", async () => {
    fake.on('from:representation_signatures', { data: null });
    await representationsRepository.findSignature(1, representation);
    const call = fake.callsTo('from:representation_signatures')[0];
    expect(allChainArgs(call, 'eq')).toEqual([
      ['user_id', 1],
      ['representation_id', 7],
      ['status', 'VALID'],
    ]);
    expect(chainArgs(call, 'is')).toEqual(['deleted_at', null]);
  });

  it('searches, filters and sorts petitions', async () => {
    fake.on('from:representation_cards', { data: [], count: 0 });
    await representationsRepository.findAll({
      page: 1,
      pageSize: 20,
      q: 'T+1',
      sort: 'closing_soon',
      filter: { status: ['OPEN'], country: ['IN'], openForSigning: true },
    });
    const call = fake.callsTo('from:representation_cards')[0];
    expect(chainArgs(call, 'ilike')).toEqual(['search_text', '%t+1%']);
    expect(allChainArgs(call, 'in')).toEqual([
      ['track_status', ['OPEN']],
      ['country', ['IN']],
    ]);
    expect(chainArgs(call, 'eq')).toEqual(['is_open_for_signing', true]);
    expect(allChainArgs(call, 'order')).toEqual([
      ['is_open_for_signing', { ascending: false }],
      ['closes_at', { ascending: true }],
      ['id'],
    ]);
  });
});
