import { z } from 'zod';
import { nameSchema } from '../auth/auth.schemas';
import { experienceYearsSchema, locationSchema, optionCode, otherJobSchema } from './onboarding.schemas';

// Profile edits. Every field is optional, but at least one is required.
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

export const LOOKUP_TYPES = {
  // Sign-up: phone country code (step 1), job profile (step 2), preferences (step 3), tier.
  'country-codes': 'COUNTRY_CODE',
  'job-profiles': 'JOB_PROFILE',
  'investment-focus': 'INVESTMENT_FOCUS',
  'risk-levels': 'RISK_LEVEL',
  'investment-styles': 'INVESTMENT_STYLE',
  'investment-sectors': 'INVESTMENT_SECTOR',
  tiers: 'TIER',
  // Ratings: the rating wizard's factors and risks. Representations: the signing flow.
  'rating-factors': 'RATING_FACTOR',
  'risk-factors': 'RISK_FACTOR',
  'investor-types': 'INVESTOR_TYPE',
} as const;
export type LookupType = (typeof LOOKUP_TYPES)[keyof typeof LOOKUP_TYPES];
