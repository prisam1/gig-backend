import { z } from 'zod';
import { COUNTRY_CODES, DEVICE_PLATFORMS } from '../modules/auth/auth.schemas';
import { PREFERENCE_TYPES } from '../modules/users/users.schemas';
import { Constants } from '../types/database';
import {
  DISPLAY_MODES,
  FILE_PURPOSES,
  FILE_SCAN_STATUSES,
  KYC_DOCUMENT_TYPES,
  KYC_SUBMISSION_STATUSES,
  MARKET_COUNTRIES,
  RATING_FLAGS,
  RATING_STATUSES,
  REPRESENTATION_DOCUMENT_TYPES,
  REPRESENTATION_TRACK_STATUSES,
  STAFF_ROLES,
  USER_STATUSES,
} from '../types/domain';
import { KYC_STATUSES, TIERS } from './membership';

// Every app_* database function the API calls (supabase/migrations/*_app_functions.sql,
// *_ratings_representations_functions.sql and the two *_admin*.sql migrations): the exact arguments it takes and the shape of what it
// returns. callDb checks both, so an argument mistake fails to compile and a database result that
// drifts from its promised shape fails loudly instead of reaching a response.
// test/db/db_contract.db.test.ts checks this list against the real functions.

// ---------------------------------------------------------------------------------------------
// Building blocks
// ---------------------------------------------------------------------------------------------

/** Internal bigint id, sent and returned as text so it never loses precision. */
const internalId = z.string().regex(/^\d+$/, 'Expected an internal id');
const uuid = z.uuid();

/** A timestamp as JSON carries it (ISO text), returned as a Date. */
const timestamp = z.string().transform((value, ctx) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    ctx.addIssue({ code: 'custom', message: `Invalid timestamp: ${value}` });
    return z.NEVER;
  }
  return date;
});

/** Functions that return nothing; the result is ignored. */
const nothing = z.unknown().transform(() => undefined);

const tier = z.enum(TIERS);
const verifiedTier = z.enum(['PRIVE', 'INSTITUTIONAL']);
const kycStatus = z.enum(KYC_STATUSES);
const channel = z.enum(['EMAIL', 'PHONE']);

/** An expected failure the function reports instead of raising. */
const failure = z.object({
  error: z.string(),
  retryAfter: z.number().optional(),
  remaining: z.number().int().optional(),
});

const page = <T extends z.ZodType>(item: T) => z.object({ items: z.array(item), total: z.number().int() });

// ---------------------------------------------------------------------------------------------
// Argument shapes
// ---------------------------------------------------------------------------------------------

const ctx = z.strictObject({
  ip: z.string().nullable(),
  userAgent: z.string().nullable(),
  appVersion: z.string().nullable(),
  requestId: z.string(),
});

const limit = z.strictObject({ key: z.string(), max: z.number().int(), window: z.number().int() });

const storedCode = z.strictObject({ publicId: uuid, codeHash: z.string(), decoyHash: z.string() });

const newSession = z.strictObject({
  publicId: uuid,
  refreshHash: z.string(),
  deviceName: z.string().nullable(),
  platform: z.enum(DEVICE_PLATFORMS),
  idleDays: z.number().int(),
  maxDays: z.number().int(),
  maxActive: z.number().int(),
});

const args = <T extends z.ZodRawShape>(shape: T) => z.strictObject(shape);

// ---------------------------------------------------------------------------------------------
// Result shapes
// ---------------------------------------------------------------------------------------------

const member = z.object({
  userId: internalId,
  userPublicId: uuid,
  sessionId: internalId,
  sessionPublicId: uuid,
  tier,
  requestedTier: verifiedTier.nullable(),
  kycStatus,
  fullName: z.string(),
});

const storedFile = z.object({
  id: internalId,
  publicId: uuid,
  purpose: z.enum(FILE_PURPOSES),
  bucket: z.string(),
  objectKey: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number().int(),
});

const writeResult = z.union([
  z.object({ ok: z.literal(true), requestedTier: verifiedTier.nullable().optional() }),
  z.object({ fields: z.record(z.string(), z.string()) }),
  z.object({ error: z.string() }),
]);

const issuer = z.object({
  id: uuid,
  slug: z.string(),
  name: z.string(),
  instrument: z.string(),
  assetType: z.string(),
  exchange: z.string().nullable(),
  isListed: z.boolean(),
  openDate: z.string().nullable(),
  closeDate: z.string().nullable(),
  minLot: z.number().nullable(),
  lotUnit: z.string(),
  priceMin: z.number().nullable(),
  priceMax: z.number().nullable(),
  offerSize: z.number().nullable(),
  currency: z.string(),
  useOfFunds: z.string().nullable(),
  lockIn: z.string().nullable(),
  prePostRatio: z.string().nullable(),
  tags: z.array(z.string()),
  ratingCount: z.number().int(),
  averageScore: z.number(),
  createdAt: timestamp,
});

const issuerRef = z.object({ id: uuid, name: z.string() });

