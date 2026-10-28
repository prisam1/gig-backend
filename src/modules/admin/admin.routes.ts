// Admin (Phase 1): the API behind GIG's admin console. Every route needs a signed-in member who is
// GIG staff; each one also names the permission it needs (see admin.access.ts).
import { Router } from 'express';
import { sendData, sendPage } from '../../lib/http';
import { readIdempotencyKey, REPLAYED_HEADER } from '../../lib/idempotency';
import { getAuth, requireAuth } from '../../middleware/auth';
import { clientContext } from '../../middleware/requestContext';
import { parse } from '../../middleware/validate';
import { allow, permissionsOf, requireStaff, staffRoles } from './admin.access';
import {
  addDocumentsBody,
  answerQuestionBody,
  approveKycBody,
  auditLogsQuery,
  createCompanyBody,
  createIssuerBody,
  createLearnBody,
  createRepresentationBody,
  createRoadshowBody,
  documentUploadUrlBody,
  grantCreditsBody,
  idParams,
  listCompaniesQuery,
  listIssuersAdminQuery,
  listKycQuery,
  listLearnAdminQuery,
  listQuestionsQuery,
  listRepresentationsAdminQuery,
  listRoadshowsAdminQuery,
  listUsersQuery,
  moderationDecisionBody,
  moderationItemQuery,
  moderationQueueQuery,
  pageQuery,
  questionParams,
  rejectKycBody,
  representationStatusBody,
  setRolesBody,
  updateCompanyBody,
  updateIssuerBody,
  updateLearnBody,
  updateRepresentationBody,
  updateRoadshowBody,
  updateUserBody,
} from './admin.schemas';
import {
  adminAudit,
  adminCompanies,
  adminCredits,
  adminIssuers,
  adminKyc,
  adminLearn,
  adminModeration,
  adminRepresentations,
  adminRoadshows,
  adminUsers,
} from './admin.service';

export const adminRouter = Router();

adminRouter.use(requireAuth, requireStaff);

// GET /admin/me — the signed-in staff member's roles and permissions, for the console's menus.
adminRouter.get('/me', (req, res) => {
  const roles = staffRoles(req);
  sendData(res, { id: getAuth(req).userPublicId, roles, permissions: permissionsOf(roles) });
});

// ---------------------------------------------------------------------------------------------
// Users
//   GET   /admin/users                 search by email, phone, ID or name; filter by tier, KYC, status, role
//   GET   /admin/users/:id             account, KYC, activity; contact details for ADMIN / SUPPORT
//   PATCH /admin/users/:id             change tier, suspend or reactivate (with a reason)
//   PUT   /admin/users/:id/roles       set staff roles
//   GET   /admin/users/:id/credits     credit balance and ledger
// ---------------------------------------------------------------------------------------------

adminRouter.get('/users', allow('users.read'), async (req, res) => {
  const { items, meta } = await adminUsers.list(parse(listUsersQuery, req.query));
  sendPage(res, items, meta);
});

adminRouter.get('/users/:id', allow('users.read'), async (req, res) => {
  const { id } = parse(idParams, req.params);
  sendData(res, await adminUsers.get(getAuth(req), staffRoles(req), id, clientContext(req)));
});

adminRouter.patch('/users/:id', allow('users.write'), async (req, res) => {
  const { id } = parse(idParams, req.params);
  const input = parse(updateUserBody, req.body);
  sendData(res, await adminUsers.update(getAuth(req), id, input, clientContext(req)));
});

adminRouter.put('/users/:id/roles', allow('roles.write'), async (req, res) => {
  const { id } = parse(idParams, req.params);
  const { roles } = parse(setRolesBody, req.body);
  sendData(res, await adminUsers.setRoles(getAuth(req), id, roles, clientContext(req)));
});

adminRouter.get('/users/:id/credits', allow('users.read'), async (req, res) => {
  const { id } = parse(idParams, req.params);
  const { balance, items, meta } = await adminUsers.credits(id, parse(pageQuery, req.query));
  res.json({ data: items, meta: { ...meta, balance } });
});

