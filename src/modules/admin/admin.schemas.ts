import { z } from 'zod';
import { uuidSchema } from '../../lib/enums';
import { csv, pagination } from '../../lib/http';
import { KYC_STATUSES, TIERS } from '../../lib/membership';
import {
  ACCOUNT_STATUSES,
  KYC_SUBMISSION_STATUSES,
  MODERATION_DECISIONS,
  MODERATION_QUEUE_STATUSES,
  MODERATION_TYPES,
  STAFF_ROLES,
  type ModerationDecision,
  type ModerationType,
} from '../../types/domain';

// ---------------------------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------------------------

export const idParams = z.strictObject({ id: uuidSchema });

export const booleanFlag = z.enum(['true', 'false']).transform((v) => v === 'true');

/** Why a staff member made a change: kept in the audit log and, where it applies, shown to the member. */
export const reasonSchema = z
  .string({ message: 'Give a reason' })
  .trim()
  .min(5, { message: 'Reason must be at least 5 characters' })
  .max(500, { message: 'Reason must be at most 500 characters' });

const unique = (list: readonly unknown[]) => new Set(list).size === list.length;

// ---------------------------------------------------------------------------------------------
// Users and staff roles
// ---------------------------------------------------------------------------------------------

// GET /admin/users?q=&filter[tier]=PRIVE&filter[kycStatus]=PENDING&filter[status]=SUSPENDED&filter[staff]=true
export const listUsersQuery = z.object({
  ...pagination,
  /** An exact email or phone (+91…, +971…), or part of a name. */
  q: z.string().trim().min(1).max(254).optional(),
  filter: z
    .strictObject({
      tier: csv(z.enum(TIERS)).optional(),
      kycStatus: csv(z.enum(KYC_STATUSES)).optional(),
      status: csv(z.enum(ACCOUNT_STATUSES)).optional(),
      staff: booleanFlag.optional(),
    })
    .optional(),
});
export type ListUsersQuery = z.output<typeof listUsersQuery>;

export const updateUserBody = z
  .strictObject({
    tier: z.enum(TIERS).optional(),
    /** DELETED is reserved for account deletion requests. */
    status: z.enum(['ACTIVE', 'SUSPENDED']).optional(),
    reason: reasonSchema,
  })
  .refine((body) => body.tier !== undefined || body.status !== undefined, {
    message: 'Change the tier or the status',
  });
export type UpdateUserInput = z.output<typeof updateUserBody>;

export const setRolesBody = z.strictObject({
  /** The complete set of roles; [] removes staff access. */
  roles: z
    .array(z.enum(STAFF_ROLES))
    .max(STAFF_ROLES.length)
    .refine(unique, { message: 'Each role can be given once' }),
});

// ---------------------------------------------------------------------------------------------
// KYC
// ---------------------------------------------------------------------------------------------

// GET /admin/kyc?filter[status]=PENDING&filter[tier]=PRIVE&sort=oldest
export const listKycQuery = z.object({
  ...pagination,
  /** oldest first works the queue in order of arrival. */
  sort: z.enum(['oldest', 'newest']).default('oldest'),
  filter: z
    .strictObject({
      /** Defaults to PENDING. */
      status: csv(z.enum(KYC_SUBMISSION_STATUSES)).optional(),
      tier: csv(z.enum(['PRIVE', 'INSTITUTIONAL'])).optional(),
    })
    .optional(),
});
export type ListKycQuery = z.output<typeof listKycQuery>;

export const rejectKycBody = z.strictObject({
  /** Shown to the member in their inbox and on GET /kyc/submissions/me. */
  reason: reasonSchema,
});

// ---------------------------------------------------------------------------------------------
// Moderation
// ---------------------------------------------------------------------------------------------

/** Which decisions exist for each kind of item (the database also checks the item's status). */
export const DECISIONS_BY_TYPE: Record<ModerationType, readonly ModerationDecision[]> = {
  REVIEW: MODERATION_DECISIONS,
  RATING: MODERATION_DECISIONS,
  QUESTION: ['APPROVE', 'REJECT', 'REMOVE'],
  OFFER: ['APPROVE', 'REJECT', 'REMOVE'],
};

// GET /admin/moderation/queue?filter[type]=REVIEW,RATING&filter[status]=PENDING
export const moderationQueueQuery = z.object({
  ...pagination,
  filter: z
    .strictObject({
      type: csv(z.enum(MODERATION_TYPES)).optional(),
      /** Defaults to PENDING. */
      status: csv(z.enum(MODERATION_QUEUE_STATUSES)).optional(),
    })
    .optional(),
});
export type ModerationQueueQuery = z.output<typeof moderationQueueQuery>;

