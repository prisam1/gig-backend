import { PDFDocument } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { displayNameFor, initialsOf } from '../../src/lib/displayName';
import { escapeLike, containsPattern } from '../../src/lib/http';
import { hashRequest, idempotencyHeaders } from '../../src/lib/idempotency';
import {
  renderSignatureReceipt,
  toPdfText,
} from '../../src/modules/representations/representations.receipt';

describe('display names', () => {
  it('shows the full name, initials or nothing', () => {
    expect(displayNameFor(' Shreya Mehta ', 'FULL_NAME')).toBe('Shreya Mehta');
    expect(displayNameFor('shreya  mehta', 'INITIALS')).toBe('S. M.');
    expect(displayNameFor('Shreya Mehta', 'ANONYMOUS')).toBe(null);
    expect(displayNameFor('   ', 'FULL_NAME')).toBe(null);
    expect(initialsOf('')).toBe(null);
  });
});

describe('idempotency helpers', () => {
  it('accepts UUID-like keys and rejects short or unsafe ones', () => {
    expect(idempotencyHeaders.safeParse({ 'Idempotency-Key': crypto.randomUUID() }).success).toBe(
      true,
    );
    for (const key of [undefined, 'short', 'has spaces in it']) {
      expect(idempotencyHeaders.safeParse({ 'Idempotency-Key': key }).success).toBe(false);
    }
  });

  it('hashes equal bodies equally and different bodies differently', () => {
    expect(hashRequest({ a: 1 })).toBe(hashRequest({ a: 1 }));
    expect(hashRequest({ a: 1 })).not.toBe(hashRequest({ a: 2 }));
    expect(hashRequest({ a: 1 })).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('search helpers', () => {
  it('escapes LIKE wildcards', () => {
    expect(escapeLike('50%_off\\')).toBe('50\\%\\_off\\\\');
    expect(containsPattern('Alpha%')).toBe('%alpha\\%%');
  });
});

describe('signature receipt PDF', () => {
  const content = {
    signatureCode: 'GIG-ET7ZWDTZK',
    petitionTitle: 'Mandatory T+1 Settlement Disclosure',
    signerDisplay: 'Shreya Mehta',
    investorType: 'Retail Investor (Experienced Investors)',
    membership: 'Prive (verified investor)',
    signedAt: new Date('2026-10-27T10:24:07Z'),
    regulators: ['SEBI'],
    consents: ['I support this representation being submitted to the regulator(s) listed.'],
  };

  it('renders a one-page PDF with the signature ID in its title', async () => {
    const bytes = await renderSignatureReceipt(content);
    expect(Buffer.from(bytes.slice(0, 5)).toString()).toBe('%PDF-');
    const pdf = await PDFDocument.load(bytes);
    expect(pdf.getPageCount()).toBe(1);
    expect(pdf.getTitle()).toBe('GIG signature receipt GIG-ET7ZWDTZK');
  });

  it('renders names and titles outside Latin-1 without failing', async () => {
    await expect(
      renderSignatureReceipt({
        ...content,
        signerDisplay: 'श्रेया मेहता',
        petitionTitle: '“Fees” – ₹10 cap 😀',
      }),
    ).resolves.toBeInstanceOf(Uint8Array);
  });

  it('maps typography to plain text and replaces unsupported characters', () => {
    expect(toPdfText('“Fees” – ₹10 ‘cap’')).toBe('"Fees" - INR 10 \'cap\'');
    expect(toPdfText('श्रे')).toBe('????');
    expect(toPdfText('Zoë Müller')).toBe('Zoë Müller');
  });
});