// ---------------------------------------------------------------------------------------------
// KYC
//   GET   /admin/kyc                   queue: pending first, oldest first
//   GET   /admin/kyc/:id               submission with 5-minute document links (audited)
//   POST  /admin/kyc/:id/approve       grants the submitted tier
//   POST  /admin/kyc/:id/reject        records the reason the user sees
// ---------------------------------------------------------------------------------------------

adminRouter.get('/kyc', allow('kyc.read'), async (req, res) => {
  const { items, meta } = await adminKyc.list(parse(listKycQuery, req.query));
  sendPage(res, items, meta);
});

adminRouter.get('/kyc/:id', allow('kyc.read'), async (req, res) => {
  const { id } = parse(idParams, req.params);
  sendData(res, await adminKyc.get(getAuth(req), id, clientContext(req)));
});

adminRouter.post('/kyc/:id/approve', allow('kyc.decide'), async (req, res) => {
  const { id } = parse(idParams, req.params);
  parse(approveKycBody, req.body);
  sendData(res, await adminKyc.approve(getAuth(req), id, clientContext(req)));
});

adminRouter.post('/kyc/:id/reject', allow('kyc.decide'), async (req, res) => {
  const { id } = parse(idParams, req.params);
  const { reason } = parse(rejectKycBody, req.body);
  sendData(res, await adminKyc.reject(getAuth(req), id, reason, clientContext(req)));
});

// ---------------------------------------------------------------------------------------------
// Moderation (reviews, ratings and roadshow questions)
//   GET   /admin/moderation/queue           oldest first; filter[type], filter[status]
//   GET   /admin/moderation/:id?type=       the full item, with evidence links
//   POST  /admin/moderation/:id/decision    APPROVE, REQUEST_CHANGES, REJECT or REMOVE
// ---------------------------------------------------------------------------------------------

adminRouter.get('/moderation/queue', allow('moderation'), async (req, res) => {
  const { items, meta } = await adminModeration.queue(parse(moderationQueueQuery, req.query));
  sendPage(res, items, meta);
});

adminRouter.get('/moderation/:id', allow('moderation'), async (req, res) => {
  const { id } = parse(idParams, req.params);
  const { type } = parse(moderationItemQuery, req.query);
  sendData(res, await adminModeration.get(type, id));
});

adminRouter.post('/moderation/:id/decision', allow('moderation'), async (req, res) => {
  const { id } = parse(idParams, req.params);
  const input = parse(moderationDecisionBody, req.body);
  sendData(res, await adminModeration.decide(getAuth(req), id, input, clientContext(req)));
});

// ---------------------------------------------------------------------------------------------
// Content: companies, issuers, representations
//   GET / POST           /admin/<resource>        list (filter[deleted]=true includes deleted) / create
//   GET / PATCH / DELETE /admin/<resource>/:id    read / partial update / soft delete
//   POST /admin/representations/:id/status                advance the track, with documents
//   POST /admin/representations/:id/documents             attach evidence or other documents
//   POST /admin/representations/:id/documents/upload-url  signed URL to upload one document
// ---------------------------------------------------------------------------------------------

adminRouter.get('/companies', allow('content.read'), async (req, res) => {
  const { items, meta } = await adminCompanies.list(parse(listCompaniesQuery, req.query));
  sendPage(res, items, meta);
});

adminRouter.get('/companies/:id', allow('content.read'), async (req, res) => {
  const { id } = parse(idParams, req.params);
  sendData(res, await adminCompanies.get(id));
});

adminRouter.post('/companies', allow('content.write'), async (req, res) => {
  const input = parse(createCompanyBody, req.body);
  sendData(res, await adminCompanies.save(getAuth(req), null, input, clientContext(req)), 201);
});

adminRouter.patch('/companies/:id', allow('content.write'), async (req, res) => {
  const { id } = parse(idParams, req.params);
  const input = parse(updateCompanyBody, req.body);
  sendData(res, await adminCompanies.save(getAuth(req), id, input, clientContext(req)));
});

