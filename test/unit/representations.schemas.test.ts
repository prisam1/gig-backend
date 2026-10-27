import { describe, expect, it } from 'vitest';
import {
  listRepresentationsQuery,
  representationIdParams,
  signRepresentationBody,
} from '../../src/modules/representations/representations.schemas';

const FILE_ID = '33333333-3333-4333-8333-333333333333';

const validSignature = {
  displayMode: 'INITIALS',
  investorType: 'RETAIL_BEGINNER',
  signatureFileId: FILE_ID,
  consents: { supportSubmission: true, digitalEndorsement: true },
};

function failures(input: unknown): string[] {
  const result = signRepresentationBody.safeParse(input);
  return result.success ? [] : result.error.issues.map((i) => i.path.join('.') || '_');
}

describe('sign representation body', () => {
  it('accepts a display choice, an investor type, a signature file and both consents', () => {
    expect(signRepresentationBody.parse(validSignature)).toEqual(validSignature);
  });

  it('accepts the three name display choices only', () => {
    for (const displayMode of ['FULL_NAME', 'INITIALS', 'ANONYMOUS']) {
      expect(failures({ ...validSignature, displayMode })).toEqual([]);
    }
    expect(failures({ ...validSignature, displayMode: 'Show full name' })).toContain('displayMode');
    expect(failures({ ...validSignature, displayMode: undefined })).toContain('displayMode');
  });

  it('makes the investor type optional', () => {
    const { investorType: _omit, ...rest } = validSignature;
    expect(signRepresentationBody.parse(rest).investorType).toBe(null);
    expect(
      signRepresentationBody.parse({ ...validSignature, investorType: null }).investorType,
    ).toBe(null);
    expect(failures({ ...validSignature, investorType: 'Retail Investor' })).toContain(
      'investorType',
    );
  });

  it('requires an uploaded signature file', () => {
    expect(failures({ ...validSignature, signatureFileId: undefined })).toContain(
      'signatureFileId',
    );
    expect(failures({ ...validSignature, signatureFileId: 'signature.png' })).toContain(
      'signatureFileId',
    );
  });

  it.each(['supportSubmission', 'digitalEndorsement'])('requires the %s consent', (consent) => {
    expect(
      failures({ ...validSignature, consents: { ...validSignature.consents, [consent]: false } }),
    ).toContain(`consents.${consent}`);
  });

  it('rejects unknown fields (the app used to send review-form fields)', () => {
    expect(failures({ ...validSignature, country: 'Show full name' })).toContain('_');
  });
});

describe('representation queries', () => {
  it('requires a UUID id', () => {
    expect(representationIdParams.safeParse({ id: 'dummy-1' }).success).toBe(false);
  });

  it('defaults to petitions closing soonest, 20 per page', () => {
    expect(listRepresentationsQuery.parse({})).toEqual({
      page: 1,
      pageSize: 20,
      sort: 'closing_soon',
    });
  });

  it('parses status, country and open-for-signing filters', () => {
    expect(
      listRepresentationsQuery.parse({
        filter: { status: 'OPEN,CLOSING_SOON', country: 'IN', openForSigning: 'true' },
      }).filter,
    ).toEqual({ status: ['OPEN', 'CLOSING_SOON'], country: ['IN'], openForSigning: true });
  });

  it('rejects the app labels instead of codes', () => {
    expect(
      listRepresentationsQuery.safeParse({ filter: { status: 'Under Review by GIG' } }).success,
    ).toBe(false);
    expect(listRepresentationsQuery.safeParse({ filter: { country: 'India' } }).success).toBe(
      false,
    );
    expect(listRepresentationsQuery.safeParse({ sort: 'sb_trending' }).success).toBe(false);
  });
});
