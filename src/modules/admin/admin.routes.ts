import { Router } from 'express';
import { z } from 'zod';
import { readIdempotencyKey, REPLAYED_HEADER } from '../../lib/idempotency';
import { sendData, sendPage } from '../../lib/http';
import { getAuth, requireAuth } from '../../middleware/auth';
import { clientContext, noStore } from '../../middleware/requestContext';
import { parse } from '../../middleware/validate';
import { assertPermission, can, permissionsOf, requireStaff, staffRoles } from './admin.access';
import {
  auditLogsQuery,
  creditChangeBody,
  idParams,
  listKycQuery,
  listUsersQuery,
  moderationDecisionBody,
  moderationItemQuery,
  moderationQueueQuery,
  reasonSchema,
  rejectKycBody,
  setRolesBody,
  updateUserBody,
  uploadUrlBody,
} from './admin.schemas';
import { listAuditLogs } from './audit.service';
import * as catalog from './catalog.service';
import {
  answerQuestionBody,
  createCompanyBody,
  createIssuerBody,
  createLearnBody,
  createRepresentationBody,
  createRoadshowBody,
  financialsBody,
  listAdminLearnQuery,
  listAdminRoadshowsQuery,
  listCompaniesQuery,
  listIssuersQuery,
  listRepresentationsQuery,
  questionParams,
  representationDocumentsBody,
  representationStatusBody,
  roadshowDocumentBody,
  roadshowDocumentParams,
  signatureParams,
  signaturesQuery,
  updateCompanyBody,
  updateIssuerBody,
  updateLearnBody,
  updateRepresentationBody,
  updateRoadshowBody,
} from './content.schemas';
import { changeCredits } from './credits.service';
import { decideKyc, getKycSubmission, listKycSubmissions } from './kyc.service';
import * as learn from './learn.service';
import { decideModeration, getModerationItem, listModerationQueue } from './moderation.service';
import * as representations from './representations.service';
import * as roadshows from './roadshows.service';
import { createStaffUploadUrl, UPLOAD_TARGET_CONFIG } from './uploads.service';
import * as users from './users.service';

// /admin: the GIG staff console API. Every route needs a signed-in account with a staff role and
// the permission named on the route (see PERMISSIONS in admin.access.ts). Responses are never
// cached. Changes are recorded in the audit log.

export const adminRouter = Router();

adminRouter.use(noStore, requireAuth, requireStaff);

// GET /admin/me — the staff member's roles and what they allow, for the console's navigation.
adminRouter.get('/me', (req, res) => {
  const auth = getAuth(req);
  const roles = staffRoles(req);
  sendData(res, {
    id: auth.userPublicId,
    name: auth.fullName,
    roles,
    permissions: permissionsOf(roles),
  });
});

// ---------------------------------------------------------------------------------------------
// Users and staff roles
//   GET   /admin/users              search by exact email / phone or part of a name; filters
//   GET   /admin/users/:id          account, contact details, KYC, activity (audited)
//   PATCH /admin/users/:id          change tier, suspend or reactivate (with a reason)
//   PUT   /admin/users/:id/roles    replace staff roles
// ---------------------------------------------------------------------------------------------

adminRouter.get('/users', can('users.read'), async (req, res) => {
  const { items, meta } = await users.listUsers(parse(listUsersQuery, req.query));
  sendPage(res, items, meta);
});

adminRouter.get('/users/:id', can('users.read'), async (req, res) => {
  const { id } = parse(idParams, req.params);
  sendData(res, await users.getUser(getAuth(req), id, clientContext(req)));
});

adminRouter.patch('/users/:id', can('users.manage'), async (req, res) => {
  const { id } = parse(idParams, req.params);
  const body = parse(updateUserBody, req.body);
  sendData(res, await users.updateUser(getAuth(req), id, body, clientContext(req)));
});

adminRouter.put('/users/:id/roles', can('roles.manage'), async (req, res) => {
  const { id } = parse(idParams, req.params);
  const { roles } = parse(setRolesBody, req.body);
  sendData(res, await users.setRoles(getAuth(req), id, roles, clientContext(req)));
});

// ---------------------------------------------------------------------------------------------
// KYC
//   GET  /admin/kyc                 queue (PENDING by default, oldest first)
//   GET  /admin/kyc/:id             submission with 5-minute document links (audited)
//   POST /admin/kyc/:id/approve     grant the submitted tier
//   POST /admin/kyc/:id/reject      { reason } shown to the member
// ---------------------------------------------------------------------------------------------

