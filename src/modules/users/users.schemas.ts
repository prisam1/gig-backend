import { z } from 'zod';
import { nameSchema } from '../auth/auth.schemas';
import { experienceYearsSchema, jobProfileSchema, locationSchema, otherJobSchema } from './onboarding.schemas';

// Profile edits. Every field is optional, but at least one is required.
export const updateMeSchema = z
  .object({
    name: nameSchema.optional(),
    experienceYears: experienceYearsSchema.optional(),
    jobProfile: jobProfileSchema.optional(),
    otherJob: otherJobSchema.optional(),
    location: locationSchema.optional(),
    // From POST /files/upload-url with purpose AVATAR.
    avatarFileId: z.uuid('Invalid file ID').optional(),
  })
  .strict()
  .refine((body) => Object.keys(body).length > 0, 'Nothing to update');

// The sign-up choices are fixed in the app (src/constants/onboarding.ts), so they are not served here.
export const LOOKUP_TYPES = {
  // Ratings: the rating wizard's factors and risks. Representations: the signing flow.
  'rating-factors': 'RATING_FACTOR',
  'risk-factors': 'RISK_FACTOR',
  'investor-types': 'INVESTOR_TYPE',
} as const;
export type LookupType = (typeof LOOKUP_TYPES)[keyof typeof LOOKUP_TYPES];
