import { z } from 'zod';
import { TIERS } from '../../lib/membership';

// Sign-up steps 2-3 and the tier. Shared by POST /auth/register (when the app sends them before the
// OTP screen) and the /me endpoints (when they are filled in or changed after sign-up), so both
// apply the same rules. Option codes come from GET /lookups/:type.

export const optionCode = z.string().regex(/^[A-Z0-9_]{1,64}$/, 'Invalid option');

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
    jobProfile: optionCode,
    otherJob: otherJobSchema.optional(),
    location: locationSchema,
  })
  .strict();

// Step 3. Limits match the app: 1 focus, 1 risk level, up to 3 styles, up to 3 sectors.
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

export const tierChoiceSchema = z.enum(TIERS, 'Choose Observer, Prive or Institutional');

/** The four sign-up preference lists (lookup option types). */
export const PREFERENCE_TYPES = ['INVESTMENT_FOCUS', 'RISK_LEVEL', 'INVESTMENT_STYLE', 'INVESTMENT_SECTOR'] as const;