adminRouter.delete('/companies/:id', allow('content.write'), async (req, res) => {
  const { id } = parse(idParams, req.params);
  await adminCompanies.remove(getAuth(req), id, clientContext(req));
  res.status(204).end();
});

adminRouter.get('/issuers', allow('content.read'), async (req, res) => {
  const { items, meta } = await adminIssuers.list(parse(listIssuersAdminQuery, req.query));
  sendPage(res, items, meta);
});

adminRouter.get('/issuers/:id', allow('content.read'), async (req, res) => {
  const { id } = parse(idParams, req.params);
  sendData(res, await adminIssuers.get(id));
});

adminRouter.post('/issuers', allow('content.write'), async (req, res) => {
  const input = parse(createIssuerBody, req.body);
  sendData(res, await adminIssuers.save(getAuth(req), null, input, clientContext(req)), 201);
});

adminRouter.patch('/issuers/:id', allow('content.write'), async (req, res) => {
  const { id } = parse(idParams, req.params);
  const input = parse(updateIssuerBody, req.body);
  sendData(res, await adminIssuers.save(getAuth(req), id, input, clientContext(req)));
});

adminRouter.delete('/issuers/:id', allow('content.write'), async (req, res) => {
  const { id } = parse(idParams, req.params);
  await adminIssuers.remove(getAuth(req), id, clientContext(req));
  res.status(204).end();
});

adminRouter.get('/representations', allow('content.read'), async (req, res) => {
  const { items, meta } = await adminRepresentations.list(
    parse(listRepresentationsAdminQuery, req.query),
  );
  sendPage(res, items, meta);
});

adminRouter.get('/representations/:id', allow('content.read'), async (req, res) => {
  const { id } = parse(idParams, req.params);
  sendData(res, await adminRepresentations.get(id));
});

adminRouter.post('/representations', allow('content.write'), async (req, res) => {
  const input = parse(createRepresentationBody, req.body);
  sendData(
    res,
    await adminRepresentations.save(getAuth(req), null, input, clientContext(req)),
    201,
  );
});

adminRouter.patch('/representations/:id', allow('content.write'), async (req, res) => {
  const { id } = parse(idParams, req.params);
  const input = parse(updateRepresentationBody, req.body);
  sendData(res, await adminRepresentations.save(getAuth(req), id, input, clientContext(req)));
});

adminRouter.delete('/representations/:id', allow('content.write'), async (req, res) => {
  const { id } = parse(idParams, req.params);
  await adminRepresentations.remove(getAuth(req), id, clientContext(req));
  res.status(204).end();
});

adminRouter.post('/representations/:id/status', allow('content.write'), async (req, res) => {
  const { id } = parse(idParams, req.params);
  const input = parse(representationStatusBody, req.body);
  sendData(
    res,
    await adminRepresentations.changeStatus(getAuth(req), id, input, clientContext(req)),
  );
});

adminRouter.post(
  '/representations/:id/documents/upload-url',
  allow('content.write'),
  async (req, res) => {
    const { id } = parse(idParams, req.params);
    const input = parse(documentUploadUrlBody, req.body);
    sendData(res, await adminRepresentations.createDocumentUploadUrl(id, input), 201);
  },
);

adminRouter.post('/representations/:id/documents', allow('content.write'), async (req, res) => {
  const { id } = parse(idParams, req.params);
  const { documents } = parse(addDocumentsBody, req.body);
  sendData(
    res,
    await adminRepresentations.addDocuments(getAuth(req), id, documents, clientContext(req)),
    201,
  );
});

// ---------------------------------------------------------------------------------------------
// Content: roadshows and learn
//   GET / POST           /admin/roadshows, /admin/learn        list / create
//   GET / PATCH / DELETE /admin/roadshows/:id, /admin/learn/:id read / partial update / soft delete
//   GET   /admin/roadshows/:id/questions                     Ask Me Anything questions
//   POST  /admin/roadshows/:id/questions/:questionId/answer  publish the issuer's answer
// ---------------------------------------------------------------------------------------------