export const moderationItemQuery = z.strictObject({ type: z.enum(MODERATION_TYPES) });

export const moderationDecisionBody = z
  .strictObject({
    type: z.enum(MODERATION_TYPES),
    decision: z.enum(MODERATION_DECISIONS),
    /** Sent to the author. Required unless the item is approved. */
    note: z
      .string()
      .trim()
      .min(1)
      .max(2000, { message: 'Note must be at most 2000 characters' })
      .optional(),
  })
  .superRefine((body, ctx) => {
    if (!DECISIONS_BY_TYPE[body.type].includes(body.decision)) {
      ctx.addIssue({
        code: 'custom',
        path: ['decision'],
        message: `${body.decision} does not apply to a ${body.type.toLowerCase()}`,
      });
    }
    if (body.decision !== 'APPROVE' && body.note === undefined) {
      ctx.addIssue({ code: 'custom', path: ['note'], message: 'Tell the author why' });
    }
  });
export type ModerationDecisionInput = z.output<typeof moderationDecisionBody>;

// ---------------------------------------------------------------------------------------------
// Credits
// ---------------------------------------------------------------------------------------------

export const MAX_CREDIT_CHANGE = 10_000;

export const creditChangeBody = z.strictObject({
  userId: uuidSchema,
  /** Positive to grant, negative to revoke. */
  delta: z
    .number({ message: 'Delta must be a whole number' })
    .int({ message: 'Delta must be a whole number' })
    .min(-MAX_CREDIT_CHANGE, { message: `At most ${MAX_CREDIT_CHANGE} credits at once` })
    .max(MAX_CREDIT_CHANGE, { message: `At most ${MAX_CREDIT_CHANGE} credits at once` })
    .refine((delta) => delta !== 0, { message: 'Delta cannot be 0' }),
  /** Shown on the member's ledger. */
  note: z
    .string({ message: 'Add a note for the ledger' })
    .trim()
    .min(3, { message: 'Note must be at least 3 characters' })
    .max(400, { message: 'Note must be at most 400 characters' }),
});
export type CreditChangeInput = z.output<typeof creditChangeBody>;

// ---------------------------------------------------------------------------------------------
// Audit trail
// ---------------------------------------------------------------------------------------------

const actionName = z.string().regex(/^[a-z0-9_.]{1,100}$/, { message: 'Unknown action' });
const instant = z.iso.datetime({ offset: true, message: 'Use an ISO 8601 date-time' });

// GET /admin/audit-logs?filter[actionPrefix]=admin.kyc.&filter[actorId]=&filter[from]=&filter[to]=
export const auditLogsQuery = z.object({
  ...pagination,
  filter: z
    .strictObject({
      action: csv(actionName).optional(),
      actionPrefix: actionName.optional(),
      actorId: uuidSchema.optional(),
      from: instant.optional(),
      to: instant.optional(),
    })
    .refine((f) => !f.from || !f.to || new Date(f.from) < new Date(f.to), {
      path: ['to'],
      message: 'Must be after from',
    })
    .optional(),
});
export type AuditLogsQuery = z.output<typeof auditLogsQuery>;

// ---------------------------------------------------------------------------------------------
// Staff uploads
// ---------------------------------------------------------------------------------------------

export const UPLOAD_TARGETS = [
  'REPRESENTATION_DOCUMENT',
  'ROADSHOW_DOCUMENT',
  'LEARN_REPORT',
] as const;
export type UploadTarget = (typeof UPLOAD_TARGETS)[number];

export const UPLOAD_MIME_TYPES = ['application/pdf', 'image/jpeg', 'image/png'] as const;
export type UploadMimeType = (typeof UPLOAD_MIME_TYPES)[number];

export const uploadUrlBody = z.strictObject({
  target: z.enum(UPLOAD_TARGETS),
  mimeType: z.enum(UPLOAD_MIME_TYPES, { message: 'Upload a PDF, JPG or PNG file' }),
  sizeBytes: z.number().int().positive({ message: 'File is empty' }),
});
export type UploadUrlInput = z.output<typeof uploadUrlBody>;

/** Where staff uploads land: staff/<uuid>.<ext>. */
export const STAFF_OBJECT_KEY = /^staff\/[0-9a-f-]{36}\.(pdf|jpg|png)$/;
export const staffObjectKey = z.string().regex(STAFF_OBJECT_KEY, {
  message: 'Upload the file with POST /admin/uploads first and send its path',
});