const representation = z.object({
  internalId,
  id: uuid,
  slug: z.string(),
  title: z.string(),
  description: z.string(),
  asks: z.array(z.string()),
  whyItMatters: z.string(),
  category: z.string().nullable(),
  country: z.enum(MARKET_COUNTRIES),
  tags: z.array(z.string()),
  regulators: z.array(z.string()),
  goal: z.number().int(),
  signatureCount: z.number().int(),
  voteCount: z.number().int(),
  progressPercent: z.number(),
  opensAt: timestamp,
  closesAt: timestamp,
  daysLeft: z.number().int(),
  trackStatus: z.enum(REPRESENTATION_TRACK_STATUSES),
  isOpenForSigning: z.boolean(),
  createdAt: timestamp,
});

const representationDocument = z.object({
  id: uuid,
  title: z.string(),
  documentType: z.enum(REPRESENTATION_DOCUMENT_TYPES),
  file: z.object({
    bucket: z.string(),
    objectKey: z.string(),
    mimeType: z.string(),
    sizeBytes: z.number().int(),
  }),
});

const signatureArgs = args({
  p_signature: z.strictObject({
    userId: internalId,
    representationId: uuid,
    signatureCode: z.string(),
    displayMode: z.enum(DISPLAY_MODES),
    signerName: z.string(),
    investorType: z.string().nullable(),
    signatureFileId: internalId,
    signerTier: tier,
    consentTypes: z.array(z.string()),
    consentVersion: z.string(),
    idempotencyKey: z.string(),
    requestHash: z.string(),
  }),
  p_ctx: ctx,
});

// ---------------------------------------------------------------------------------------------
// Admin shapes (20261028090000_admin.sql, 20261028100000_admin_roadshows_learn.sql)
// ---------------------------------------------------------------------------------------------

const E = Constants.public.Enums;
const staffRole = z.enum(STAFF_ROLES);
const userStatus = z.enum(USER_STATUSES);
const kycSubmissionStatus = z.enum(KYC_SUBMISSION_STATUSES);
const scanStatus = z.enum(FILE_SCAN_STATUSES);
const contentStatus = z.enum(E.content_status);
/** Reviews, ratings and roadshow questions share these moderation statuses. */
const moderationStatus = z.enum(RATING_STATUSES);
const moderationType = z.enum(['REVIEW', 'RATING', 'QUESTION']);
const personRef = z.object({ id: uuid, name: z.string().nullable() });
const paging = { p_limit: z.number().int(), p_offset: z.number().int() };
/** The fields being set; each one is validated by the request schemas in src/modules/admin/admin.schemas.ts. */
const fieldsToSet = z.record(z.string(), z.unknown());
const staffWrite = { p_actor_id: internalId, p_ctx: ctx };

/** An expected failure: { error: CODE }, with the current status or balance where it helps. */
const adminFailure = z.object({
  error: z.string(),
  status: z.string().optional(),
  balance: z.number().int().optional(),
});
const orFailure = <T extends z.ZodType>(value: T) => z.union([adminFailure, value]);

const adminUser = z.object({
  id: uuid,
  name: z.string().nullable(),
  tier,
  requestedTier: verifiedTier.nullable(),
  kycStatus,
  status: userStatus,
  creditBalance: z.number().int(),
  roles: z.array(staffRole),
  createdAt: timestamp,
  lastLoginAt: timestamp.nullable(),
});

const adminUserDetail = z.object({
  id: internalId,
  publicId: uuid,
  emailEnc: z.string(),
  phoneEnc: z.string(),
  name: z.string().nullable(),
  experienceYears: z.number().int().nullable(),
  jobProfile: z.string().nullable(),
  otherJob: z.string().nullable(),
  location: z.string().nullable(),
  tier,
  requestedTier: verifiedTier.nullable(),
  kycStatus,
  status: userStatus,
  creditBalance: z.number().int(),
  roles: z.array(staffRole),
  emailVerifiedAt: timestamp,
  phoneVerifiedAt: timestamp,
  createdAt: timestamp,
  lastLoginAt: timestamp.nullable(),
  deletedAt: timestamp.nullable(),
  activeSessions: z.number().int(),
  activity: z.object({
    reviews: z.number().int(),
    ratings: z.number().int(),
    signatures: z.number().int(),
    followers: z.number().int(),
    following: z.number().int(),
  }),
  kycSubmissions: z.array(
    z.object({
      id: uuid,
      tier: verifiedTier,
      status: kycSubmissionStatus,
      reason: z.string().nullable(),
      submittedAt: timestamp,
      reviewedAt: timestamp.nullable(),
    }),
  ),
  tierHistory: z.array(
    z.object({
      fromTier: tier,
      toTier: tier,
      requestedTier: verifiedTier.nullable(),
      reason: z.string(),
      at: timestamp,
    }),
  ),
});

const kycUser = z.object({ id: uuid, name: z.string().nullable(), tier, kycStatus, status: userStatus });

const adminKycItem = z.object({
  id: uuid,
  tier: verifiedTier,
  status: kycSubmissionStatus,
  provider: z.string(),
  reason: z.string().nullable(),
  submittedAt: timestamp,
  reviewedAt: timestamp.nullable(),
  documentCount: z.number().int(),
  user: kycUser,
});

