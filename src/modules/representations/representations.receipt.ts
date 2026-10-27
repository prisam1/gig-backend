import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';

// The signature receipt PDF the app offers under "Download Receipt".

export interface SignatureReceiptContent {
  signatureCode: string;
  petitionTitle: string;
  /** As shown publicly: full name, initials, or "Anonymous (counted)". */
  signerDisplay: string;
  investorType: string | null;
  membership: string;
  signedAt: Date;
  regulators: string[];
  /** The consent declarations the signer accepted, word for word. */
  consents: string[];
}

const PAGE_WIDTH = 595.28; // A4
const PAGE_HEIGHT = 841.89;
const MARGIN = 56;
const CONTENT_WIDTH = PAGE_WIDTH - 2 * MARGIN;
const INK = rgb(0.12, 0.12, 0.12);
const MUTED = rgb(0.42, 0.42, 0.42);
const ACCENT = rgb(0.0, 0.11, 0.22);

/**
 * The standard PDF fonts only cover Windows-1252 (Latin-1). Map common typography to ASCII and
 * replace anything else (e.g. Devanagari or Arabic names) so rendering never fails.
 */
export function toPdfText(text: string): string {
  return text
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/₹/g, 'INR ')
    .replace(/[^\x20-\x7E\xA0-\xFF]/g, '?');
}

function wrap(text: string, font: PDFFont, size: number, width: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of toPdfText(text).split(/\s+/).filter(Boolean)) {
    const candidate = line ? `${line} ${word}` : word;
    if (font.widthOfTextAtSize(candidate, size) <= width || !line) {
      line = candidate;
    } else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

class Writer {
  private y = PAGE_HEIGHT - MARGIN;

  constructor(
    private readonly page: PDFPage,
    private readonly regular: PDFFont,
    private readonly bold: PDFFont,
  ) {}

  text(value: string, options: { size?: number; bold?: boolean; color?: typeof INK } = {}): void {
    const size = options.size ?? 11;
    const font = options.bold ? this.bold : this.regular;
    for (const line of wrap(value, font, size, CONTENT_WIDTH)) {
      this.page.drawText(line, {
        x: MARGIN,
        y: this.y - size,
        size,
        font,
        color: options.color ?? INK,
      });
      this.y -= size * 1.45;
    }
  }

  field(label: string, value: string): void {
    this.text(label.toUpperCase(), { size: 8, color: MUTED });
    this.text(value, { size: 12, bold: true });
    this.gap(6);
  }

  rule(): void {
    this.gap(4);
    this.page.drawLine({
      start: { x: MARGIN, y: this.y },
      end: { x: PAGE_WIDTH - MARGIN, y: this.y },
      thickness: 0.6,
      color: MUTED,
    });
    this.gap(14);
  }

  gap(points: number): void {
    this.y -= points;
  }
}

function formatTimestamp(date: Date): string {
  return `${date.toISOString().replace('T', ' ').slice(0, 19)} UTC`;
}

export async function renderSignatureReceipt(
  content: SignatureReceiptContent,
): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.setTitle(`GIG signature receipt ${content.signatureCode}`);
  pdf.setProducer('Global Investorz Group');
  pdf.setCreationDate(content.signedAt);

  const page = pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  const writer = new Writer(
    page,
    await pdf.embedFont(StandardFonts.Helvetica),
    await pdf.embedFont(StandardFonts.HelveticaBold),
  );

  writer.text('GLOBAL INVESTORZ GROUP', { size: 10, bold: true, color: ACCENT });
  writer.text('Your signature is appreciated', { size: 20, bold: true });
  writer.text('Receipt for your signature on a collective representation.', { color: MUTED });
  writer.rule();

  writer.field('Signature ID', content.signatureCode);
  writer.field('Petition', content.petitionTitle);
  writer.field('Signed as', content.signerDisplay);
  writer.field('Investor type', content.investorType ?? 'Not specified');
  writer.field('Membership', content.membership);
  writer.field('Timestamp', formatTimestamp(content.signedAt));
  if (content.regulators.length > 0) {
    writer.field('To be submitted to', content.regulators.join(', '));
  }
  writer.rule();

  writer.text('DECLARATIONS ACCEPTED', { size: 8, color: MUTED });
  for (const consent of content.consents) {
    writer.text(`- ${consent}`, { size: 10 });
  }
  writer.rule();

  writer.text(
    'This petition is created and supported by participating investors. GIG facilitates collection and submission.',
    { size: 9, color: MUTED },
  );

  return pdf.save();
}
