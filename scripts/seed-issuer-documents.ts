// Uploads the PDF that the Ratings details screen's Download saves, for each of the app's issuers
// (migration 20261118160000_rating_section_content.sql sets their document paths). It is the
// document the app used to bundle (scripts/assets/issuer-document.pdf).
//
//   cd gig-backend
//   npm run seed:issuer-documents
//
// Reads the Supabase settings from .env. Safe to run more than once: it overwrites the objects.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { filesStorage } from '../src/modules/files/files.storage';
import { ratingsRepository } from '../src/modules/ratings/ratings.repository';
import { ISSUER_DOCUMENTS_BUCKET } from '../src/modules/ratings/ratings.service';

async function main() {
  const pdf = readFileSync(join(__dirname, 'assets', 'issuer-document.pdf'));
  const { items } = await ratingsRepository.findIssuers({ page: 1, pageSize: 100, sort: 'display' });
  let uploaded = 0;
  for (const issuer of items) {
    const path = await ratingsRepository.findDocumentPath(issuer.id);
    if (!path) continue;
    await filesStorage.upload(ISSUER_DOCUMENTS_BUCKET, path, pdf, 'application/pdf');
    uploaded++;
    console.log(`uploaded ${path} (${pdf.length} bytes)`);
  }
  console.log(`${uploaded} issuer documents uploaded`);
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    console.error(error);
    process.exit(1);
  },
);