const adminKycDetail = z.object({
  id: uuid,
  tier: verifiedTier,
  status: kycSubmissionStatus,
  provider: z.string(),
  reference: z.string().nullable(),
  reason: z.string().nullable(),
  submittedAt: timestamp,
  reviewedAt: timestamp.nullable(),
  reviewer: personRef.nullable(),
  user: kycUser.extend({ requestedTier: verifiedTier.nullable(), createdAt: timestamp }),
  consent: z.object({ version: z.string(), acceptedAt: timestamp }).nullable(),
  documents: z.array(
    z.object({
      fileId: uuid,
      documentType: z.enum(KYC_DOCUMENT_TYPES),
      bucket: z.string(),
      objectKey: z.string(),
      mimeType: z.string(),
      sizeBytes: z.number().int(),
      scanStatus,
    }),
  ),
});

const moderationItemBase = z.object({
  type: moderationType,
  id: uuid,
  /** Null for questions, which have no receipt. */
  receiptNo: z.string().nullable(),
  status: moderationStatus,
  submittedAt: timestamp,
  moderationNote: z.string().nullable(),
  author: z.object({ id: uuid, name: z.string(), tier: tier.nullable(), kycStatus: kycStatus.nullable() }),
  subject: z.object({ type: z.enum(['COMPANY', 'ISSUER', 'ROADSHOW']), id: uuid, name: z.string() }),
});

const adminCompany = z.object({
  id: uuid,
  slug: z.string(),
  name: z.string(),
  assetClass: z.enum(E.asset_class),
  country: z.enum(MARKET_COUNTRIES),
  logoUrl: z.string().nullable(),
  description: z.string().nullable(),
  verified: z.boolean(),
  tags: z.array(z.string()),
  reviewCount: z.number().int(),
  score: z.number(),
  pendingReviews: z.number().int(),
  createdAt: timestamp,
  updatedAt: timestamp,
  deletedAt: timestamp.nullable(),
});

const adminIssuer = issuer.omit({ createdAt: true }).extend({
  pendingRatings: z.number().int(),
  createdAt: timestamp,
  updatedAt: timestamp,
  deletedAt: timestamp.nullable(),
});

const trackStatus = z.enum(REPRESENTATION_TRACK_STATUSES);

const adminRepresentation = z.object({
  id: uuid,
  slug: z.string(),
  title: z.string(),
  description: z.string(),
  asks: z.array(z.string()),
  whyItMatters: z.string(),
  category: z.string().nullable(),
  country: z.enum(MARKET_COUNTRIES),
  tags: z.array(z.string()),
  regulators: z.array(z.string()),
  goal: z.number().int(),
  signatureCount: z.number().int(),
  voteCount: z.number().int(),
  opensAt: timestamp,
  closesAt: timestamp,
  /** As stored; Open / Closing Soon / Closed are then derived from the dates. */
  storedStatus: trackStatus,
  /** The status the app shows. */
  trackStatus,
  isPublished: z.boolean(),
  isOpenForSigning: z.boolean(),
  documentCount: z.number().int(),
  createdAt: timestamp,
  updatedAt: timestamp,
  deletedAt: timestamp.nullable(),
});

const staffDocument = z.strictObject({
  objectKey: z.string(),
  title: z.string(),
  documentType: z.enum(REPRESENTATION_DOCUMENT_TYPES),
  mimeType: z.string(),
  sizeBytes: z.number().int(),
});

const money = z.number().nullable();

const adminRoadshow = z.object({
  id: uuid,
  slug: z.string(),
  title: z.string(),
  summary: z.string().nullable(),
  issuer: issuerRef,
  typeOfIssue: z.string(),
  instruments: z.string(),
  noOfInstruments: z.number().int().nullable(),
  offerPrice: money,
  currency: z.enum(E.currency_code),
  lockIn: z.string().nullable(),
  maturity: z.string().nullable(),
  convertibility: z.string().nullable(),
  callable: z.boolean(),
  couponRate: money,
  riskFactors: z.array(z.string()),
  opensAt: timestamp.nullable(),
  closesAt: timestamp,
  poolEnabled: z.boolean(),
  status: contentStatus,
  publishedAt: timestamp.nullable(),
  /** Published, opened and not yet closed. */
  isOpen: z.boolean(),
  /** Newest fiscal year first. */
  financials: z.array(
    z.object({
      fiscalYear: z.number().int(),
      revenue: money,
      ebitda: money,
      netProfit: money,
      totalAssets: money,
      totalLiabilities: money,
      netWorth: money,
      totalDebt: money,
      cashAndEquivalents: money,
      operatingCashFlow: money,
      eps: money,
    }),
  ),
  documentCount: z.number().int(),
  poolMembers: z.number().int(),
  questions: z.object({ pending: z.number().int(), published: z.number().int(), unanswered: z.number().int() }),
  createdAt: timestamp,
  updatedAt: timestamp,
});

const adminQuestion = z.object({
  id: uuid,
  category: z.enum(E.question_category),
  question: z.string(),
  status: z.enum(E.question_status),
  featured: z.boolean(),
  moderationNote: z.string().nullable(),
  answer: z.string().nullable(),
  answeredAt: timestamp.nullable(),
  answeredBy: personRef.nullable(),
  author: moderationItemBase.shape.author,
  submittedAt: timestamp,
  updatedAt: timestamp,
});

