import { z } from 'zod';
import { nameSchema } from '../auth/auth.schemas';
import {
  experienceYearsSchema,
  locationSchema,
  optionCode,
  otherJobSchema,
  PREFERENCE_TYPES,
  preferencesSchema,
  tierChoiceSchema,
} from './onboarding.schemas';

// Sign-up step 2 (and later profile edits). Every field is optional, but at least one is required.
export const updateMeSchema = z
  .object({
    name: nameSchema.optional(),
    experienceYears: experienceYearsSchema.optional(),
    jobProfile: optionCode.optional(),
    otherJob: otherJobSchema.optional(),
    location: locationSchema.optional(),
    // From POST /files/upload-url with purpose AVATAR.
    avatarFileId: z.uuid('Invalid file ID').optional(),
  })
  .strict()
  .refine((body) => Object.keys(body).length > 0, 'Nothing to update');

export { PREFERENCE_TYPES, preferencesSchema };

export const tierSchema = z.object({ tier: tierChoiceSchema }).strict();

export const userIdParamSchema = z.object({ id: z.uuid('Invalid user ID') });

export const LOOKUP_TYPES = {
  'job-profiles': 'JOB_PROFILE',
  'investment-focus': 'INVESTMENT_FOCUS',
  'risk-levels': 'RISK_LEVEL',
  'investment-styles': 'INVESTMENT_STYLE',
  'investment-sectors': 'INVESTMENT_SECTOR',
  // Ratings: the rating wizard's factors and risks. Representations: the signing flow.
  'rating-factors': 'RATING_FACTOR',
  'risk-factors': 'RISK_FACTOR',
  'investor-types': 'INVESTOR_TYPE',
} as const;
export type LookupType = (typeof LOOKUP_TYPES)[keyof typeof LOOKUP_TYPES];
