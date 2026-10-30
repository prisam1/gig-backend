import { z } from 'zod';
import { COUNTRY_CODES, DEVICE_PLATFORMS } from '../modules/auth/auth.schemas';
import { PREFERENCE_TYPES } from '../constants/onboarding';
import {
  focusCodeSchema,
  jobProfileSchema,
  riskCodeSchema,
  sectorCodeSchema,
  styleCodeSchema,
} from '../modules/users/onboarding.schemas';
import {
  ACCOUNT_STATUSES,
  DISPLAY_MODES,
  FILE_PURPOSES,
  FILE_SCAN_STATUSES,
  KYC_DOCUMENT_TYPES,
  KYC_SUBMISSION_STATUSES,
  MARKET_COUNTRIES,
  MODERATION_DECISIONS,
  MODERATION_TYPES,
  RATING_FLAGS,
  RATING_STATUSES,
  REPRESENTATION_DOCUMENT_TYPES,
  REPRESENTATION_TRACK_STATUSES,
  STAFF_ROLES,
} from '../types/domain';
import {
  assetClassSchema,
  countrySchema,
  creditReasonSchema,
  currencySchema,
  displayModeSchema,
  investmentStatusSchema,
  offerStatusSchema,
  questionCategorySchema,
  questionStatusSchema,
  reinvestStatusSchema,
  resolutionStatusSchema,
  reviewStatusSchema,
  sentimentSchema,
} from './enums';
import { KYC_STATUSES, TIERS } from './membership';

// Every app_* database function the API calls (supabase/migrations/*_app_functions.sql and
// *_ratings_representations_functions.sql): the exact arguments it takes and the shape of what it
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
  z.object({ ok: z.literal(true) }),
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
// Admin shapes (supabase/migrations/20261028090000_admin.sql)
// ---------------------------------------------------------------------------------------------

const staffRole = z.enum(STAFF_ROLES);
const accountStatus = z.enum(ACCOUNT_STATUSES);
const trackStatus = z.enum(REPRESENTATION_TRACK_STATUSES);

/** A member as staff screens show them (app.user_ref). */
const userRef = z.object({ id: uuid, name: z.string(), tier, kycStatus, status: accountStatus });

/** { error } results of the admin write functions. */
const adminFailure = <const E extends readonly [string, ...string[]]>(codes: E) =>
  z.object({ error: z.enum(codes), status: z.string().optional() });

const subject = <T extends string>(type: T) =>
  z.object({ type: z.literal(type), id: uuid, name: z.string() });

const moderationBase = {
  id: uuid,
  note: z.string().nullable(),
  createdAt: timestamp,
  author: userRef.nullable(),
};

