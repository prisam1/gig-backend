import { describe, expect, it } from 'vitest';
import {
  issuerIdParams,
  listIssuersQuery,
  submitRatingBody,
} from '../../src/modules/ratings/ratings.schemas';

const FACTORS = [
  'GENERAL',
  'BUSINESS_OF_COMPANY',
  'INDUSTRY',
  'PROMOTERS',
  'ISSUE_TERMS',
  'OBJECTS_OF_ISSUE',
  'FINANCIAL_HEALTH',
  'TOP_10_SHAREHOLDERS',
  'OUTSTANDING_LITIGATIONS',
  'CONTINGENT_LIABILITIES',
];

const validRating = {
  overallScore: 4,
  factors: FACTORS.map((code) => ({ code, flag: 'POSITIVE' })),
  riskFactors: ['CREDIT', 'MARKET', 'LIQUIDITY'],
};

function failures(input: unknown): string[] {
  const result = submitRatingBody.safeParse(input);
  return result.success ? [] : result.error.issues.map((i) => i.path.join('.') || '_');
}

describe('submit rating body', () => {
  it('accepts an overall score, a flag per factor and 3 risk factors', () => {
    expect(submitRatingBody.parse(validRating)).toEqual(validRating);
  });

  it('accepts the three flags only', () => {
    for (const flag of ['POSITIVE', 'NEUTRAL', 'NEGATIVE']) {
      expect(failures({ ...validRating, factors: [{ code: 'GENERAL', flag }] })).toEqual([]);
    }
    expect(
      failures({ ...validRating, factors: [{ code: 'GENERAL', flag: 'positive' }] }),
    ).toContain('factors.0.flag');
  });

  it('requires an integer overall score from 1 to 5', () => {
    for (const overallScore of [0, 6, 3.5, '4', undefined]) {
      expect(failures({ ...validRating, overallScore }), String(overallScore)).toContain(
        'overallScore',
      );
    }
    for (const overallScore of [1, 5])
      expect(failures({ ...validRating, overallScore })).toEqual([]);
  });

  it('requires exactly 3 different risk factors', () => {
    expect(failures({ ...validRating, riskFactors: ['CREDIT', 'MARKET'] })).toContain(
      'riskFactors',
    );
    expect(
      failures({ ...validRating, riskFactors: ['CREDIT', 'MARKET', 'LEGAL', 'FRAUD'] }),
    ).toContain('riskFactors');
    expect(failures({ ...validRating, riskFactors: ['CREDIT', 'CREDIT', 'MARKET'] })).toContain(
      'riskFactors',
    );
  });

  it('rejects a factor flagged twice and labels instead of codes', () => {
    expect(
      failures({
        ...validRating,
        factors: [
          { code: 'GENERAL', flag: 'POSITIVE' },
          { code: 'GENERAL', flag: 'NEGATIVE' },
        ],
      }),
    ).toContain('factors');
    expect(
      failures({ ...validRating, factors: [{ code: 'Financial health', flag: 'NEUTRAL' }] }),
    ).toContain('factors.0.code');
    expect(failures({ ...validRating, riskFactors: ['Credit', 'MARKET', 'LEGAL'] })).toContain(
      'riskFactors.0',
    );
  });

  it('rejects unknown fields', () => {
    expect(failures({ ...validRating, issuerName: 'X' })).toContain('_');
  });
});

describe('issuer queries', () => {
  it('requires a UUID issuer id', () => {
    expect(issuerIdParams.safeParse({ id: 'iss-1' }).success).toBe(false);
  });

  it('defaults to the most recent issuers, 20 per page', () => {
    expect(listIssuersQuery.parse({})).toEqual({ page: 1, pageSize: 20, sort: 'recent' });
  });

  it('parses search, asset types and the listed filter', () => {
    expect(
      listIssuersQuery.parse({
        q: ' alpha ',
        sort: 'top_rated',
        filter: { assetType: 'Equity,Bonds', listed: 'false' },
      }),
    ).toMatchObject({
      q: 'alpha',
      sort: 'top_rated',
      filter: { assetType: ['Equity', 'Bonds'], listed: false },
    });
  });

  it('rejects unknown sorts and filters', () => {
    expect(listIssuersQuery.safeParse({ sort: 'sb_recent' }).success).toBe(false);
    expect(listIssuersQuery.safeParse({ filter: { sentiment: 'Positive' } }).success).toBe(false);
    expect(listIssuersQuery.safeParse({ filter: { listed: 'yes' } }).success).toBe(false);
  });

});
