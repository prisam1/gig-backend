import { z } from 'zod';
import { TIERS } from '../../lib/membership';
import {
  INVESTMENT_FOCUS_CODES,
  INVESTMENT_SECTOR_CODES,
  INVESTMENT_STYLE_CODES,
  JOB_PROFILE_CODES,
  OTHER_JOB_PROFILE,
  RISK_LEVEL_CODES,
} from '../../constants/onboarding';

// Sign-up steps 2-3 and the tier. Shared by POST /auth/register (when the app sends them before the
// OTP screen) and the /me endpoints (when they are filled in or changed after sign-up), so both
// apply the same rules. Every choice must be one of the app's fixed options (src/constants/onboarding.ts).

export const jobProfileSchema = z.enum(JOB_PROFILE_CODES, 'Choose a job profile from the list');
export const focusCodeSchema = z.enum(INVESTMENT_FOCUS_CODES, 'Choose an investment focus from the list');
export const riskCodeSchema = z.enum(RISK_LEVEL_CODES, 'Choose a risk level from the list');
export const styleCodeSchema = z.enum(INVESTMENT_STYLE_CODES, 'Choose investment styles from the list');
export const sectorCodeSchema = z.enum(INVESTMENT_SECTOR_CODES, 'Choose investment sectors from the list');

const unique = (values: string[]) => new Set(values).size === values.length;

export const experienceYearsSchema = z
  .union([z.number(), z.string().trim().regex(/^\d{1,2}$/, 'Experience must be a number of years')])
  .transform(Number)
  .pipe(z.number().int('Experience must be whole years').min(0).max(80, 'Experience must be 80 years or less'));

export const otherJobSchema = z.string().trim().min(1, 'Specify your job profile').max(100);
export const locationSchema = z.string().trim().min(1, 'Location is required').max(120);

/** Step 2 as one complete set (registration). `otherJob` only with job profile OTHERS. */
export const signupProfileSchema = z
  .object({
    experienceYears: experienceYearsSchema,
    jobProfile: jobProfileSchema,
    otherJob: otherJobSchema.optional(),
    location: locationSchema,
  })
  .strict()
  .superRefine((profile, ctx) => {
    if (profile.jobProfile === OTHER_JOB_PROFILE && profile.otherJob === undefined) {
      ctx.addIssue({ code: 'custom', path: ['otherJob'], message: 'Specify your job profile' });
    }
    if (profile.jobProfile !== OTHER_JOB_PROFILE && profile.otherJob !== undefined) {
      ctx.addIssue({ code: 'custom', path: ['otherJob'], message: 'Only for the job profile Others' });
    }
  });

// Step 3. Limits match the app: 1 focus, 1 risk level, up to 3 styles, up to 3 sectors.
export const preferencesSchema = z
  .object({
    focus: z.array(focusCodeSchema).length(1, 'Select an investment focus'),
    risk: z.array(riskCodeSchema).length(1, 'Select a risk level'),
    style: z
      .array(styleCodeSchema)
      .min(1, 'Select at least one investment style')
      .max(3, 'Select up to 3 investment styles')
      .refine(unique, 'Each style can be selected once'),
    sector: z
      .array(sectorCodeSchema)
      .min(1, 'Select at least one investment sector')
      .max(3, 'Select up to 3 investment sectors')
      .refine(unique, 'Each sector can be selected once'),
  })
  .strict();

export const tierChoiceSchema = z.enum(TIERS, 'Choose Observer, Prive or Institutional');