/** One moderation queue item; `content` depends on `type`. */
const moderationItem = z.discriminatedUnion('type', [
  z.object({
    ...moderationBase,
    type: z.literal('REVIEW'),
    status: reviewStatusSchema,
    subject: subject('COMPANY'),
    content: z.object({
      receiptNo: z.string(),
      country: countrySchema,
      assetClass: assetClassSchema,
      productScheme: z.string(),
      investmentYear: z.number().int().nullable(),
      investmentStatus: investmentStatusSchema,
      sentiment: sentimentSchema,
      detailedReview: z.string().nullable(),
      mixedReview: z.string().nullable(),
      negativeDescription: z.string().nullable(),
      reinvestStatus: reinvestStatusSchema.nullable(),
      metrics: z.object({
        transparency: z.number().int(),
        responsiveness: z.number().int(),
        easeOfProcess: z.number().int(),
        trustworthiness: z.number().int(),
        overallSatisfaction: z.number().int(),
      }),
      resolutionStatus: resolutionStatusSchema,
      followUpNote: z.string().nullable(),
      displayMode: displayModeSchema,
      authorName: z.string(),
      allowContact: z.boolean(),
      tags: z.array(
        z.object({ type: z.enum(['APPRECIATION', 'CONCERN', 'CONTACT_STATUS']), code: z.string() }),
      ),
      evidence: z.array(z.object({ path: z.string(), docType: z.string() })),
    }),
  }),
  z.object({
    ...moderationBase,
    type: z.literal('RATING'),
    status: z.enum(RATING_STATUSES),
    subject: subject('ISSUER'),
    content: z.object({
      receiptNo: z.string(),
      overallScore: z.number().int(),
      factors: z.array(z.object({ code: z.string(), flag: z.enum(RATING_FLAGS) })),
      riskCodes: z.array(z.string()),
    }),
  }),
  z.object({
    ...moderationBase,
    type: z.literal('QUESTION'),
    status: questionStatusSchema,
    subject: subject('ROADSHOW'),
    content: z.object({
      question: z.string(),
      category: questionCategorySchema,
      featured: z.boolean(),
      answer: z.string().nullable(),
      answeredAt: timestamp.nullable(),
    }),
  }),
  z.object({
    ...moderationBase,
    type: z.literal('OFFER'),
    status: offerStatusSchema,
    subject: subject('ROADSHOW'),
    content: z.object({
      offerPrice: z.number().nullable(),
      currency: currencySchema,
      expectedRoi: z.number().nullable(),
      expectedIrr: z.number().nullable(),
      entryLoad: z.number().nullable(),
      exitLoad: z.number().nullable(),
      lockInMonths: z.number().int().nullable(),
      minInvestment: z.number().nullable(),
      allotmentTerms: z.string().nullable(),
      paymentTerms: z.string().nullable(),
      notes: z.string().nullable(),
    }),
  }),
]);

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
  progressPercent: z.number(),
  opensAt: timestamp,
  closesAt: timestamp,
  /** As stored; the signing-window statuses are kept as OPEN until staff move the track on. */
  trackStatus,
  /** What members see (Closing Soon / Closed follow the dates). */
  effectiveStatus: trackStatus,
  isOpenForSigning: z.boolean(),
  createdAt: timestamp,
  updatedAt: timestamp,
  deletedAt: timestamp.nullable(),
});

const adminRepresentationDocument = z.object({
  id: uuid,
  title: z.string(),
  documentType: z.enum(REPRESENTATION_DOCUMENT_TYPES),
  bucket: z.string(),
  objectKey: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number().int(),
  scanStatus: z.enum(FILE_SCAN_STATUSES),
  statusHistoryId: z.number().int().nullable(),
  createdAt: timestamp,
});

/** Documents staff attach to a petition (already uploaded to representation-documents). */
const newRepresentationDocument = z.strictObject({
  documentType: z.enum(REPRESENTATION_DOCUMENT_TYPES),
  title: z.string(),
  objectKey: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number().int(),
});

const representationFields = z.strictObject({
  slug: z.string().optional(),
  title: z.string().optional(),
  description: z.string().optional(),
  asks: z.array(z.string()).optional(),
  whyItMatters: z.string().optional(),
  category: z.string().nullable().optional(),
  country: z.enum(MARKET_COUNTRIES).optional(),
  tags: z.array(z.string()).optional(),
  regulators: z.array(z.string()).optional(),
  goal: z.number().int().optional(),
  opensAt: z.string().optional(),
  closesAt: z.string().optional(),
});

