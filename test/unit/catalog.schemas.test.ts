import { describe, expect, it } from 'vitest';
import {
  compareQuery,
  companyIdParams,
  listCompaniesQuery,
  trendsQuery,
} from '../../src/modules/catalog/catalog.schemas';

const A = '8f1c2b9e-0000-4000-8000-000000000001';
const B = '8f1c2b9e-0000-4000-8000-000000000002';

describe('company list query', () => {
  it('defaults to page 1, 20 per page, most relevant', () => {
    expect(listCompaniesQuery.parse({})).toEqual({ page: 1, pageSize: 20, sort: 'relevant' });
  });

  it.each(['relevant', 'recent', 'trending', 'top_rated', 'most_reviewed', 'improving'])(
    'accepts sort=%s',
    (sort) => {
      expect(listCompaniesQuery.parse({ sort }).sort).toBe(sort);
    },
  );

  it('rejects the old app sort ids and unknown sorts', () => {
    for (const sort of ['sb_recent', 'MOST RECENT', '-createdAt']) {
      expect(listCompaniesQuery.safeParse({ sort }).success).toBe(false);
    }
  });

  it('limits page size to 1-100 and page to 1+', () => {
    expect(listCompaniesQuery.safeParse({ pageSize: '101' }).success).toBe(false);
    expect(listCompaniesQuery.safeParse({ pageSize: '0' }).success).toBe(false);
    expect(listCompaniesQuery.safeParse({ page: '0' }).success).toBe(false);
    expect(listCompaniesQuery.parse({ page: '3', pageSize: '50' })).toMatchObject({
      page: 3,
      pageSize: 50,
    });
  });

  it('parses all 7 filter groups', () => {
    const q = listCompaniesQuery.parse({
      q: '  astra ',
      filter: {
        sentiment: 'Positive,Neutral',
        assetClass: 'MF,INS',
        resolution: 'RESOLVED,NOT_CONTACTED',
        score: '5,4',
        country: 'IN',
        investedStatus: 'CURRENTLY_INVESTED',
        year: '2024,before_2021',
      },
    });
    expect(q.q).toBe('astra');
    expect(q.filter).toEqual({
      sentiment: ['Positive', 'Neutral'],
      assetClass: ['MF', 'INS'],
      resolution: ['RESOLVED', 'NOT_CONTACTED'],
      score: [5, 4],
      country: ['IN'],
      investedStatus: ['CURRENTLY_INVESTED'],
      year: ['2024', 'before_2021'],
    });
  });

  it('accepts repeated filter keys and removes duplicates', () => {
    const q = listCompaniesQuery.parse({
      filter: { sentiment: ['Positive', 'Positive,Negative'] },
    });
    expect(q.filter?.sentiment).toEqual(['Positive', 'Negative']);
  });

  it('rejects invalid filter values (the old app ids among them)', () => {
    const bad = [
      { sentiment: 'Happy' },
      { assetClass: 'Mutual Fund' },
      { resolution: 'In Progress' },
      { score: '6' },
      { country: 'India' },
      { investedStatus: 'invested' },
      { year: '25' },
    ];
    for (const filter of bad) {
      expect(listCompaniesQuery.safeParse({ filter }).success, JSON.stringify(filter)).toBe(false);
    }
  });

  it('rejects unknown filter names and over-long searches', () => {
    expect(listCompaniesQuery.safeParse({ filter: { colour: 'red' } }).success).toBe(false);
    expect(listCompaniesQuery.safeParse({ q: 'x'.repeat(101) }).success).toBe(false);
  });
});

describe('company id', () => {
  it('requires a UUID', () => {
    expect(companyIdParams.safeParse({ id: A }).success).toBe(true);
    expect(companyIdParams.safeParse({ id: 'c1' }).success).toBe(false);
  });
});

describe('compare query', () => {
  it('accepts 2 to 4 ids', () => {
    expect(compareQuery.parse({ ids: `${A},${B}` }).ids).toEqual([A, B]);
  });

  it('rejects fewer than 2 or more than 4 ids', () => {
    expect(compareQuery.safeParse({ ids: A }).success).toBe(false);
    const five = Array.from({ length: 5 }, (_, i) => A.replace(/1$/, String(i + 1))).join(',');
    expect(compareQuery.safeParse({ ids: five }).success).toBe(false);
  });

  it('rejects invalid ids and counts duplicates once', () => {
    expect(compareQuery.safeParse({ ids: `${A},nope` }).success).toBe(false);
    expect(compareQuery.safeParse({ ids: `${A},${A}` }).success).toBe(false);
  });
});

describe('trends query', () => {
  it('defaults to 12M and accepts 12M, 24M, ALL', () => {
    expect(trendsQuery.parse({}).range).toBe('12M');
    for (const range of ['12M', '24M', 'ALL'])
      expect(trendsQuery.parse({ range }).range).toBe(range);
    expect(trendsQuery.safeParse({ range: '6M' }).success).toBe(false);
  });
});
