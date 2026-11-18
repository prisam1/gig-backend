// Uploads the Download DD documents (Offer Letter, Financial Year 1-3) of the app's roadshows
// (migration 20261118170000_roadshow_section_content.sql adds their rows). They are placeholders
// (scripts/assets/issuer-document.pdf) until GIG uploads the real documents.
//
//   cd gig-backend
//   npm run seed:roadshow-documents
//
// Reads the Supabase settings from .env. Safe to run more than once: it overwrites the objects.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { supabaseAdmin, unwrap } from '../src/lib/supabase';
import { filesStorage } from '../src/modules/files/files.storage';
import { ROADSHOW_DOCUMENTS_BUCKET } from '../src/modules/roadshows/roadshows.service';

async function main() {
  const pdf = readFileSync(join(__dirname, 'assets', 'issuer-document.pdf'));
  const documents = unwrap(
    await supabaseAdmin
      .from('roadshow_documents')
      .select('id, storage_path, roadshow:roadshows!inner(status)')
      .eq('roadshow.status', 'PUBLISHED'),
  );
  for (const document of documents) {
    await filesStorage.upload(ROADSHOW_DOCUMENTS_BUCKET, document.storage_path, pdf, 'application/pdf');
    unwrap(
      await supabaseAdmin
        .from('roadshow_documents')
        .update({ size_bytes: pdf.length })
        .eq('id', document.id)
        .select('id'),
    );
    console.log(`uploaded ${document.storage_path} (${pdf.length} bytes)`);
  }
  console.log(`${documents.length} roadshow documents uploaded`);
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    console.error(error);
    process.exit(1);
  },
);