const creditEntry = z.object({
  id: z.number().int(),
  userId: uuid,
  delta: z.number().int(),
  balanceAfter: z.number().int(),
  reason: creditReasonSchema,
  note: z.string().nullable(),
  createdAt: timestamp,
});

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
        // Sign-up steps 2-3 and the tier, validated by the database before anything is stored.
        onboarding: z
          .strictObject({
            profile: z
              .strictObject({
                experienceYears: z.number().int(),
                jobProfile: z.string(),
                otherJob: z.string().optional(),
                location: z.string(),
              })
              .optional(),
            preferences: z
              .strictObject({
                focus: z.array(z.string()),
                risk: z.array(z.string()),
                style: z.array(z.string()),
                sector: z.array(z.string()),
              })
              .optional(),
            tier: tier.optional(),
          })
          .optional(),
      }),
      p_email_challenge: storedCode,
      p_phone_challenge: storedCode,
      p_ctx: ctx,
    }),
    z.union([
      z.object({ signupId: uuid, expiresAt: timestamp }),
      z.object({ fields: z.record(z.string(), z.string()) }),
      // The email and/or phone already belong to an account: nothing was stored.
      z.object({ taken: z.object({ email: z.boolean(), phone: z.boolean() }) }),
    ]),
  ),
  // Sign-up step 1: which of the two addresses already belong to an account.
  app_contact_taken: fn(
    args({ p_email_hash: z.string(), p_phone_hash: z.string() }),
    z.object({ emailTaken: z.boolean(), phoneTaken: z.boolean() }),
  ),
  app_otp_start: fn(
    args({
      p_purpose: z.literal('PASSWORD_RESET'),
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
        purpose: z.enum(['SIGNUP', 'PASSWORD_RESET']),
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

  // Users and profile
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
        jobProfileCode: jobProfileSchema.nullable(),
        otherJob: z.string().nullable(),
        location: z.string().nullable(),
        avatarBucket: z.string().nullable(),
        avatarObjectKey: z.string().nullable(),
        followers: z.number().int(),
        following: z.number().int(),
        // The codes the user chose; the app shows its own labels for them.
        preferences: z.array(
          z.discriminatedUnion('type', [
            z.object({ type: z.literal(PREFERENCE_TYPES.focus), code: focusCodeSchema }),
            z.object({ type: z.literal(PREFERENCE_TYPES.risk), code: riskCodeSchema }),
            z.object({ type: z.literal(PREFERENCE_TYPES.style), code: styleCodeSchema }),
            z.object({ type: z.literal(PREFERENCE_TYPES.sector), code: sectorCodeSchema }),
          ]),
        ),
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
  // Admin: staff roles
  app_staff_roles: fn(args({ p_user_id: internalId }), z.array(staffRole)),
  app_admin_set_roles: fn(
    args({
      p_actor_id: internalId,
      p_user_public_id: uuid,
      p_roles: z.array(staffRole),
      p_ctx: ctx,
    }),
    z.union([
      z.object({ ok: z.literal(true), roles: z.array(staffRole) }),
      adminFailure(['NOT_FOUND', 'SELF_ACTION']),
    ]),
  ),

  // Admin: users
  app_admin_find_users: fn(
    args({
      p_q_pattern: z.string().nullable(),
      p_email_hash: z.string().nullable(),
      p_phone_hash: z.string().nullable(),
      p_tiers: z.array(tier).nullable(),
      p_kyc_statuses: z.array(kycStatus).nullable(),
      p_statuses: z.array(accountStatus).nullable(),
      p_staff_only: z.boolean(),
      p_limit: z.number().int(),
      p_offset: z.number().int(),
    }),
    page(
      z.object({
        id: uuid,
        name: z.string(),
        tier,
        requestedTier: verifiedTier.nullable(),
        kycStatus,
        status: accountStatus,
        creditBalance: z.number().int(),
        roles: z.array(staffRole),
        createdAt: timestamp,
        lastLoginAt: timestamp.nullable(),
      }),
    ),
  ),
  app_admin_get_user: fn(
    args({ p_actor_id: internalId, p_user_public_id: uuid, p_ctx: ctx }),
    z
      .object({
        id: uuid,
        emailEnc: z.string(),
        phoneEnc: z.string(),
        name: z.string(),
        experienceYears: z.number().int().nullable(),
        jobProfileCode: z.string().nullable(),
        otherJob: z.string().nullable(),
        location: z.string().nullable(),
        tier,
        requestedTier: verifiedTier.nullable(),
        kycStatus,
        status: accountStatus,
        creditBalance: z.number().int(),
        roles: z.array(staffRole),
        createdAt: timestamp,
        lastLoginAt: timestamp.nullable(),
        tierSelectedAt: timestamp.nullable(),
        activeSessions: z.number().int(),
        kyc: z
          .object({
            id: uuid,
            tier: verifiedTier,
            status: z.enum(KYC_SUBMISSION_STATUSES),
            reason: z.string().nullable(),
            submittedAt: timestamp,
            reviewedAt: timestamp.nullable(),
          })
          .nullable(),
        activity: z.object({
          reviews: z.number().int(),
          ratings: z.number().int(),
          signatures: z.number().int(),
          poolMemberships: z.number().int(),
          followers: z.number().int(),
          following: z.number().int(),
        }),
        tierHistory: z.array(
          z.object({
            fromTier: tier,
            toTier: tier,
            requestedTier: verifiedTier.nullable(),
            reason: z.string(),
            createdAt: timestamp,
          }),
        ),
      })
      .nullable(),
  ),
  app_admin_update_user: fn(
    args({
      p_actor_id: internalId,
      p_user_public_id: uuid,
      p_tier: tier.nullable(),
      p_status: z.enum(['ACTIVE', 'SUSPENDED']).nullable(),
      p_reason: z.string(),
      p_ctx: ctx,
    }),
    z.union([
      z.object({ ok: z.literal(true), user: userRef }),
      adminFailure(['NOT_FOUND', 'SELF_ACTION', 'USER_DELETED']),
    ]),
  ),

  // Admin: KYC
  app_admin_kyc_queue: fn(
    args({
      p_statuses: z.array(z.enum(KYC_SUBMISSION_STATUSES)).nullable(),
      p_tiers: z.array(verifiedTier).nullable(),
      p_oldest_first: z.boolean(),
      p_limit: z.number().int(),
      p_offset: z.number().int(),
    }),
    page(
      z.object({
        id: uuid,
        tier: verifiedTier,
        status: z.enum(KYC_SUBMISSION_STATUSES),
        provider: z.string(),
        submittedAt: timestamp,
        reviewedAt: timestamp.nullable(),
        user: userRef,
        documentCount: z.number().int(),
      }),
    ),
  ),
  app_admin_kyc_get: fn(
    args({ p_submission_id: uuid }),
    z
      .object({
        id: uuid,
        tier: verifiedTier,
        status: z.enum(KYC_SUBMISSION_STATUSES),
        provider: z.string(),
        reference: z.string().nullable(),
        reason: z.string().nullable(),
        submittedAt: timestamp,
        reviewedAt: timestamp.nullable(),
        user: userRef.extend({ requestedTier: verifiedTier.nullable() }),
        reviewer: userRef.nullable(),
        consent: z.object({ version: z.string(), acceptedAt: timestamp }).nullable(),
        documents: z.array(
          z.object({
            fileId: uuid,
            documentType: z.enum(KYC_DOCUMENT_TYPES),
            bucket: z.string(),
            objectKey: z.string(),
            mimeType: z.string(),
            sizeBytes: z.number().int(),
            scanStatus: z.enum(FILE_SCAN_STATUSES),
          }),
        ),
      })
      .nullable(),
  ),
  app_admin_kyc_decide: fn(
    args({
      p_actor_id: internalId,
      p_submission_id: uuid,
      p_decision: z.enum(['APPROVE', 'REJECT']),
      p_reason: z.string().nullable(),
      p_ctx: ctx,
    }),
    z.union([
      z.object({ ok: z.literal(true), status: z.enum(['APPROVED', 'REJECTED']), user: userRef }),
      adminFailure(['NOT_FOUND', 'SELF_ACTION', 'ALREADY_DECIDED']),
    ]),
  ),

  // Admin: moderation
  app_admin_moderation_queue: fn(
    args({
      p_types: z.array(z.enum(MODERATION_TYPES)).nullable(),
      p_statuses: z.array(z.string()).nullable(),
      p_limit: z.number().int(),
      p_offset: z.number().int(),
    }),
    page(moderationItem),
  ),
  app_admin_moderation_item: fn(
    args({ p_type: z.enum(MODERATION_TYPES), p_id: uuid }),
    moderationItem.nullable(),
  ),
  app_admin_moderate: fn(
    args({
      p_actor_id: internalId,
      p_type: z.enum(MODERATION_TYPES),
      p_id: uuid,
      p_decision: z.enum(MODERATION_DECISIONS),
      p_note: z.string().nullable(),
      p_ctx: ctx,
    }),
    z.union([
      z.object({
        ok: z.literal(true),
        type: z.enum(MODERATION_TYPES),
        id: uuid,
        status: z.string(),
        previousStatus: z.string(),
      }),
      adminFailure(['NOT_FOUND', 'SELF_ACTION', 'INVALID_TRANSITION']),
    ]),
  ),

  // Admin: representations
  app_admin_find_representations: fn(
    args({
      p_q_pattern: z.string().nullable(),
      p_statuses: z.array(trackStatus).nullable(),
      p_include_deleted: z.boolean(),
      p_limit: z.number().int(),
      p_offset: z.number().int(),
    }),
    page(adminRepresentation),
  ),
  app_admin_get_representation: fn(
    args({ p_public_id: uuid }),
    adminRepresentation
      .extend({
        documents: z.array(adminRepresentationDocument),
        history: z.array(
          z.object({
            id: z.number().int(),
            fromStatus: trackStatus.nullable(),
            toStatus: trackStatus,
            note: z.string().nullable(),
            actor: userRef.nullable(),
            occurredAt: timestamp,
          }),
        ),
      })
      .nullable(),
  ),
  app_admin_save_representation: fn(
    args({
      p_actor_id: internalId,
      p_public_id: uuid.nullable(),
      p_fields: representationFields,
      p_ctx: ctx,
    }),
    z.union([
      z.object({ ok: z.literal(true), id: uuid }),
      z.object({ fields: z.record(z.string(), z.string()) }),
      adminFailure(['NOT_FOUND']),
    ]),
  ),
  app_admin_delete_representation: fn(
    args({ p_actor_id: internalId, p_public_id: uuid, p_ctx: ctx }),
    z.boolean(),
  ),
  app_admin_representation_status: fn(
    args({
      p_actor_id: internalId,
      p_public_id: uuid,
      p_status: trackStatus,
      p_note: z.string().nullable(),
      p_documents: z.array(newRepresentationDocument),
      p_ctx: ctx,
    }),
    z.union([
      z.object({
        ok: z.literal(true),
        trackStatus,
        previousStatus: trackStatus,
        documents: z.array(adminRepresentationDocument),
      }),
      adminFailure(['NOT_FOUND', 'INVALID_TRANSITION']),
    ]),
  ),
  app_admin_add_representation_documents: fn(
    args({
      p_actor_id: internalId,
      p_public_id: uuid,
      p_documents: z.array(newRepresentationDocument),
      p_ctx: ctx,
    }),
    z.array(adminRepresentationDocument).nullable(),
  ),
  app_admin_representation_signatures: fn(
    args({
      p_public_id: uuid,
      p_include_removed: z.boolean(),
      p_limit: z.number().int(),
      p_offset: z.number().int(),
    }),
    page(
      z.object({
        id: uuid,
        signatureCode: z.string(),
        displayMode: z.enum(DISPLAY_MODES),
        signerName: z.string(),
        investorType: z.string().nullable(),
        signerTier: tier,
        weight: z.number().int(),
        status: z.enum(['VALID', 'REMOVED']),
        createdAt: timestamp,
        user: userRef,
      }),
    ).nullable(),
  ),
  app_admin_remove_signature: fn(
    args({
      p_actor_id: internalId,
      p_representation_id: uuid,
      p_signature_id: uuid,
      p_reason: z.string(),
      p_ctx: ctx,
    }),
    z.union([z.object({ ok: z.literal(true) }), adminFailure(['NOT_FOUND', 'ALREADY_REMOVED'])]),
  ),

  // Admin: roadshow Ask Me Anything
  app_admin_answer_question: fn(
    args({
      p_actor_id: internalId,
      p_roadshow_id: uuid,
      p_question_id: uuid,
      p_answer: z.string(),
      p_featured: z.boolean().nullable(),
      p_ctx: ctx,
    }),
    z.union([
      z.object({
        ok: z.literal(true),
        question: z.object({
          id: uuid,
          roadshowId: uuid,
          category: questionCategorySchema,
          question: z.string(),
          status: questionStatusSchema,
          featured: z.boolean(),
          answer: z.string(),
          answeredAt: timestamp,
          createdAt: timestamp,
        }),
      }),
      adminFailure(['NOT_FOUND', 'QUESTION_REJECTED']),
    ]),
  ),

  // Admin: credits
  app_admin_credit_change: fn(
    args({
      p_actor_id: internalId,
      p_user_public_id: uuid,
      p_delta: z.number().int(),
      p_note: z.string(),
      p_idempotency_key: z.string(),
      p_request_hash: z.string(),
      p_ctx: ctx,
    }),
    z.union([
      z.object({ ok: z.literal(true), entry: creditEntry, replayed: z.boolean() }),
      adminFailure(['NOT_FOUND', 'SELF_ACTION', 'INSUFFICIENT_CREDITS', 'IDEMPOTENCY_CONFLICT']),
    ]),
  ),

  // Admin: audit trail
  app_admin_audit_logs: fn(
    args({
      p_actions: z.array(z.string()).nullable(),
      p_action_prefix: z.string().nullable(),
      p_actor_public_id: uuid.nullable(),
      p_from: z.string().nullable(),
      p_to: z.string().nullable(),
      p_limit: z.number().int(),
      p_offset: z.number().int(),
    }),
    page(
      z.object({
        id: internalId,
        occurredAt: timestamp,
        action: z.string(),
        actor: userRef.nullable(),
        ip: z.string().nullable(),
        userAgent: z.string().nullable(),
        requestId: z.string().nullable(),
        metadata: z.record(z.string(), z.unknown()),
      }),
    ),
  ),
};

export type DbFunction = keyof typeof DB_FUNCTIONS;

/**
 * Functions that only read (declared stable in SQL). A network failure while calling one of these is
 * retried, since running it again cannot change anything; every other failure is reported, never
 * retried. test/db/db_contract.db.test.ts keeps this list in step with the SQL.
 */
export const READ_ONLY_DB_FUNCTIONS: ReadonlySet<DbFunction> = new Set<DbFunction>([
  'app_contact_taken',
  'app_admin_audit_logs',
  'app_admin_find_representations',
  'app_admin_find_users',
  'app_admin_get_representation',
  'app_admin_kyc_get',
  'app_admin_kyc_queue',
  'app_admin_moderation_item',
  'app_admin_moderation_queue',
  'app_admin_representation_signatures',
  'app_find_issuer',
  'app_find_issuers',
  'app_find_owned_files',
  'app_find_representation',
  'app_find_representations',
  'app_get_user',
  'app_issuer_stats',
  'app_list_options',
  'app_login_lookup',
  'app_member',
  'app_otp_peek',
  'app_ping',
  'app_rating_by_idempotency_key',
  'app_rating_own',
  'app_representation_evidence',
  'app_representation_history',
  'app_representation_signature',
  'app_representation_signers',
  'app_representation_submission_pack',
  'app_reset_lookup',
  'app_signature_by_idempotency_key',
  'app_staff_roles',
]);

export type DbArgs<F extends DbFunction> = z.input<(typeof DB_FUNCTIONS)[F]['args']>;
export type DbResult<F extends DbFunction> = z.output<(typeof DB_FUNCTIONS)[F]['result']>;