const adminLearnItem = z.object({
  id: uuid,
  title: z.string(),
  summary: z.string().nullable(),
  format: z.enum(E.learn_format),
  category: z.string().nullable(),
  access: z.enum(E.content_access),
  thumbnailUrl: z.string().nullable(),
  contentUrl: z.string().nullable(),
  durationSeconds: z.number().int().nullable(),
  downloadPath: z.string().nullable(),
  ratingAvg: z.number(),
  ratingCount: z.number().int(),
  status: contentStatus,
  publishedAt: timestamp.nullable(),
  createdAt: timestamp,
  updatedAt: timestamp,
});

const creditEntry = z.object({
  id: internalId,
  delta: z.number().int(),
  balanceAfter: z.number().int(),
  reason: z.enum(E.credit_reason),
  refType: z.string().nullable(),
  refId: uuid.nullable(),
  note: z.string().nullable(),
  createdAt: timestamp,
});

const auditEntry = z.object({
  id: internalId,
  occurredAt: timestamp,
  action: z.string(),
  actor: personRef.nullable(),
  ip: z.string().nullable(),
  userAgent: z.string().nullable(),
  requestId: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()),
});

const saved = orFailure(z.object({ id: uuid }));

// ---------------------------------------------------------------------------------------------
// The functions
// ---------------------------------------------------------------------------------------------

const fn = <A extends z.ZodType, R extends z.ZodType>(argsSchema: A, result: R) => ({ args: argsSchema, result });

