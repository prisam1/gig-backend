import { z } from 'zod';
import * as admin from '../modules/admin/admin.schemas';
import * as content from '../modules/admin/content.schemas';
import * as auth from '../modules/auth/auth.schemas';
import * as catalog from '../modules/catalog/catalog.schemas';
import { statementQuery } from '../modules/credits/credits.routes';
import * as files from '../modules/files/files.schemas';
import * as kyc from '../modules/kyc/kyc.schemas';
import * as learn from '../modules/learn/learn.schemas';
import * as notifications from '../modules/notifications/notifications.schemas';
import * as ratings from '../modules/ratings/ratings.schemas';
import * as representations from '../modules/representations/representations.schemas';
import * as reviews from '../modules/reviews/reviews.schemas';
import * as roadshows from '../modules/roadshows/roadshows.schemas';
import * as saved from '../modules/saved/saved.schemas';
import { topRatedQuery } from '../modules/topRated/topRated.routes';
import { typeSchema as lookupType } from '../modules/users/lookups.routes';
import * as users from '../modules/users/users.schemas';
import * as webinars from '../modules/webinars/webinars.schemas';

/**
 * Who may call a route, as enforced by its middleware:
 *   public   no token; optional  token adds personalised fields; user  any signed-in tier;
 *   prive    Prive with approved KYC; full  verified Prive or Institutional;
 *   inst     Institutional with approved KYC; staff  GIG staff with `permission`.
 */
export type Access = 'public' | 'optional' | 'user' | 'prive' | 'full' | 'inst' | 'staff';

export type Method = 'get' | 'post' | 'put' | 'patch' | 'delete';

export interface RouteDoc {
  method: Method;
  /** Express path under /api/v1, e.g. `/companies/:id`. */
  path: string;
  tag: string;
  summary: string;
  access: Access;
  permission?: string;
  params?: z.ZodType;
  query?: z.ZodType;
  body?: z.ZodType;
  /** Success status; 200 when omitted. */
  status?: 200 | 201 | 202 | 204;
  /** `{ data, meta }` list response instead of `{ data }`. */
  page?: boolean;
  idempotent?: boolean;
  /** Prefilled request body in Swagger UI; must pass `body`. */
  example?: unknown;
  /** Extra text shown under the access note. */
  description?: string;
}

const r = (
  method: Method,
  path: string,
  tag: string,
  summary: string,
  access: Access,
  extra: Partial<RouteDoc> = {},
): RouteDoc => ({ method, path, tag, summary, access, ...extra });

const staff = (
  method: Method,
  path: string,
  summary: string,
  permission: string | undefined,
  extra: Partial<RouteDoc> = {},
) =>
  r(method, `/admin${path}`, 'Admin', summary, 'staff', {
    ...(permission && { permission }),
    ...extra,
  });

const id = admin.idParams;

// Sample sign-up details for Swagger's "Try it out"; test/api/docs.api.test.ts checks every
// `example` passes its body schema.
const EMAIL = 'asha.investor@example.com';
const PASSWORD = 'Investor@2026';
const device = { name: 'Swagger UI', platform: 'WEB' };

