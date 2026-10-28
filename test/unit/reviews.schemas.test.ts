import { describe, expect, it } from 'vitest';
import {
  APPRECIATION_CODES,
  CONCERN_CODES,
  CONTACT_STATUS_CODES,
  EVIDENCE_TYPE_CODES,
  idempotencyHeaders,
  listCompanyReviewsQuery,
  submitReviewBody,
  updateResolutionBody,
} from '../../src/modules/reviews/reviews.schemas';

const COMPANY_ID = '8f1c2b9e-0000-4000-8000-000000000001';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const FILE_PATH = `${USER_ID}/statement.pdf`;

const base = {
  companyId: COMPANY_ID,
  country: 'IN',
  assetClass: 'MF',
  productScheme: 'Bluechip Fund - Direct Growth',
  investmentYear: 2024,
  investmentStatus: 'CURRENTLY_INVESTED',
  metrics: {
    transparency: 4,
    responsiveness: 5,
    easeOfProcess: 4,
    trustworthiness: 4,
    overallSatisfaction: 5,
  },
  resolutionStatus: 'RESOLVED',
  declarations: { kycVerified: true, genuine: true, understandInsights: true },
};

const positive = {
  ...base,
  sentiment: 'Positive',
  appreciations: ['TIMELY_PAYOUTS'],
  detailedReview: 'Payouts always arrived on time.',
  reinvestStatus: 'YES',
};

const neutral = {
  ...base,
  sentiment: 'Neutral',
  mixedReview: 'Returns were average for the category.',
  detailedReview: 'Service was fine but nothing special.',
};

const negative = {
  ...base,
  sentiment: 'Negative',
  concerns: ['DELAY_IN_RESPONSE'],
  contactStatus: ['CONTACTED_NO_RESPONSE'],
  negativeDescription: 'Redemption took 21 days to settle.',
  evidence: [{ path: FILE_PATH, docType: 'STATEMENT' }],
  resolutionStatus: 'CLOSED_UNRESOLVED',
};

/** Field paths that failed validation. */
function failures(input: unknown): string[] {
  const result = submitReviewBody.safeParse(input);
  return result.success ? [] : result.error.issues.map((i) => i.path.join('.'));
}

describe('submit review: valid reviews', () => {
  it('accepts a complete positive review', () => {
    expect(submitReviewBody.safeParse(positive).success).toBe(true);
  });

  it('accepts a complete neutral review', () => {
    expect(submitReviewBody.safeParse(neutral).success).toBe(true);
  });

  it('accepts a complete negative review', () => {
    expect(submitReviewBody.safeParse(negative).success).toBe(true);
  });

  it('applies defaults: empty product, FULL_NAME display, allowContact false, no evidence', () => {
    const { productScheme: _omit, ...rest } = positive;
    const parsed = submitReviewBody.parse(rest);
    expect(parsed.productScheme).toBe('');
    expect(parsed.displayMode).toBe('FULL_NAME');
    expect(parsed.declarations.allowContact).toBe(false);
    expect(parsed.evidence).toEqual([]);
  });

  it('trims text fields', () => {
    const parsed = submitReviewBody.parse({
      ...positive,
      productScheme: '  Bluechip  ',
      detailedReview: '   Payouts always arrived on time.   ',
    });
    expect(parsed.productScheme).toBe('Bluechip');
    expect(parsed.sentiment === 'Positive' && parsed.detailedReview).toBe(
      'Payouts always arrived on time.',
    );
  });
});

describe('submit review: step 1 (entity and product)', () => {
  it('requires a valid company id', () => {
    expect(failures({ ...positive, companyId: 'c1' })).toContain('companyId');
    expect(failures({ ...positive, companyId: undefined })).toContain('companyId');
  });

  it('requires country IN, AE or OTHER', () => {
    expect(failures({ ...positive, country: 'India' })).toContain('country');
    for (const country of ['IN', 'AE', 'OTHER']) {
      expect(failures({ ...positive, country })).toEqual([]);
    }
  });

  it('requires one of the 8 asset classes', () => {
    expect(failures({ ...positive, assetClass: 'Trading Platform' })).toContain('assetClass');
    for (const assetClass of ['EQ', 'MF', 'INS', 'BND', 'PMS', 'BRK', 'RE', 'CRY']) {
      expect(failures({ ...positive, assetClass })).toEqual([]);
    }
  });

  it('accepts a past year or "OLDER", rejects future years and years before 1950', () => {
    expect(failures({ ...positive, investmentYear: 'OLDER' })).toEqual([]);
    expect(failures({ ...positive, investmentYear: 2023 })).toEqual([]);
    expect(failures({ ...positive, investmentYear: new Date().getUTCFullYear() + 1 })).toContain(
      'investmentYear',
    );
    expect(failures({ ...positive, investmentYear: 1949 })).toContain('investmentYear');
    expect(failures({ ...positive, investmentYear: '2024' })).toContain('investmentYear');
  });

  it('requires an investment status code', () => {
    expect(failures({ ...positive, investmentStatus: 'yes' })).toContain('investmentStatus');
    for (const investmentStatus of ['CURRENTLY_INVESTED', 'EXITED', 'NEVER_INVESTED']) {
      expect(failures({ ...positive, investmentStatus })).toEqual([]);
    }
  });

  it('limits product/scheme to 200 characters', () => {
    expect(failures({ ...positive, productScheme: 'x'.repeat(201) })).toContain('productScheme');
  });
});

