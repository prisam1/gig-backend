// Uploads the Evidence tab's documents for the app's petitions (migration
// 20261118120000_representation_section_content.sql adds their rows). They are placeholders, sized
// as the app shows them (1.2 MB, 340 KB, 2.8 MB), until GIG uploads the real documents.
//
//   cd gig-backend
//   npm run seed:representation-evidence
//
// Reads the Supabase settings from .env. Safe to run more than once: it overwrites the objects.
import { crc32 } from 'node:zlib';
import { filesStorage } from '../src/modules/files/files.storage';
import { representationsRepository } from '../src/modules/representations/representations.repository';

const ascii = (text: string) => Buffer.from(text, 'latin1');

/** Grows the padding until the built file is exactly `size` bytes. */
function exactly(build: (padding: number) => Buffer, size: number): Buffer {
  let padding = 0;
  for (let attempt = 0; attempt < 10; attempt++) {
    const body = build(padding);
    if (body.length === size) return body;
    padding += size - body.length;
  }
  throw new Error(`could not build a file of ${size} bytes`);
}

/** A one-page PDF saying it is a placeholder, padded with comment lines to exactly `size` bytes. */
function placeholderPdf(title: string, size: number): Buffer {
  const build = (padding: number) => {
    const text = `Placeholder: ${title}. GIG will replace this file with the real document.`;
    const stream = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
    const objects = [
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
      `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    ];
    // Comment lines (ignored by readers) between the header and the first object.
    const lines: string[] = [];
    for (let left = padding; left > 0; ) {
      const n = Math.min(left, 100);
      lines.push(n === 1 ? '\n' : `%${'0'.repeat(n - 2)}\n`);
      left -= n;
    }
    let body = `%PDF-1.4\n${lines.join('')}`;
    const offsets: number[] = [];
    objects.forEach((object, i) => {
      offsets.push(body.length);
      body += `${i + 1} 0 obj\n${object}\nendobj\n`;
    });
    const xref = body.length;
    body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
    body += offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
    body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    return ascii(body);
  };
  return exactly(build, size);
}

/** A ZIP with stored (uncompressed) entries, as an .xlsx is. */
function zip(entries: { name: string; data: Buffer }[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const fileName = ascii(name);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(fileName.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(fileName.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, fileName, data);
    centrals.push(central, fileName);
    offset += local.length + fileName.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

/** A one-sheet workbook saying it is a placeholder, padded (an XML comment) to exactly `size` bytes. */
function placeholderXlsx(title: string, size: number): Buffer {
  const build = (padding: number) =>
    zip([
      {
        name: '[Content_Types].xml',
        data: ascii(
          '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
            '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
            '<Default Extension="xml" ContentType="application/xml"/>' +
            '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
            '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
            '</Types>',
        ),
      },
      {
        name: '_rels/.rels',
        data: ascii(
          '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
            '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
            '</Relationships>',
        ),
      },
      {
        name: 'xl/workbook.xml',
        data: ascii(
          '<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
            '<sheets><sheet name="Placeholder" sheetId="1" r:id="rId1"/></sheets></workbook>',
        ),
      },
      {
        name: 'xl/_rels/workbook.xml.rels',
        data: ascii(
          '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
            '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
            '</Relationships>',
        ),
      },
      {
        name: 'xl/worksheets/sheet1.xml',
        data: ascii(
          '<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' +
            `<row r="1"><c r="A1" t="inlineStr"><is><t>Placeholder: ${title}. GIG will replace this file with the real document.</t></is></c></row>` +
            `</sheetData></worksheet><!--${'0'.repeat(padding)}-->`,
        ),
      },
    ]);
  return exactly(build, size);
}

const FILES: Record<string, (size: number) => Buffer> = {
  'primary-research-brief.pdf': (size) => placeholderPdf('Primary Research Brief', size),
  'regulatory-comparison-table.xlsx': (size) => placeholderXlsx('Regulatory Comparison Table', size),
  'investor-survey-data.pdf': (size) => placeholderPdf('Investor Survey Data', size),
};

async function main() {
  const { items } = await representationsRepository.findAll({
    page: 1,
    pageSize: 100,
    sort: 'recent',
  });
  let uploaded = 0;
  for (const petition of items) {
    for (const document of await representationsRepository.findEvidence(petition)) {
      const make = FILES[document.file.objectKey.split('/').pop() ?? ''];
      if (!make) continue;
      const body = make(document.file.sizeBytes);
      if (body.length !== document.file.sizeBytes) {
        throw new Error(`${document.file.objectKey}: built ${body.length} bytes, expected ${document.file.sizeBytes}`);
      }
      await filesStorage.upload(document.file.bucket, document.file.objectKey, body, document.file.mimeType);
      uploaded++;
      console.log(`uploaded ${document.file.objectKey} (${body.length} bytes)`);
    }
  }
  console.log(`${uploaded} evidence documents uploaded`);
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    console.error(error);
    process.exit(1);
  },
);