adminRouter.get('/kyc', can('kyc.review'), async (req, res) => {
  const { items, meta } = await listKycSubmissions(parse(listKycQuery, req.query));
  sendPage(res, items, meta);
});

adminRouter.get('/kyc/:id', can('kyc.review'), async (req, res) => {
  const { id } = parse(idParams, req.params);
  sendData(res, await getKycSubmission(getAuth(req), id, clientContext(req)));
});

adminRouter.post('/kyc/:id/approve', can('kyc.review'), async (req, res) => {
  const { id } = parse(idParams, req.params);
  parse(z.strictObject({}), req.body);
  sendData(res, await decideKyc(getAuth(req), id, { decision: 'APPROVE' }, clientContext(req)));
});

adminRouter.post('/kyc/:id/reject', can('kyc.review'), async (req, res) => {
  const { id } = parse(idParams, req.params);
  const { reason } = parse(rejectKycBody, req.body);
  sendData(
    res,
    await decideKyc(getAuth(req), id, { decision: 'REJECT', reason }, clientContext(req)),
  );
});

// ---------------------------------------------------------------------------------------------
// Moderation: reviews, ratings, roadshow questions and offers
//   GET  /admin/moderation/queue          filter[type], filter[status] (PENDING by default)
//   GET  /admin/moderation/:id?type=      one item in full (review evidence links included)
//   POST /admin/moderation/:id/decision   { type, decision, note? }
// ---------------------------------------------------------------------------------------------

adminRouter.get('/moderation/queue', can('moderation.read'), async (req, res) => {
  const { items, meta } = await listModerationQueue(parse(moderationQueueQuery, req.query));
  sendPage(res, items, meta);
});

adminRouter.get('/moderation/:id', can('moderation.read'), async (req, res) => {
  const { id } = parse(idParams, req.params);
  const { type } = parse(moderationItemQuery, req.query);
  sendData(res, await getModerationItem(type, id));
});

adminRouter.post('/moderation/:id/decision', can('moderation.decide'), async (req, res) => {
  const { id } = parse(idParams, req.params);
  const body = parse(moderationDecisionBody, req.body);
  sendData(res, await decideModeration(getAuth(req), id, body, clientContext(req)));
});

// ---------------------------------------------------------------------------------------------
// Companies and issuers (CRUD; DELETE is a soft delete)
// ---------------------------------------------------------------------------------------------

adminRouter.get('/companies', can('content.read'), async (req, res) => {
  const { items, meta } = await catalog.listCompanies(parse(listCompaniesQuery, req.query));
  sendPage(res, items, meta);
});

adminRouter.get('/companies/:id', can('content.read'), async (req, res) => {
  const { id } = parse(idParams, req.params);
  sendData(res, await catalog.getCompany(id));
});

adminRouter.post('/companies', can('content.manage'), async (req, res) => {
  const body = parse(createCompanyBody, req.body);
  sendData(res, await catalog.createCompany(getAuth(req), body, clientContext(req)), 201);
});

adminRouter.patch('/companies/:id', can('content.manage'), async (req, res) => {
  const { id } = parse(idParams, req.params);
  const body = parse(updateCompanyBody, req.body);
  sendData(res, await catalog.updateCompany(getAuth(req), id, body, clientContext(req)));
});

adminRouter.delete('/companies/:id', can('content.manage'), async (req, res) => {
  const { id } = parse(idParams, req.params);
  await catalog.deleteCompany(getAuth(req), id, clientContext(req));
  res.status(204).end();
});

adminRouter.get('/issuers', can('content.read'), async (req, res) => {
  const { items, meta } = await catalog.listIssuers(parse(listIssuersQuery, req.query));
  sendPage(res, items, meta);
});

adminRouter.get('/issuers/:id', can('content.read'), async (req, res) => {
  const { id } = parse(idParams, req.params);
  sendData(res, await catalog.getIssuer(id));
});

adminRouter.post('/issuers', can('content.manage'), async (req, res) => {
  const body = parse(createIssuerBody, req.body);
  sendData(res, await catalog.createIssuer(getAuth(req), body, clientContext(req)), 201);
});

adminRouter.patch('/issuers/:id', can('content.manage'), async (req, res) => {
  const { id } = parse(idParams, req.params);
  const body = parse(updateIssuerBody, req.body);
  sendData(res, await catalog.updateIssuer(getAuth(req), id, body, clientContext(req)));
});