describe('submit review: steps 2-3 (sentiment and experience)', () => {
  it('rejects an unknown sentiment', () => {
    expect(failures({ ...positive, sentiment: 'Happy' })).toContain('sentiment');
  });

  it('positive needs at least one appreciation', () => {
    expect(failures({ ...positive, appreciations: [] })).toContain('appreciations');
  });

  it('positive needs a 10-800 character review', () => {
    expect(failures({ ...positive, detailedReview: 'Too short' })).toContain('detailedReview');
    expect(failures({ ...positive, detailedReview: 'x'.repeat(801) })).toContain('detailedReview');
    expect(failures({ ...positive, detailedReview: 'x'.repeat(10) })).toEqual([]);
    expect(failures({ ...positive, detailedReview: 'x'.repeat(800) })).toEqual([]);
    // Whitespace does not count towards the minimum.
    expect(failures({ ...positive, detailedReview: `   ${'x'.repeat(9)}   ` })).toContain(
      'detailedReview',
    );
  });

  it('positive needs an invest-again answer (YES, MAYBE, NO)', () => {
    const { reinvestStatus: _omit, ...rest } = positive;
    expect(failures(rest)).toContain('reinvestStatus');
    expect(failures({ ...positive, reinvestStatus: 'Maybe' })).toContain('reinvestStatus');
  });

  it('neutral needs both 10-800 character texts', () => {
    const { mixedReview: _m, ...noMixed } = neutral;
    const { detailedReview: _d, ...noDetailed } = neutral;
    expect(failures(noMixed)).toContain('mixedReview');
    expect(failures(noDetailed)).toContain('detailedReview');
    expect(failures({ ...neutral, mixedReview: 'short' })).toContain('mixedReview');
  });

  it('negative needs a concern, a contact status and a description', () => {
    expect(failures({ ...negative, concerns: [] })).toContain('concerns');
    expect(failures({ ...negative, contactStatus: [] })).toContain('contactStatus');
    const { negativeDescription: _omit, ...rest } = negative;
    expect(failures(rest)).toContain('negativeDescription');
  });

  it('negative needs 1-5 supporting documents', () => {
    expect(failures({ ...negative, evidence: [] })).toContain('evidence');
    const six = Array.from({ length: 6 }, (_, i) => ({
      path: `${USER_ID}/doc-${i}.pdf`,
      docType: 'EMAIL',
    }));
    expect(failures({ ...negative, evidence: six })).toContain('evidence');
  });

  it('negative detailed review is optional', () => {
    expect(failures(negative)).toEqual([]);
    expect(failures({ ...negative, detailedReview: 'Extra context about it.' })).toEqual([]);
  });

  it('evidence paths must be <user id>/<file name> in the evidence bucket', () => {
    for (const path of [
      'statement.pdf',
      `${USER_ID}/`,
      `${USER_ID}/a/b.pdf`,
      `../${USER_ID}/x.pdf`,
    ]) {
      expect(failures({ ...negative, evidence: [{ path, docType: 'EMAIL' }] }), path).toContain(
        'evidence.0.path',
      );
    }
    expect(failures({ ...negative, evidence: [{ path: FILE_PATH, docType: 'EMAIL' }] })).toEqual(
      [],
    );
  });

  it('evidence document type must be one of the 4 types', () => {
    for (const docType of EVIDENCE_TYPE_CODES) {
      expect(failures({ ...negative, evidence: [{ path: FILE_PATH, docType }] })).toEqual([]);
    }
    expect(failures({ ...negative, evidence: [{ path: FILE_PATH, docType: 'PHOTO' }] })).toContain(
      'evidence.0.docType',
    );
  });
});

describe('submit review: option codes', () => {
  it('accepts every appreciation, concern and contact status code from the app', () => {
    expect(failures({ ...positive, appreciations: [...APPRECIATION_CODES] })).toEqual([]);
    expect(
      failures({
        ...negative,
        concerns: [...CONCERN_CODES],
        contactStatus: [...CONTACT_STATUS_CODES],
      }),
    ).toEqual([]);
  });

  it('rejects unknown codes and labels with "Unknown option"', () => {
    const result = submitReviewBody.safeParse({
      ...negative,
      concerns: ['DELAY_IN_RESPONSE', 'Delay in response'],
      contactStatus: ['RESOLVED_FULLY'],
    });
    expect(result.success).toBe(false);
    const messages = Object.fromEntries(
      (result.error?.issues ?? []).map((i) => [i.path.join('.'), i.message]),
    );
    expect(messages).toEqual({
      'concerns.1': 'Unknown option',
      'contactStatus.0': 'Unknown option',
    });
    expect(failures({ ...positive, appreciations: ['Timely payouts'] })).toContain(
      'appreciations.0',
    );
  });
});

