import { callDb, isUniqueViolation, isUniqueViolationOf } from '../../lib/db';
import { containsPattern } from '../../lib/http';
import type { Member } from '../../lib/membership';
import { createSignedDownload, fileNameOf } from '../../lib/storage';
import { AppError, assertNoFieldErrors, validationError } from '../../middleware/errorHandler';
import type { ClientContext } from '../../middleware/requestContext';
import { limitOffset, notFound, pageMeta, slugify, slugTaken, unexpected } from './admin.shared';
import type {
  CreateRepresentationInput,
  ListAdminRepresentationsQuery,
  RepresentationDocumentInput,
  RepresentationStatusInput,
  UpdateRepresentationInput,
} from './content.schemas';
import { missingUploads, UPLOAD_TARGET_CONFIG } from './uploads.service';

const DOCUMENTS_BUCKET = UPLOAD_TARGET_CONFIG.REPRESENTATION_DOCUMENT.bucket;

const representationNotFound = () => notFound('Representation');

/** Checks each staff upload finished, then shapes it for the database. */
async function prepareDocuments(documents: RepresentationDocumentInput[]) {
  assertNoFieldErrors(
    await missingUploads(
      DOCUMENTS_BUCKET,
      documents.map((doc, i) => ({ field: `documents.${i}.path`, path: doc.path })),
    ),
  );
  return documents.map((doc) => ({
    documentType: doc.documentType,
    title: doc.title,
    objectKey: doc.path,
    mimeType: doc.mimeType,
    sizeBytes: doc.sizeBytes,
  }));
}

/** A document can be attached to one petition once (object keys are unique). */
function documentConflict(error: unknown): unknown {
  return isUniqueViolationOf(error, 'representation_documents_object_key_key')
    ? new AppError(409, 'DOCUMENT_ALREADY_ATTACHED', 'One of these files is already attached')
    : error;
}

export async function listRepresentations(query: ListAdminRepresentationsQuery) {
  const result = await callDb('app_admin_find_representations', {
    p_q_pattern: query.q ? containsPattern(query.q) : null,
    p_statuses: query.filter?.status ?? null,
    p_include_deleted: query.state === 'ALL',
    ...limitOffset(query),
  });
  return { items: result.items, meta: pageMeta(query, result.total) };
}

/** One petition with every document (5-minute links for files that passed the scan) and its history. */
export async function getRepresentation(id: string) {
  const representation = await callDb('app_admin_get_representation', { p_public_id: id });
  if (!representation) throw representationNotFound();

  const documents = await Promise.all(
    representation.documents.map(async (doc) => ({
      ...doc,
      download:
        doc.scanStatus === 'INFECTED'
          ? null
          : await createSignedDownload(doc.bucket, doc.objectKey, fileNameOf(doc.objectKey)),
    })),
  );
  return { ...representation, documents };
}

async function save(
  actor: Member,
  id: string | null,
  fields: UpdateRepresentationInput,
  ctx: ClientContext,
): Promise<string> {
  let result;
  try {
    result = await callDb('app_admin_save_representation', {
      p_actor_id: actor.userId,
      p_public_id: id,
      p_fields: fields,
      p_ctx: ctx,
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw slugTaken();
    throw error;
  }
  if ('fields' in result) throw validationError(result.fields);
  // NOT_FOUND is the only error it reports (the type says so).
  if ('error' in result) throw representationNotFound();
  return result.id;
}

export async function createRepresentation(
  actor: Member,
  input: CreateRepresentationInput,
  ctx: ClientContext,
) {
  const id = await save(actor, null, { ...input, slug: input.slug ?? slugify(input.title) }, ctx);
  return getRepresentation(id);
}

export async function updateRepresentation(
  actor: Member,
  id: string,
  input: UpdateRepresentationInput,
  ctx: ClientContext,
) {
  await save(actor, id, input, ctx);
  return getRepresentation(id);
}

/** Soft delete: the petition leaves every list; its signatures and history are kept. */
export async function deleteRepresentation(
  actor: Member,
  id: string,
  ctx: ClientContext,
): Promise<void> {
  const deleted = await callDb('app_admin_delete_representation', {
    p_actor_id: actor.userId,
    p_public_id: id,
    p_ctx: ctx,
  });
  if (!deleted) throw representationNotFound();
}

/** Moves the track forward (UNDER_REVIEW ... RESOLVED) with an optional note and documents. */
export async function changeRepresentationStatus(
  actor: Member,
  id: string,
  input: RepresentationStatusInput,
  ctx: ClientContext,
) {
  const documents = await prepareDocuments(input.documents);
  let result;
  try {
    result = await callDb('app_admin_representation_status', {
      p_actor_id: actor.userId,
      p_public_id: id,
      p_status: input.status,
      p_note: input.note ?? null,
      p_documents: documents,
      p_ctx: ctx,
    });
  } catch (error) {
    throw documentConflict(error);
  }
  if ('error' in result) {
    switch (result.error) {
      case 'NOT_FOUND':
        throw representationNotFound();
      case 'INVALID_TRANSITION':
        throw new AppError(
          409,
          'INVALID_TRANSITION',
          `The track can only move forward from ${result.status ?? 'its current status'}`,
        );
      default:
        throw unexpected('app_admin_representation_status', result);
    }
  }
  return {
    id,
    trackStatus: result.trackStatus,
    previousStatus: result.previousStatus,
    documents: result.documents,
  };
}

/** Attaches documents (evidence and others) without changing the status. */
export async function addRepresentationDocuments(
  actor: Member,
  id: string,
  input: RepresentationDocumentInput[],
  ctx: ClientContext,
) {
  const documents = await prepareDocuments(input);
  let created;
  try {
    created = await callDb('app_admin_add_representation_documents', {
      p_actor_id: actor.userId,
      p_public_id: id,
      p_documents: documents,
      p_ctx: ctx,
    });
  } catch (error) {
    throw documentConflict(error);
  }
  if (!created) throw representationNotFound();
  return created;
}

/** Signatures with each signer's identity, newest first, for reviewing suspicious ones. */
export async function listSignatures(
  id: string,
  query: { page: number; pageSize: number; includeRemoved: boolean },
) {
  const result = await callDb('app_admin_representation_signatures', {
    p_public_id: id,
    p_include_removed: query.includeRemoved,
    ...limitOffset(query),
  });
  if (!result) throw representationNotFound();
  return { items: result.items, meta: pageMeta(query, result.total) };
}

/** Removes a signature: it stops counting and the signer may sign again. */
export async function removeSignature(
  actor: Member,
  representationId: string,
  signatureId: string,
  reason: string,
  ctx: ClientContext,
): Promise<void> {
  const result = await callDb('app_admin_remove_signature', {
    p_actor_id: actor.userId,
    p_representation_id: representationId,
    p_signature_id: signatureId,
    p_reason: reason,
    p_ctx: ctx,
  });
  if ('error' in result) {
    switch (result.error) {
      case 'NOT_FOUND':
        throw notFound('Signature');
      case 'ALREADY_REMOVED':
        throw new AppError(409, 'ALREADY_REMOVED', 'This signature was already removed');
      default:
        throw unexpected('app_admin_remove_signature', result);
    }
  }
}