adminRouter.delete('/issuers/:id', can('content.manage'), async (req, res) => {
  const { id } = parse(idParams, req.params);
  await catalog.deleteIssuer(getAuth(req), id, clientContext(req));
  res.status(204).end();
});

// ---------------------------------------------------------------------------------------------
// Representations (petitions)
//   CRUD /admin/representations                     DELETE is a soft delete
//   POST /admin/representations/:id/status          advance the track, with note and documents
//   POST /admin/representations/:id/documents       attach evidence and other documents
//   GET  /admin/representations/:id/signatures      signers with their identity
//   POST /admin/representations/:id/signatures/:signatureId/remove   { reason }
// ---------------------------------------------------------------------------------------------

adminRouter.get('/representations', can('content.read'), async (req, res) => {
  const { items, meta } = await representations.listRepresentations(
    parse(listRepresentationsQuery, req.query),
  );
  sendPage(res, items, meta);
});

adminRouter.get('/representations/:id', can('content.read'), async (req, res) => {
  const { id } = parse(idParams, req.params);
  sendData(res, await representations.getRepresentation(id));
});

adminRouter.post('/representations', can('content.manage'), async (req, res) => {
  const body = parse(createRepresentationBody, req.body);
  sendData(
    res,
    await representations.createRepresentation(getAuth(req), body, clientContext(req)),
    201,
  );
});

adminRouter.patch('/representations/:id', can('content.manage'), async (req, res) => {
  const { id } = parse(idParams, req.params);
  const body = parse(updateRepresentationBody, req.body);
  sendData(
    res,
    await representations.updateRepresentation(getAuth(req), id, body, clientContext(req)),
  );
});

adminRouter.delete('/representations/:id', can('content.manage'), async (req, res) => {
  const { id } = parse(idParams, req.params);
  await representations.deleteRepresentation(getAuth(req), id, clientContext(req));
  res.status(204).end();
});

adminRouter.post('/representations/:id/status', can('representations.track'), async (req, res) => {
  const { id } = parse(idParams, req.params);
  const body = parse(representationStatusBody, req.body);
  sendData(
    res,
    await representations.changeRepresentationStatus(getAuth(req), id, body, clientContext(req)),
  );
});

adminRouter.post(
  '/representations/:id/documents',
  can('representations.track'),
  async (req, res) => {
    const { id } = parse(idParams, req.params);
    const { documents } = parse(representationDocumentsBody, req.body);
    const created = await representations.addRepresentationDocuments(
      getAuth(req),
      id,
      documents,
      clientContext(req),
    );
    sendData(res, created, 201);
  },
);

adminRouter.get(
  '/representations/:id/signatures',
  can('representations.track'),
  async (req, res) => {
    const { id } = parse(idParams, req.params);
    const { items, meta } = await representations.listSignatures(
      id,
      parse(signaturesQuery, req.query),
    );
    sendPage(res, items, meta);
  },
);

adminRouter.post(
  '/representations/:id/signatures/:signatureId/remove',
  can('representations.track'),
  async (req, res) => {
    const { id, signatureId } = parse(signatureParams, req.params);
    const { reason } = parse(z.strictObject({ reason: reasonSchema }), req.body);
    await representations.removeSignature(
      getAuth(req),
      id,
      signatureId,
      reason,
      clientContext(req),
    );
    res.status(204).end();
  },
);

// ---------------------------------------------------------------------------------------------
// Roadshows
//   CRUD   /admin/roadshows                           DELETE archives
//   PUT    /admin/roadshows/:id/financials            replace the fiscal years
//   POST   /admin/roadshows/:id/documents             attach a DD document
//   DELETE /admin/roadshows/:id/documents/:docId
//   POST   /admin/roadshows/:id/questions/:qid/answer publish the issuer's answer
// ---------------------------------------------------------------------------------------------

adminRouter.get('/roadshows', can('content.read'), async (req, res) => {
  const { items, meta } = await roadshows.listRoadshows(parse(listAdminRoadshowsQuery, req.query));
  sendPage(res, items, meta);
});

adminRouter.get('/roadshows/:id', can('content.read'), async (req, res) => {
  const { id } = parse(idParams, req.params);
  sendData(res, await roadshows.getRoadshow(id));
});

adminRouter.post('/roadshows', can('content.manage'), async (req, res) => {
  const body = parse(createRoadshowBody, req.body);
  sendData(res, await roadshows.createRoadshow(getAuth(req), body, clientContext(req)), 201);
});