describe('Idempotency-Key header', () => {
  it('accepts 8-128 safe characters, such as a UUID', () => {
    expect(idempotencyHeaders.safeParse({ 'Idempotency-Key': crypto.randomUUID() }).success).toBe(
      true,
    );
  });

  it('rejects a missing, short or unsafe key', () => {
    for (const key of [undefined, 'short', 'has spaces in it', 'x'.repeat(129)]) {
      expect(idempotencyHeaders.safeParse({ 'Idempotency-Key': key }).success, String(key)).toBe(
        false,
      );
    }
  });
});

describe('submit review: step 4 (metrics)', () => {
  it.each([
    'transparency',
    'responsiveness',
    'easeOfProcess',
    'trustworthiness',
    'overallSatisfaction',
  ])('requires %s as a whole number from 1 to 5', (metric) => {
    for (const bad of [0, 6, 3.5, '4', undefined]) {
      expect(failures({ ...positive, metrics: { ...positive.metrics, [metric]: bad } })).toContain(
        `metrics.${metric}`,
      );
    }
    for (const good of [1, 5]) {
      expect(failures({ ...positive, metrics: { ...positive.metrics, [metric]: good } })).toEqual(
        [],
      );
    }
  });
});

describe('submit review: step 5 (resolution)', () => {
  it('accepts the 6 resolution statuses only', () => {
    for (const resolutionStatus of [
      'NOT_CONTACTED',
      'CONTACTED',
      'IN_PROGRESS',
      'RESOLVED',
      'PARTIALLY_RESOLVED',
      'CLOSED_UNRESOLVED',
    ]) {
      expect(failures({ ...positive, resolutionStatus })).toEqual([]);
    }
    expect(failures({ ...positive, resolutionStatus: 'UNRESOLVED' })).toContain('resolutionStatus');
  });

  it('limits the follow-up note to 400 characters', () => {
    expect(failures({ ...positive, followUpNote: 'x'.repeat(400) })).toEqual([]);
    expect(failures({ ...positive, followUpNote: 'x'.repeat(401) })).toContain('followUpNote');
  });
});

describe('submit review: step 6 (declarations and privacy)', () => {
  it.each(['kycVerified', 'genuine', 'understandInsights'])('requires %s to be true', (key) => {
    expect(
      failures({ ...positive, declarations: { ...positive.declarations, [key]: false } }),
    ).toContain(`declarations.${key}`);
  });

  it('accepts the 3 display modes only', () => {
    for (const displayMode of ['FULL_NAME', 'INITIALS', 'ANONYMOUS']) {
      expect(failures({ ...positive, displayMode })).toEqual([]);
    }
    expect(failures({ ...positive, displayMode: 'HIDDEN' })).toContain('displayMode');
  });
});

describe('update resolution body', () => {
  it('requires a valid resolution status', () => {
    expect(updateResolutionBody.safeParse({}).success).toBe(false);
    expect(updateResolutionBody.safeParse({ resolutionStatus: 'DONE' }).success).toBe(false);
  });

  it('distinguishes an omitted note (keep), null (clear) and text (set)', () => {
    expect(updateResolutionBody.parse({ resolutionStatus: 'RESOLVED' }).followUpNote).toBe(
      undefined,
    );
    expect(
      updateResolutionBody.parse({ resolutionStatus: 'RESOLVED', followUpNote: null }).followUpNote,
    ).toBe(null);
    expect(
      updateResolutionBody.parse({ resolutionStatus: 'RESOLVED', followUpNote: ' Refunded ' })
        .followUpNote,
    ).toBe('Refunded');
  });

  it('limits the note to 400 characters', () => {
    expect(
      updateResolutionBody.safeParse({
        resolutionStatus: 'RESOLVED',
        followUpNote: 'x'.repeat(401),
      }).success,
    ).toBe(false);
  });
});

describe('company reviews list query', () => {
  it('defaults to page 1, 20 per page, most recent first', () => {
    expect(listCompanyReviewsQuery.parse({})).toEqual({ page: 1, pageSize: 20, sort: 'recent' });
  });

  it('parses comma-separated filters', () => {
    const q = listCompanyReviewsQuery.parse({
      sort: 'highest',
      filter: {
        sentiment: 'Positive,Negative',
        resolution: 'RESOLVED',
        assetClass: 'MF',
        investedStatus: 'EXITED',
        year: '2024,2025',
      },
    });
    expect(q.filter).toEqual({
      sentiment: ['Positive', 'Negative'],
      resolution: ['RESOLVED'],
      assetClass: ['MF'],
      investedStatus: ['EXITED'],
      year: [2024, 2025],
    });
  });

  it('rejects unknown sorts, filter values and filter names', () => {
    expect(listCompanyReviewsQuery.safeParse({ sort: 'trending' }).success).toBe(false);
    expect(listCompanyReviewsQuery.safeParse({ filter: { sentiment: 'Happy' } }).success).toBe(
      false,
    );
    expect(listCompanyReviewsQuery.safeParse({ filter: { colour: 'red' } }).success).toBe(false);
  });
});