adminRouter.get('/roadshows', allow('content.read'), async (req, res) => {
  const { items, meta } = await adminRoadshows.list(parse(listRoadshowsAdminQuery, req.query));
  sendPage(res, items, meta);
});

adminRouter.get('/roadshows/:id', allow('content.read'), async (req, res) => {
  const { id } = parse(idParams, req.params);
  sendData(res, await adminRoadshows.get(id));
});

adminRouter.post('/roadshows', allow('content.write'), async (req, res) => {
  const input = parse(createRoadshowBody, req.body);
  sendData(res, await adminRoadshows.save(getAuth(req), null, input, clientContext(req)), 201);
});

adminRouter.patch('/roadshows/:id', allow('content.write'), async (req, res) => {
  const { id } = parse(idParams, req.params);
  const input = parse(updateRoadshowBody, req.body);
  sendData(res, await adminRoadshows.save(getAuth(req), id, input, clientContext(req)));
});

adminRouter.delete('/roadshows/:id', allow('content.write'), async (req, res) => {
  const { id } = parse(idParams, req.params);
  await adminRoadshows.archive(getAuth(req), id, clientContext(req));
  res.status(204).end();
});

adminRouter.get('/roadshows/:id/questions', allow('moderation'), async (req, res) => {
  const { id } = parse(idParams, req.params);
  const { items, meta } = await adminRoadshows.questions(id, parse(listQuestionsQuery, req.query));
  sendPage(res, items, meta);
});

adminRouter.post(
  '/roadshows/:id/questions/:questionId/answer',
  allow('moderation'),
  async (req, res) => {
    const { id, questionId } = parse(questionParams, req.params);
    const input = parse(answerQuestionBody, req.body);
    sendData(
      res,
      await adminRoadshows.answer(getAuth(req), id, questionId, input, clientContext(req)),
    );
  },
);

adminRouter.get('/learn', allow('content.read'), async (req, res) => {
  const { items, meta } = await adminLearn.list(parse(listLearnAdminQuery, req.query));
  sendPage(res, items, meta);
});

adminRouter.get('/learn/:id', allow('content.read'), async (req, res) => {
  const { id } = parse(idParams, req.params);
  sendData(res, await adminLearn.get(id));
});

adminRouter.post('/learn', allow('content.write'), async (req, res) => {
  const input = parse(createLearnBody, req.body);
  sendData(res, await adminLearn.save(getAuth(req), null, input, clientContext(req)), 201);
});

adminRouter.patch('/learn/:id', allow('content.write'), async (req, res) => {
  const { id } = parse(idParams, req.params);
  const input = parse(updateLearnBody, req.body);
  sendData(res, await adminLearn.save(getAuth(req), id, input, clientContext(req)));
});

adminRouter.delete('/learn/:id', allow('content.write'), async (req, res) => {
  const { id } = parse(idParams, req.params);
  await adminLearn.archive(getAuth(req), id, clientContext(req));
  res.status(204).end();
});

// ---------------------------------------------------------------------------------------------
// Credits and audit trail
//   POST  /admin/credits/grant    grant (delta > 0) or revoke (delta < 0); needs Idempotency-Key
//   GET   /admin/audit-logs       newest first; filter[action], filter[user], filter[from], filter[to]
// ---------------------------------------------------------------------------------------------

adminRouter.post('/credits/grant', allow('credits.grant'), async (req, res) => {
  const idempotencyKey = readIdempotencyKey(req);
  const input = parse(grantCreditsBody, req.body);
  const { result, replayed } = await adminCredits.grant(
    getAuth(req),
    input,
    idempotencyKey,
    clientContext(req),
  );
  if (replayed) res.set(REPLAYED_HEADER, 'true');
  sendData(res, result, replayed ? 200 : 201);
});

adminRouter.get('/audit-logs', allow('audit.read'), async (req, res) => {
  const { items, meta } = await adminAudit.list(parse(auditLogsQuery, req.query));
  sendPage(res, items, meta);
});