adminRouter.patch('/roadshows/:id', can('content.manage'), async (req, res) => {
  const { id } = parse(idParams, req.params);
  const body = parse(updateRoadshowBody, req.body);
  sendData(res, await roadshows.updateRoadshow(getAuth(req), id, body, clientContext(req)));
});

adminRouter.delete('/roadshows/:id', can('content.manage'), async (req, res) => {
  const { id } = parse(idParams, req.params);
  await roadshows.archiveRoadshow(getAuth(req), id, clientContext(req));
  res.status(204).end();
});

adminRouter.put('/roadshows/:id/financials', can('content.manage'), async (req, res) => {
  const { id } = parse(idParams, req.params);
  const { years } = parse(financialsBody, req.body);
  sendData(res, await roadshows.replaceFinancials(getAuth(req), id, years, clientContext(req)));
});

adminRouter.post('/roadshows/:id/documents', can('content.manage'), async (req, res) => {
  const { id } = parse(idParams, req.params);
  const body = parse(roadshowDocumentBody, req.body);
  sendData(
    res,
    await roadshows.addRoadshowDocument(getAuth(req), id, body, clientContext(req)),
    201,
  );
});

adminRouter.delete('/roadshows/:id/documents/:docId', can('content.manage'), async (req, res) => {
  const { id, docId } = parse(roadshowDocumentParams, req.params);
  await roadshows.removeRoadshowDocument(getAuth(req), id, docId, clientContext(req));
  res.status(204).end();
});

adminRouter.post(
  '/roadshows/:id/questions/:qid/answer',
  can('questions.answer'),
  async (req, res) => {
    const { id, qid } = parse(questionParams, req.params);
    const body = parse(answerQuestionBody, req.body);
    sendData(res, await roadshows.answerQuestion(getAuth(req), id, qid, body, clientContext(req)));
  },
);

// ---------------------------------------------------------------------------------------------
// Learn (CRUD; DELETE archives)
// ---------------------------------------------------------------------------------------------

adminRouter.get('/learn', can('content.read'), async (req, res) => {
  const { items, meta } = await learn.listLearnItems(parse(listAdminLearnQuery, req.query));
  sendPage(res, items, meta);
});

adminRouter.get('/learn/:id', can('content.read'), async (req, res) => {
  const { id } = parse(idParams, req.params);
  sendData(res, await learn.getLearnItem(id));
});

adminRouter.post('/learn', can('content.manage'), async (req, res) => {
  const body = parse(createLearnBody, req.body);
  sendData(res, await learn.createLearnItem(getAuth(req), body, clientContext(req)), 201);
});

adminRouter.patch('/learn/:id', can('content.manage'), async (req, res) => {
  const { id } = parse(idParams, req.params);
  const body = parse(updateLearnBody, req.body);
  sendData(res, await learn.updateLearnItem(getAuth(req), id, body, clientContext(req)));
});

adminRouter.delete('/learn/:id', can('content.manage'), async (req, res) => {
  const { id } = parse(idParams, req.params);
  await learn.archiveLearnItem(getAuth(req), id, clientContext(req));
  res.status(204).end();
});

// ---------------------------------------------------------------------------------------------
// Credits, audit trail and staff uploads
//   POST /admin/credits/grant   { userId, delta, note }; negative delta revokes. Idempotency-Key.
//   GET  /admin/audit-logs      filter[action], [actionPrefix], [actorId], [from], [to]
//   POST /admin/uploads         { target, mimeType, sizeBytes } -> signed upload URL + path
// ---------------------------------------------------------------------------------------------

adminRouter.post('/credits/grant', can('credits.manage'), async (req, res) => {
  const key = readIdempotencyKey(req);
  const body = parse(creditChangeBody, req.body);
  const { entry, replayed } = await changeCredits(getAuth(req), body, key, clientContext(req));
  if (replayed) res.set(REPLAYED_HEADER, 'true');
  sendData(res, entry, 201);
});

adminRouter.get('/audit-logs', can('audit.read'), async (req, res) => {
  const { items, meta } = await listAuditLogs(parse(auditLogsQuery, req.query));
  sendPage(res, items, meta);
});

adminRouter.post('/uploads', async (req, res) => {
  const body = parse(uploadUrlBody, req.body);
  assertPermission(req, UPLOAD_TARGET_CONFIG[body.target].permission);
  sendData(res, await createStaffUploadUrl(getAuth(req), body, clientContext(req)), 201);
});