/** Every route the API serves. `test/api/docs.api.test.ts` fails when this drifts from the routers. */
export const routeDocs: RouteDoc[] = [
  // Health
  r('get', '/health', 'Health', 'Process status and uptime', 'public'),
  r('get', '/health/live', 'Health', 'Liveness probe', 'public'),
  r('get', '/health/ready', 'Health', 'Readiness probe (database reachable)', 'public'),

  // Auth
  r(
    'post',
    '/auth/register',
    'Auth',
    'Start sign-up (account is created after both OTPs verify)',
    'public',
    {
      description:
        'Returns an EMAIL and a PHONE challenge. Verify both with POST /auth/otp/verify (codes are printed in the server log in dev); the second verify returns the tokens.',
      body: auth.registerSchema,
      status: 202,
      example: {
        name: 'Asha Mehta',
        email: EMAIL,
        countryCode: '+91',
        phone: '9876543210',
        password: PASSWORD,
        ageConfirmed: true,
      },
    },
  ),
  r('post', '/auth/otp/send', 'Auth', 'Send a one-time code', 'public', {
    body: auth.otpSendSchema,
    status: 202,
    example: { purpose: 'LOGIN', identifier: EMAIL },
  }),
  r('post', '/auth/otp/verify', 'Auth', 'Verify a one-time code', 'public', {
    description:
      'Sign-up: PENDING until both challenges are verified, then COMPLETED with user and tokens. Password reset: returns resetToken.',
    body: auth.otpVerifySchema,
  }),
  r('post', '/auth/login', 'Auth', 'Sign in; returns access and refresh tokens', 'public', {
    body: auth.loginSchema,
    example: { identifier: EMAIL, password: PASSWORD, device },
  }),
  r('post', '/auth/refresh', 'Auth', 'Rotate the refresh token', 'public', {
    body: auth.refreshSchema,
  }),
  r('post', '/auth/logout', 'Auth', 'Sign out of this session', 'user', { status: 204 }),
  r('post', '/auth/password/forgot', 'Auth', 'Start a password reset', 'public', {
    body: auth.forgotPasswordSchema,
    status: 202,
    example: { identifier: EMAIL },
  }),
  r('post', '/auth/password/reset', 'Auth', 'Reset the password with a code', 'public', {
    body: auth.resetPasswordSchema,
    example: { resetToken: '<resetToken from /auth/otp/verify>', newPassword: PASSWORD },
  }),
  r('get', '/auth/sessions', 'Auth', 'List my active sessions', 'user'),
  r('delete', '/auth/sessions', 'Auth', 'Sign out of every other session', 'user', { status: 204 }),
  r('delete', '/auth/sessions/:id', 'Auth', 'Revoke one session', 'user', {
    params: z.object({ id: auth.sessionIdSchema }),
    status: 204,
  }),

  // Me
  r('get', '/me/saved', 'Me', 'My saved items', 'user', {
    query: saved.listSavedQuery,
    page: true,
  }),
  r('post', '/me/saved', 'Me', 'Save an item', 'user', { body: saved.savedItemRef, status: 201 }),
  r('delete', '/me/saved/:type/:id', 'Me', 'Remove a saved item', 'user', {
    params: saved.savedItemRef,
    status: 204,
  }),
  r('get', '/me/credits', 'Me', 'Credit balance and ledger', 'user', {
    query: statementQuery,
    page: true,
  }),
  r('get', '/me/notifications', 'Me', 'Notification inbox (meta.unread = badge)', 'user', {
    query: notifications.listNotificationsQuery,
    page: true,
  }),
  r('post', '/me/notifications/read', 'Me', 'Mark notifications read', 'user', {
    body: notifications.markReadBody,
  }),
  r('post', '/me/devices', 'Me', 'Register a push token', 'user', {
    body: notifications.registerDeviceBody,
    status: 201,
  }),
  r('get', '/me', 'Me', 'My profile', 'user'),
  r('patch', '/me', 'Me', 'Update my profile', 'user', {
    body: users.updateMeSchema,
    example: { name: 'Asha Mehta', experienceYears: 5, location: 'Mumbai, India' },
  }),
  r('put', '/me/preferences', 'Me', 'Replace my preferences', 'user', {
    body: users.preferencesSchema,
    example: {
      focus: ['FINANCIAL_ASSETS'],
      risk: ['MEDIUM_LEVEL'],
      style: ['VALUE_INVESTING', 'DIVIDEND_INVESTING'],
      sector: ['TECHNOLOGY', 'FINTECH', 'HEALTHCARE'],
    },
  }),
  r('put', '/me/tier', 'Me', 'Choose my membership tier', 'user', {
    body: users.tierSchema,
    example: { tier: 'PRIVE' },
  }),

  // Users, files, KYC, lookups
  r('get', '/users/:id', 'Users', 'Public profile of a user', 'user', {
    params: users.userIdParamSchema,
  }),
  r('post', '/users/:id/follow', 'Users', 'Follow a user', 'user', {
    params: users.userIdParamSchema,
    status: 204,
  }),
  r('delete', '/users/:id/follow', 'Users', 'Unfollow a user', 'user', {
    params: users.userIdParamSchema,
    status: 204,
  }),
  r('post', '/files/upload-url', 'Files', 'Signed upload URL', 'user', {
    body: files.createUploadUrlSchema,
    status: 201,
  }),
  r('post', '/kyc/submissions', 'KYC', 'Submit KYC documents', 'user', {
    body: kyc.submitKycSchema,
    status: 201,
  }),
  r('get', '/kyc/submissions/me', 'KYC', 'My latest KYC submission', 'user'),
  r('get', '/lookups/:type', 'Lookups', 'Option list (countries, sectors, ...)', 'public', {
    params: z.object({ type: lookupType }),
  }),

  // Catalog and reviews
  r('get', '/companies', 'Companies', 'List companies', 'public', {
    query: catalog.listCompaniesQuery,
    page: true,
  }),
  r('get', '/companies/compare', 'Companies', 'Compare companies side by side', 'user', {
    query: catalog.compareQuery,
  }),
  r('get', '/companies/:id', 'Companies', 'Company header, sentiment and scorecard', 'optional', {
    params: catalog.companyIdParams,
  }),
  r('get', '/companies/:id/trends', 'Companies', '12M / 24M / ALL trends', 'full', {
    params: catalog.companyIdParams,
    query: catalog.trendsQuery,
  }),
  r('get', '/companies/:id/reviews', 'Companies', 'Published reviews', 'optional', {
    params: catalog.companyIdParams,
    query: reviews.listCompanyReviewsQuery,
    page: true,
  }),
  r('post', '/reviews', 'Reviews', 'Submit the 6-step review', 'prive', {
    body: reviews.submitReviewBody,
    status: 201,
    idempotent: true,
  }),
  r('get', '/reviews/me', 'Reviews', 'My reviews', 'user', {
    query: reviews.listMyReviewsQuery,
    page: true,
  }),
  r('get', '/reviews/:id', 'Reviews', 'Review receipt', 'user', { params: reviews.reviewIdParams }),
  r('patch', '/reviews/:id/resolution', 'Reviews', 'Update resolution status', 'prive', {
    params: reviews.reviewIdParams,
    body: reviews.updateResolutionBody,
  }),

  // Ratings
  r('get', '/issuers', 'Issuers', 'List issuers', 'public', {
    query: ratings.listIssuersQuery,
    page: true,
  }),
  r('get', '/issuers/:id', 'Issuers', 'Issuer offer details', 'public', {
    params: ratings.issuerIdParams,
  }),
  r('get', '/issuers/:id/rating-summary', 'Issuers', 'Aggregate rating', 'optional', {
    params: ratings.issuerIdParams,
  }),
  r('post', '/issuers/:id/ratings', 'Issuers', 'Rate an issuer', 'prive', {
    params: ratings.issuerIdParams,
    body: ratings.submitRatingBody,
    status: 201,
    idempotent: true,
  }),
  r('get', '/ratings/me', 'Issuers', 'My ratings', 'user', {
    query: ratings.listMyRatingsQuery,
    page: true,
  }),

  // Representations
  r('get', '/representations', 'Representations', 'List petitions', 'public', {
    query: representations.listRepresentationsQuery,
    page: true,
  }),
  r('get', '/representations/:id', 'Representations', 'Petition overview', 'optional', {
    params: representations.representationIdParams,
  }),
  r('get', '/representations/:id/timeline', 'Representations', 'Track status history', 'public', {
    params: representations.representationIdParams,
  }),
  r(
    'get',
    '/representations/:id/submission',
    'Representations',
    'Download the submitted pack',
    'full',
    { params: representations.representationIdParams },
  ),
  r('post', '/representations/:id/signatures', 'Representations', 'Sign a petition', 'prive', {
    params: representations.representationIdParams,
    body: representations.signRepresentationBody,
    status: 201,
    idempotent: true,
  }),

  // Learn, webinars, top rated
  r('get', '/learn', 'Learn', 'Learn content', 'optional', {
    query: learn.listLearnQuery,
    page: true,
  }),
  r('get', '/learn/:id', 'Learn', 'One learn item', 'optional', { params: learn.learnIdParams }),
  r('post', '/learn/:id/rating', 'Learn', 'Rate a learn item 1-5', 'user', {
    params: learn.learnIdParams,
    body: learn.rateLearnBody,
  }),
  r('get', '/webinars', 'Learn', 'Upcoming or past webinars', 'user', {
    query: webinars.listWebinarsQuery,
    page: true,
  }),
  r('post', '/webinars/:id/register', 'Learn', 'Register for a webinar', 'user', {
    params: webinars.webinarIdParams,
    status: 201,
  }),
  r('get', '/top-rated', 'Companies', 'Leaderboards (company or issuer)', 'public', {
    query: topRatedQuery,
    page: true,
  }),

  // Roadshows
  r('get', '/roadshows', 'Roadshows', 'List roadshows', 'public', {
    query: roadshows.listRoadshowsQuery,
    page: true,
  }),
  r('get', '/roadshows/:id', 'Roadshows', 'Issue summary, terms, documents', 'optional', {
    params: roadshows.roadshowIdParams,
  }),
  r('get', '/roadshows/:id/financials', 'Roadshows', '3-year financials', 'user', {
    params: roadshows.roadshowIdParams,
    query: roadshows.financialsQuery,
  }),
  r(
    'get',
    '/roadshows/:id/documents/:docId',
    'Roadshows',
    '5-minute document download URL',
    'full',
    { params: roadshows.documentParams },
  ),
  r('get', '/roadshows/:id/questions', 'Roadshows', 'Ask Me Anything questions', 'user', {
    params: roadshows.roadshowIdParams,
    query: roadshows.listQuestionsQuery,
    page: true,
  }),
  r('post', '/roadshows/:id/questions', 'Roadshows', 'Ask a question', 'prive', {
    params: roadshows.roadshowIdParams,
    body: roadshows.askQuestionBody,
    status: 201,
  }),
  r('post', '/roadshows/:id/pool', 'Roadshows', 'Join the Power Pool (1 credit)', 'prive', {
    params: roadshows.roadshowIdParams,
    body: roadshows.joinPoolBody,
    status: 201,
    idempotent: true,
  }),
  r('get', '/roadshows/:id/pool-power', 'Roadshows', 'Pool participants and demand', 'user', {
    params: roadshows.roadshowIdParams,
  }),
  r('post', '/roadshows/:id/offers', 'Roadshows', 'Post an offer', 'inst', {
    params: roadshows.roadshowIdParams,
    body: roadshows.postOfferBody,
    status: 201,
  }),

  // Admin
  staff('get', '/me', 'My staff roles and permissions', undefined),
  staff('get', '/users', 'Search users', 'users.read', { query: admin.listUsersQuery, page: true }),
  staff('get', '/users/:id', 'One user', 'users.read', { params: id }),
  staff('patch', '/users/:id', 'Change tier or suspend', 'users.manage', {
    params: id,
    body: admin.updateUserBody,
  }),
  staff('put', '/users/:id/roles', 'Set staff roles', 'roles.manage', {
    params: id,
    body: admin.setRolesBody,
  }),
  staff('get', '/kyc', 'KYC queue', 'kyc.review', { query: admin.listKycQuery, page: true }),
  staff('get', '/kyc/:id', 'One KYC submission', 'kyc.review', { params: id }),
  staff('post', '/kyc/:id/approve', 'Approve KYC', 'kyc.review', {
    params: id,
    body: z.strictObject({}),
  }),
  staff('post', '/kyc/:id/reject', 'Reject KYC', 'kyc.review', {
    params: id,
    body: admin.rejectKycBody,
  }),
  staff('get', '/moderation/queue', 'Moderation queue', 'moderation.read', {
    query: admin.moderationQueueQuery,
    page: true,
  }),
  staff('get', '/moderation/:id', 'One moderation item', 'moderation.read', {
    params: id,
    query: admin.moderationItemQuery,
  }),
  staff('post', '/moderation/:id/decision', 'Decide a moderation item', 'moderation.decide', {
    params: id,
    body: admin.moderationDecisionBody,
  }),
  staff('get', '/companies', 'List companies', 'content.read', {
    query: content.listCompaniesQuery,
    page: true,
  }),
  staff('get', '/companies/:id', 'One company', 'content.read', { params: id }),
  staff('post', '/companies', 'Create a company', 'content.manage', {
    body: content.createCompanyBody,
    status: 201,
  }),
  staff('patch', '/companies/:id', 'Update a company', 'content.manage', {
    params: id,
    body: content.updateCompanyBody,
  }),
  staff('delete', '/companies/:id', 'Delete a company', 'content.manage', {
    params: id,
    status: 204,
  }),
  staff('get', '/issuers', 'List issuers', 'content.read', {
    query: content.listIssuersQuery,
    page: true,
  }),
  staff('get', '/issuers/:id', 'One issuer', 'content.read', { params: id }),
  staff('post', '/issuers', 'Create an issuer', 'content.manage', {
    body: content.createIssuerBody,
    status: 201,
  }),
  staff('patch', '/issuers/:id', 'Update an issuer', 'content.manage', {
    params: id,
    body: content.updateIssuerBody,
  }),
  staff('delete', '/issuers/:id', 'Delete an issuer', 'content.manage', {
    params: id,
    status: 204,
  }),
  staff('get', '/representations', 'List representations', 'content.read', {
    query: content.listRepresentationsQuery,
    page: true,
  }),
  staff('get', '/representations/:id', 'One representation', 'content.read', { params: id }),
  staff('post', '/representations', 'Create a representation', 'content.manage', {
    body: content.createRepresentationBody,
    status: 201,
  }),
  staff('patch', '/representations/:id', 'Update a representation', 'content.manage', {
    params: id,
    body: content.updateRepresentationBody,
  }),
  staff('delete', '/representations/:id', 'Soft-delete a representation', 'content.manage', {
    params: id,
    status: 204,
  }),
  staff(
    'post',
    '/representations/:id/status',
    'Advance the track status',
    'representations.track',
    { params: id, body: content.representationStatusBody },
  ),
  staff('post', '/representations/:id/documents', 'Attach documents', 'representations.track', {
    params: id,
    body: content.representationDocumentsBody,
    status: 201,
  }),
  staff(
    'get',
    '/representations/:id/signatures',
    'Signers with identity',
    'representations.track',
    { params: id, query: content.signaturesQuery, page: true },
  ),
  staff(
    'post',
    '/representations/:id/signatures/:signatureId/remove',
    'Remove a signature',
    'representations.track',
    {
      params: content.signatureParams,
      body: z.strictObject({ reason: admin.reasonSchema }),
      status: 204,
    },
  ),
  staff('get', '/roadshows', 'List roadshows', 'content.read', {
    query: content.listAdminRoadshowsQuery,
    page: true,
  }),
  staff('get', '/roadshows/:id', 'One roadshow', 'content.read', { params: id }),
  staff('post', '/roadshows', 'Create a roadshow', 'content.manage', {
    body: content.createRoadshowBody,
    status: 201,
  }),
  staff('patch', '/roadshows/:id', 'Update a roadshow', 'content.manage', {
    params: id,
    body: content.updateRoadshowBody,
  }),
  staff('delete', '/roadshows/:id', 'Archive a roadshow', 'content.manage', {
    params: id,
    status: 204,
  }),
  staff('put', '/roadshows/:id/financials', 'Replace fiscal years', 'content.manage', {
    params: id,
    body: content.financialsBody,
  }),
  staff('post', '/roadshows/:id/documents', 'Attach a DD document', 'content.manage', {
    params: id,
    body: content.roadshowDocumentBody,
    status: 201,
  }),
  staff('delete', '/roadshows/:id/documents/:docId', 'Remove a DD document', 'content.manage', {
    params: content.roadshowDocumentParams,
    status: 204,
  }),
  staff(
    'post',
    '/roadshows/:id/questions/:qid/answer',
    "Publish the issuer's answer",
    'questions.answer',
    { params: content.questionParams, body: content.answerQuestionBody },
  ),
  staff('get', '/learn', 'List learn items', 'content.read', {
    query: content.listAdminLearnQuery,
    page: true,
  }),
  staff('get', '/learn/:id', 'One learn item', 'content.read', { params: id }),
  staff('post', '/learn', 'Create a learn item', 'content.manage', {
    body: content.createLearnBody,
    status: 201,
  }),
  staff('patch', '/learn/:id', 'Update a learn item', 'content.manage', {
    params: id,
    body: content.updateLearnBody,
  }),
  staff('delete', '/learn/:id', 'Archive a learn item', 'content.manage', {
    params: id,
    status: 204,
  }),
  staff('post', '/credits/grant', 'Grant or revoke credits', 'credits.manage', {
    body: admin.creditChangeBody,
    status: 201,
    idempotent: true,
  }),
  staff('get', '/audit-logs', 'Audit trail', 'audit.read', {
    query: admin.auditLogsQuery,
    page: true,
  }),
  staff('post', '/uploads', 'Signed upload URL for staff documents', 'per upload target', {
    body: admin.uploadUrlBody,
    status: 201,
  }),
];