export const DB_FUNCTIONS = {
  // Infrastructure
  app_ping: fn(args({}), z.boolean()),
  app_purge_expired: fn(args({}), nothing),
  app_rate_limit_hit: fn(
    args({ p_key: z.string(), p_max: z.number().int(), p_window_seconds: z.number().int() }),
    z.object({ limited: z.boolean(), retryAfter: z.number() }),
  ),
  app_rate_limit_reset: fn(args({ p_keys: z.array(z.string()) }), nothing),
  app_audit: fn(
    args({
      p_ctx: ctx,
      p_action: z.string(),
      p_user_id: internalId.nullable(),
      p_metadata: z.record(z.string(), z.unknown()),
    }),
    nothing,
  ),

  // Sessions
  app_member: fn(args({ p_user_public_id: uuid, p_session_public_id: uuid }), member.nullable()),
  app_logout: fn(args({ p_user_id: internalId, p_session_id: internalId, p_ctx: ctx }), nothing),
  app_list_sessions: fn(
    args({ p_user_id: internalId }),
    z.array(
      z.object({
        id: uuid,
        deviceName: z.string().nullable(),
        platform: z.enum(DEVICE_PLATFORMS),
        appVersion: z.string().nullable(),
        ip: z.string().nullable(),
        createdAt: timestamp,
        lastUsedAt: timestamp,
      }),
    ),
  ),
  app_revoke_session: fn(args({ p_user_id: internalId, p_session_public_id: uuid, p_ctx: ctx }), z.boolean()),
  app_revoke_other_sessions: fn(
    args({ p_user_id: internalId, p_keep_session_id: internalId, p_ctx: ctx }),
    nothing,
  ),

  // Sign-up, OTP and login
  app_signup_start: fn(
    args({
      p_signup: z.strictObject({
        name: z.string(),
        emailEnc: z.string(),
        emailHash: z.string(),
        countryCode: z.enum(COUNTRY_CODES),
        phoneEnc: z.string(),
        phoneHash: z.string(),
        passwordHash: z.string(),
        ttlSeconds: z.number().int(),
        otpTtlSeconds: z.number().int(),
      }),
      p_email_challenge: storedCode,
      p_phone_challenge: storedCode,
      p_ctx: ctx,
    }),
    z.object({ signupId: uuid, expiresAt: timestamp, emailTaken: z.boolean(), phoneTaken: z.boolean() }),
  ),
  app_otp_start: fn(
    args({
      p_purpose: z.enum(['LOGIN', 'PASSWORD_RESET']),
      p_channel: channel,
      p_destination_hash: z.string(),
      p_challenge: storedCode,
      p_ttl_seconds: z.number().int(),
      p_ctx: ctx,
    }),
    z.object({ userExists: z.boolean() }),
  ),
  app_otp_peek: fn(args({ p_public_id: uuid }), z.object({ destinationHash: z.string() }).nullable()),
  app_otp_resend: fn(
    args({
      p_public_id: uuid,
      p_challenge: storedCode,
      p_cooldown_seconds: z.number().int(),
      p_max_sends: z.number().int(),
      p_ttl_seconds: z.number().int(),
      p_limit: limit,
    }),
    z.union([
      z.object({
        channel,
        purpose: z.enum(['SIGNUP', 'LOGIN', 'PASSWORD_RESET']),
        isDecoy: z.boolean(),
        destinationEnc: z.string().nullable(),
      }),
      failure,
    ]),
  ),
  app_otp_verify: fn(
    args({
      p_public_id: uuid,
      p_code_hash: z.string(),
      p_max_attempts: z.number().int(),
      p_limits: z.array(limit),
      p_session: newSession,
      p_reset: z.strictObject({ tokenHash: z.string(), ttlSeconds: z.number().int() }),
      p_age_consent_version: z.string(),
      p_ctx: ctx,
    }),
    z.union([
      z.object({
        status: z.literal('PENDING'),
        signupId: uuid,
        verified: z.array(channel),
        pending: z.array(channel),
      }),
      z.object({
        status: z.literal('COMPLETED'),
        userId: internalId,
        userPublicId: uuid,
        sessionExpiresAt: timestamp,
      }),
      z.object({ status: z.literal('RESET_TOKEN_ISSUED') }),
      failure,
    ]),
  ),
  app_login_lookup: fn(
    args({ p_channel: channel, p_id_hash: z.string() }),
    z
      .object({
        userId: internalId,
        userPublicId: uuid,
        passwordHash: z.string(),
        status: z.enum(['ACTIVE', 'SUSPENDED', 'DELETED']),
      })
      .nullable(),
  ),
  app_login_complete: fn(
    args({ p_user_id: internalId, p_session: newSession, p_ctx: ctx }),
    z.union([z.object({ sessionExpiresAt: timestamp }), failure]),
  ),
  app_refresh: fn(
    args({
      p_session_public_id: uuid,
      p_secret_hash: z.string(),
      p_new_secret_hash: z.string(),
      p_idle_days: z.number().int(),
      p_ctx: ctx,
    }),
    z.union([z.object({ userPublicId: uuid, sessionExpiresAt: timestamp }), failure]),
  ),
  app_reset_lookup: fn(
    args({ p_token_hash: z.string() }),
    z
      .object({ userId: internalId, passwordHash: z.string(), emailEnc: z.string(), phoneEnc: z.string() })
      .nullable(),
  ),
  app_reset_complete: fn(
    args({ p_token_hash: z.string(), p_password_hash: z.string(), p_ctx: ctx }),
    z.object({ ok: z.boolean() }),
  ),

  // Users, profile, preferences, tier and follows
  app_list_options: fn(args({ p_type: z.string() }), z.array(z.object({ code: z.string(), label: z.string() }))),
  app_get_user: fn(
    args({ p_user_id: internalId }),
    z
      .object({
        publicId: uuid,
        emailEnc: z.string(),
        phoneEnc: z.string(),
        tier,
        requestedTier: verifiedTier.nullable(),
        kycStatus,
        tierSelectedAt: timestamp.nullable(),
        createdAt: timestamp,
        name: z.string(),
        experienceYears: z.number().int().nullable(),
        jobProfileCode: z.string().nullable(),
        jobProfileLabel: z.string().nullable(),
        otherJob: z.string().nullable(),
        location: z.string().nullable(),
        avatarBucket: z.string().nullable(),
        avatarObjectKey: z.string().nullable(),
        followers: z.number().int(),
        following: z.number().int(),
        preferences: z.array(z.object({ type: z.enum(PREFERENCE_TYPES), code: z.string(), label: z.string() })),
      })
      .nullable(),
  ),
  app_update_profile: fn(
    args({
      p_user_id: internalId,
      p_changes: z.strictObject({
        name: z.string().optional(),
        experienceYears: z.number().int().optional(),
        jobProfile: z.string().optional(),
        otherJob: z.string().optional(),
        location: z.string().optional(),
        avatarFileId: internalId.optional(),
      }),
      p_ctx: ctx,
    }),
    writeResult,
  ),
  app_set_preferences: fn(
    args({
      p_user_id: internalId,
      p_groups: z.array(
        z.strictObject({ type: z.enum(PREFERENCE_TYPES), field: z.string(), codes: z.array(z.string()) }),
      ),
      p_ctx: ctx,
    }),
    writeResult,
  ),
  app_select_tier: fn(args({ p_user_id: internalId, p_tier: tier, p_ctx: ctx }), writeResult),
  app_public_user: fn(
    args({ p_public_id: uuid }),
    z
      .object({
        id: internalId,
        publicId: uuid,
        tier,
        kycStatus,
        createdAt: timestamp,
        name: z.string(),
        location: z.string().nullable(),
        avatarBucket: z.string().nullable(),
        avatarObjectKey: z.string().nullable(),
      })
      .nullable(),
  ),
  app_count_follows: fn(
    args({ p_user_id: internalId }),
    z.object({ followers: z.number().int(), following: z.number().int() }),
  ),
  app_follow: fn(args({ p_follower_id: internalId, p_followee_id: internalId }), nothing),
  app_unfollow: fn(args({ p_follower_id: internalId, p_followee_id: internalId }), nothing),

  // Files and KYC
  app_create_file: fn(
    args({
      p_owner_id: internalId,
      p_purpose: z.enum(FILE_PURPOSES),
      p_bucket: z.string(),
      p_object_key: z.string(),
      p_mime_type: z.string(),
      p_size_bytes: z.number().int(),
    }),
    storedFile,
  ),
  app_find_owned_files: fn(args({ p_owner_id: internalId, p_public_ids: z.array(uuid) }), z.array(storedFile)),
  app_kyc_submit: fn(
    args({
      p_user_id: internalId,
      p_tier: verifiedTier,
      p_documents: z.array(z.strictObject({ fileId: internalId, documentType: z.enum(KYC_DOCUMENT_TYPES) })),
      p_consent_version: z.string().nullable(),
      p_ctx: ctx,
    }),
    uuid,
  ),
  app_kyc_latest: fn(
    args({ p_user_id: internalId }),
    z
      .object({
        publicId: uuid,
        tier: verifiedTier,
        status: z.enum(KYC_SUBMISSION_STATUSES),
        reason: z.string().nullable(),
        submittedAt: timestamp,
        reviewedAt: timestamp.nullable(),
        documents: z.array(z.object({ fileId: uuid, documentType: z.enum(KYC_DOCUMENT_TYPES) })),
      })
      .nullable(),
  ),

  // Ratings
  app_find_issuers: fn(
    args({
      p_q_pattern: z.string().nullable(),
      p_asset_types: z.array(z.string()).nullable(),
      p_listed: z.boolean().nullable(),
      p_sort: z.string(),
      p_limit: z.number().int(),
      p_offset: z.number().int(),
    }),
    page(issuer),
  ),
  app_find_issuer: fn(args({ p_id: uuid }), issuer.nullable()),
  app_issuer_stats: fn(
    args({ p_issuer_id: uuid }),
    z
      .object({
        ratingCount: z.number().int(),
        averageScore: z.number(),
        weightedScore: z.number(),
        // jsonb aggregates; ratings.repository.ts parses them with their own schemas.
        scoreDistribution: z.unknown(),
        factorBreakdown: z.unknown(),
        riskCounts: z.unknown(),
        lastRatingAt: timestamp.nullable(),
      })
      .nullable(),
  ),
  app_rating_submit: fn(
    args({
      p_rating: z.strictObject({
        userId: internalId,
        issuerId: uuid,
        overallScore: z.number().int(),
        factors: z.array(z.strictObject({ code: z.string(), flag: z.enum(RATING_FLAGS) })),
        riskCodes: z.array(z.string()),
        idempotencyKey: z.string(),
        requestHash: z.string(),
      }),
      p_ctx: ctx,
    }),
    uuid,
  ),
  app_rating_by_idempotency_key: fn(
    args({ p_user_id: internalId, p_idempotency_key: z.string() }),
    z.object({ publicId: uuid, requestHash: z.string().nullable() }).nullable(),
  ),
  app_rating_own: fn(
    args({ p_user_id: internalId, p_public_id: uuid }),
    z
      .object({
        publicId: uuid,
        receiptNo: z.string(),
        status: z.enum(RATING_STATUSES),
        overallScore: z.number().int(),
        moderationNote: z.string().nullable(),
        createdAt: timestamp,
        issuer: issuerRef,
        factors: z.array(z.object({ code: z.string(), flag: z.enum(RATING_FLAGS) })),
        riskCodes: z.array(z.string()),
      })
      .nullable(),
  ),
  app_ratings_mine: fn(
    args({
      p_user_id: internalId,
      p_statuses: z.array(z.enum(RATING_STATUSES)).nullable(),
      p_limit: z.number().int(),
      p_offset: z.number().int(),
    }),
    page(
      z.object({
        publicId: uuid,
        receiptNo: z.string(),
        status: z.enum(RATING_STATUSES),
        overallScore: z.number().int(),
        createdAt: timestamp,
        issuer: issuerRef,
      }),
    ),
  ),

  // Representations
  app_find_representations: fn(
    args({
      p_q_pattern: z.string().nullable(),
      p_statuses: z.array(z.enum(REPRESENTATION_TRACK_STATUSES)).nullable(),
      p_countries: z.array(z.enum(MARKET_COUNTRIES)).nullable(),
      p_open: z.boolean().nullable(),
      p_sort: z.string(),
      p_limit: z.number().int(),
      p_offset: z.number().int(),
    }),
    page(representation),
  ),
  app_find_representation: fn(args({ p_id: uuid }), representation.nullable()),
  app_representation_signers: fn(
    args({ p_representation_id: internalId, p_limit: z.number().int() }),
    z.array(
      z.object({
        id: uuid,
        displayMode: z.enum(DISPLAY_MODES),
        signerName: z.string(),
        investorType: z.string().nullable(),
        investorTypeLabel: z.string().nullable(),
        signerTier: tier,
        signedAt: timestamp,
      }),
    ),
  ),
  app_representation_evidence: fn(args({ p_representation_id: internalId }), z.array(representationDocument)),
  app_representation_history: fn(
    args({ p_representation_id: internalId }),
    z.array(
      z.object({
        fromStatus: z.enum(REPRESENTATION_TRACK_STATUSES).nullable(),
        toStatus: z.enum(REPRESENTATION_TRACK_STATUSES),
        note: z.string().nullable(),
        occurredAt: timestamp,
        documents: z.array(representationDocument),
      }),
    ),
  ),
  app_representation_submission_pack: fn(
    args({ p_representation_id: internalId }),
    representationDocument.nullable(),
  ),
  app_representation_signature: fn(
    args({ p_user_id: internalId, p_representation_id: internalId }),
    z
      .object({
        publicId: uuid,
        signatureCode: z.string(),
        displayMode: z.enum(DISPLAY_MODES),
        signerName: z.string(),
        investorType: z.string().nullable(),
        signerTier: tier,
        createdAt: timestamp,
      })
      .nullable(),
  ),
  app_signature_by_idempotency_key: fn(
    args({ p_user_id: internalId, p_idempotency_key: z.string() }),
    z.object({ representationId: uuid, requestHash: z.string().nullable() }).nullable(),
  ),
  app_representation_sign: fn(
    signatureArgs,
    z.union([
      z.object({ ok: z.literal(true) }),
      z.object({ error: z.enum(['NOT_FOUND', 'CLOSED', 'FILE_INVALID']) }),
    ]),
  ),

  // Admin: staff, users and KYC
  app_admin_staff_roles: fn(args({ p_user_id: internalId }), z.array(staffRole)),
  app_admin_find_users: fn(
    args({
      p_search: z.strictObject({
        emailHash: z.string().optional(),
        phoneHash: z.string().optional(),
        publicId: uuid.optional(),
        namePattern: z.string().optional(),
      }),
      p_tiers: z.array(tier).nullable(),
      p_kyc_statuses: z.array(kycStatus).nullable(),
      p_statuses: z.array(userStatus).nullable(),
      p_roles: z.array(staffRole).nullable(),
      p_sort: z.enum(['-createdAt', 'createdAt', 'name', '-lastLoginAt']),
      ...paging,
    }),
    page(adminUser),
  ),
  app_admin_get_user: fn(args({ p_public_id: uuid }), adminUserDetail.nullable()),
  app_admin_update_user: fn(
    args({
      ...staffWrite,
      p_public_id: uuid,
      p_changes: z.strictObject({ tier: tier.optional(), status: z.enum(['ACTIVE', 'SUSPENDED']).optional() }),
      p_reason: z.string(),
    }),
    orFailure(z.object({ ok: z.literal(true) })),
  ),
  app_admin_set_roles: fn(
    args({ ...staffWrite, p_public_id: uuid, p_roles: z.array(staffRole) }),
    orFailure(z.object({ roles: z.array(staffRole) })),
  ),
  app_admin_user_credits: fn(
    args({ p_public_id: uuid, ...paging }),
    page(creditEntry.extend({ actor: personRef.nullable() })).extend({ balance: z.number().int() }).nullable(),
  ),
  app_admin_find_kyc: fn(
    args({ p_statuses: z.array(kycSubmissionStatus).nullable(), p_tiers: z.array(verifiedTier).nullable(), ...paging }),
    page(adminKycItem),
  ),
  app_admin_get_kyc: fn(args({ p_public_id: uuid }), adminKycDetail.nullable()),
  app_admin_decide_kyc: fn(
    args({
      ...staffWrite,
      p_public_id: uuid,
      p_decision: z.enum(['APPROVE', 'REJECT']),
      p_reason: z.string().nullable(),
    }),
    orFailure(z.object({ status: kycSubmissionStatus, tier, kycStatus })),
  ),

  // Admin: moderation
  app_admin_moderation_queue: fn(
    args({ p_types: z.array(moderationType).nullable(), p_statuses: z.array(moderationStatus).nullable(), ...paging }),
    page(moderationItemBase.extend({ summary: z.record(z.string(), z.unknown()) })),
  ),
  app_admin_moderation_item: fn(
    args({ p_type: moderationType, p_id: uuid }),
    moderationItemBase
      .extend({
        publishedAt: timestamp.nullable(),
        content: z.record(z.string(), z.unknown()),
        evidence: z.array(z.object({ path: z.string(), docType: z.string() })),
        history: z.array(
          z.object({
            changeType: z.string(),
            fromValue: z.string().nullable(),
            toValue: z.string().nullable(),
            note: z.string().nullable(),
            at: timestamp,
          }),
        ),
      })
      .nullable(),
  ),
  app_admin_moderate: fn(
    args({
      ...staffWrite,
      p_type: moderationType,
      p_id: uuid,
      p_decision: z.enum(['APPROVE', 'REQUEST_CHANGES', 'REJECT', 'REMOVE']),
      p_note: z.string().nullable(),
    }),
    orFailure(z.object({ type: moderationType, id: uuid, previousStatus: moderationStatus, status: moderationStatus })),
  ),

  // Admin: companies and issuers
  app_admin_find_companies: fn(
    args({
      p_q_pattern: z.string().nullable(),
      p_asset_classes: z.array(z.enum(E.asset_class)).nullable(),
      p_countries: z.array(z.enum(MARKET_COUNTRIES)).nullable(),
      p_verified: z.boolean().nullable(),
      p_include_deleted: z.boolean(),
      ...paging,
    }),
    page(adminCompany),
  ),
  app_admin_get_company: fn(args({ p_id: uuid }), adminCompany.nullable()),
  app_admin_save_company: fn(args({ ...staffWrite, p_id: uuid.nullable(), p_company: fieldsToSet }), saved),
  app_admin_delete_company: fn(args({ ...staffWrite, p_id: uuid }), z.boolean()),
  app_admin_find_issuers: fn(
    args({
      p_q_pattern: z.string().nullable(),
      p_asset_types: z.array(z.string()).nullable(),
      p_listed: z.boolean().nullable(),
      p_include_deleted: z.boolean(),
      ...paging,
    }),
    page(adminIssuer),
  ),
  app_admin_get_issuer: fn(args({ p_id: uuid }), adminIssuer.nullable()),
  app_admin_save_issuer: fn(args({ ...staffWrite, p_id: uuid.nullable(), p_issuer: fieldsToSet }), saved),
  app_admin_delete_issuer: fn(args({ ...staffWrite, p_id: uuid }), z.boolean()),

  // Admin: representations and the petition track
  app_admin_find_representations: fn(
    args({
      p_q_pattern: z.string().nullable(),
      p_statuses: z.array(trackStatus).nullable(),
      p_countries: z.array(z.enum(MARKET_COUNTRIES)).nullable(),
      p_include_deleted: z.boolean(),
      ...paging,
    }),
    page(adminRepresentation),
  ),
  app_admin_get_representation: fn(
    args({ p_public_id: uuid }),
    adminRepresentation
      .extend({
        documents: z.array(
          z.object({
            id: uuid,
            title: z.string(),
            documentType: z.enum(REPRESENTATION_DOCUMENT_TYPES),
            bucket: z.string(),
            objectKey: z.string(),
            mimeType: z.string(),
            sizeBytes: z.number().int(),
            scanStatus,
            createdAt: timestamp,
          }),
        ),
        history: z.array(
          z.object({
            fromStatus: trackStatus.nullable(),
            toStatus: trackStatus,
            note: z.string().nullable(),
            actor: personRef.nullable(),
            occurredAt: timestamp,
            documentIds: z.array(uuid),
          }),
        ),
      })
      .nullable(),
  ),
  app_admin_save_representation: fn(
    args({ ...staffWrite, p_public_id: uuid.nullable(), p_representation: fieldsToSet }),
    saved,
  ),
  app_admin_delete_representation: fn(args({ ...staffWrite, p_public_id: uuid }), z.boolean()),
  app_admin_representation_status: fn(
    args({
      ...staffWrite,
      p_public_id: uuid,
      p_to_status: trackStatus,
      p_note: z.string().nullable(),
      p_documents: z.array(staffDocument),
    }),
    orFailure(z.object({ previousStatus: trackStatus, status: trackStatus })),
  ),
  app_admin_add_representation_documents: fn(
    args({ ...staffWrite, p_public_id: uuid, p_documents: z.array(staffDocument) }),
    orFailure(z.object({ ok: z.literal(true) })),
  ),

  // Admin: roadshows, questions and learn
  app_admin_find_roadshows: fn(
    args({
      p_q_pattern: z.string().nullable(),
      p_issuer_id: uuid.nullable(),
      p_statuses: z.array(contentStatus).nullable(),
      p_open: z.boolean().nullable(),
      ...paging,
    }),
    page(adminRoadshow),
  ),
  app_admin_get_roadshow: fn(args({ p_id: uuid }), adminRoadshow.nullable()),
  app_admin_save_roadshow: fn(args({ ...staffWrite, p_id: uuid.nullable(), p_roadshow: fieldsToSet }), saved),
  app_admin_archive_roadshow: fn(args({ ...staffWrite, p_id: uuid }), z.boolean()),
  app_admin_roadshow_questions: fn(
    args({
      p_id: uuid,
      p_statuses: z.array(z.enum(E.question_status)).nullable(),
      p_categories: z.array(z.enum(E.question_category)).nullable(),
      p_answered: z.boolean().nullable(),
      ...paging,
    }),
    page(adminQuestion).nullable(),
  ),
  app_admin_answer_question: fn(
    args({
      ...staffWrite,
      p_roadshow_id: uuid,
      p_question_id: uuid,
      p_answer: z.string(),
      p_featured: z.boolean().nullable(),
    }),
    orFailure(adminQuestion),
  ),
  app_admin_find_learn: fn(
    args({
      p_q_pattern: z.string().nullable(),
      p_formats: z.array(z.enum(E.learn_format)).nullable(),
      p_access: z.array(z.enum(E.content_access)).nullable(),
      p_statuses: z.array(contentStatus).nullable(),
      ...paging,
    }),
    page(adminLearnItem),
  ),
  app_admin_get_learn: fn(args({ p_id: uuid }), adminLearnItem.nullable()),
  app_admin_save_learn: fn(args({ ...staffWrite, p_id: uuid.nullable(), p_item: fieldsToSet }), saved),
  app_admin_archive_learn: fn(args({ ...staffWrite, p_id: uuid }), z.boolean()),

  // Admin: credits and the audit trail
  app_admin_grant_credits: fn(
    args({
      ...staffWrite,
      p_public_id: uuid,
      p_delta: z.number().int(),
      p_reason: z.string(),
      p_idempotency_key: z.string(),
      p_request_hash: z.string(),
    }),
    orFailure(z.object({ replayed: z.boolean(), balance: z.number().int(), entry: creditEntry })),
  ),
  app_admin_audit_logs: fn(
    args({
      p_action_patterns: z.array(z.string()).nullable(),
      p_user: uuid.nullable(),
      p_from: z.string().nullable(),
      p_to: z.string().nullable(),
      ...paging,
    }),
    page(auditEntry),
  ),
};

export type DbFunction = keyof typeof DB_FUNCTIONS;
export type DbArgs<F extends DbFunction> = z.input<(typeof DB_FUNCTIONS)[F]['args']>;
export type DbResult<F extends DbFunction> = z.output<(typeof DB_FUNCTIONS)[F]['result']>;
