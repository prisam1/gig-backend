import { z } from 'zod';
import { nameSchema } from '../auth/auth.schemas';

const optionCode = z.string().regex(/^[A-Z0-9_]{1,64}$/, 'Invalid option');

const unique = (values: string[]) => new Set(values).size === values.length;

// Sign-up step 2 (and later profile edits). Every field is optional, but at least one is required.
export const updateMeSchema = z
  .object({
    name: nameSchema.optional(),
    experienceYears: z
      .union([z.number(), z.string().trim().regex(/^\d{1,2}$/, 'Experience must be a number of years')])
      .transform(Number)
      .pipe(z.number().int('Experience must be whole years').min(0).max(80, 'Experience must be 80 years or less'))
      .optional(),
    jobProfile: optionCode.optional(),
    otherJob: z.string().trim().min(1, 'Specify your job profile').max(100).optional(),
    location: z.string().trim().min(1, 'Location is required').max(120).optional(),
    // From POST /files/upload-url with purpose AVATAR.
    avatarFileId: z.uuid('Invalid file ID').optional(),
  })
  .strict()
  .refine((body) => Object.keys(body).length > 0, 'Nothing to update');

// Sign-up step 3. Limits match the app: 1 focus, 1 risk level, up to 3 styles, up to 3 sectors.
export const preferencesSchema = z
  .object({
    focus: z.array(optionCode).length(1, 'Select an investment focus'),
    risk: z.array(optionCode).length(1, 'Select a risk level'),
    style: z
      .array(optionCode)
      .min(1, 'Select at least one investment style')
      .max(3, 'Select up to 3 investment styles')
      .refine(unique, 'Each style can be selected once'),
    sector: z
      .array(optionCode)
      .min(1, 'Select at least one investment sector')
      .max(3, 'Select up to 3 investment sectors')
      .refine(unique, 'Each sector can be selected once'),
  })
  .strict();

export const tierSchema = z
  .object({ tier: z.enum(['OBSERVER', 'PRIVE', 'INSTITUTIONAL'], 'Choose Observer, Prive or Institutional') })
  .strict();

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
