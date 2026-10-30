import { z } from 'zod';
import { preferencesSchema, signupProfileSchema, tierChoiceSchema } from '../users/onboarding.schemas';

// Field rules mirror the app's validators (src/utils/AuthValidation.ts) and reuse its messages.

// Letters (any script), spaces and . ' - only; 4-100 characters after trimming.
export const nameSchema = z
  .string('Name is required')
  .trim()
  .min(4, 'Name must be at least 4 characters long')
  .max(100, 'Name must be at most 100 characters long')
  .regex(/^[\p{L}\p{M}][\p{L}\p{M} .'-]*$/u, 'Name can only contain letters, spaces, . \' and -');

export const emailSchema = z
  .string('Email is required')
  .trim()
  .toLowerCase()
  .max(254, 'Email is too long')
  .pipe(z.email('Email must contain @'));

export const COUNTRY_CODES = ['+91', '+971'] as const;
export type CountryCode = (typeof COUNTRY_CODES)[number];

// National number rules per launch market. India: 10 digits starting 6-9. UAE: 9 digits starting
// 5 (a leading 0 is accepted and dropped).
const PHONE_RULES: Record<CountryCode, { pattern: RegExp; message: string }> = {
  '+91': { pattern: /^[6-9]\d{9}$/, message: 'Phone number must be exactly 10 digits' },
  '+971': { pattern: /^0?5\d{8}$/, message: 'Phone number must be 9 digits starting with 5' },
};

export function normalizePhone(countryCode: CountryCode, phone: string): string | null {
  const digits = phone.trim();
  if (!PHONE_RULES[countryCode].pattern.test(digits)) return null;
  return `${countryCode}${digits.replace(/^0/, '')}`;
}

const PASSWORD_MESSAGE =
  'Password must be at least 8 characters and include capital, small, number, and special character';

export const passwordSchema = z
  .string('Password is required')
  .min(8, PASSWORD_MESSAGE)
  // Upper bound keeps hashing cost predictable.
  .max(128, 'Password must be at most 128 characters long')
  .regex(/[a-z]/, PASSWORD_MESSAGE)
  .regex(/[A-Z]/, PASSWORD_MESSAGE)
  .regex(/\d/, PASSWORD_MESSAGE)
  .regex(/[\W_]/, PASSWORD_MESSAGE);

// Rejects passwords built from the user's own email name or phone number.
export function passwordContainsIdentity(password: string, email: string, phoneE164: string): boolean {
  const lower = password.toLowerCase();
  const local = email.split('@')[0] ?? '';
  const national = phoneE164.replace(/^\+(91|971)/, '');
  return (local.length >= 4 && lower.includes(local)) || lower.includes(national);
}

// Login / reset identifier: an email, or a phone in E.164 form (+919876543210).
export type Identifier =
  | { channel: 'EMAIL'; value: string }
  | { channel: 'PHONE'; value: string; countryCode: CountryCode };

export const identifierSchema = z
  .string('Email or phone is required')
  .trim()
  .min(1, 'Email or phone is required')
  .max(254)
  .transform((raw, ctx): Identifier => {
    if (raw.includes('@')) {
      const email = emailSchema.safeParse(raw);
      if (email.success) return { channel: 'EMAIL', value: email.data };
    } else {
      const code = COUNTRY_CODES.find((c) => raw.startsWith(c));
      const phone = code && normalizePhone(code, raw.slice(code.length));
      if (code && phone) return { channel: 'PHONE', value: phone, countryCode: code };
    }
    ctx.addIssue({ code: 'custom', message: 'Enter a valid email, or a phone number with country code' });
    return z.NEVER;
  });

export const DEVICE_PLATFORMS = ['IOS', 'ANDROID', 'WEB', 'OTHER'] as const;

export const deviceSchema = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    platform: z.enum(DEVICE_PLATFORMS).default('OTHER'),
  })
  .strict()
  .default({ platform: 'OTHER' });
export type DeviceInfo = z.infer<typeof deviceSchema>;

export const registerSchema = z
  .object({
    name: nameSchema,
    email: emailSchema,
    countryCode: z.enum(COUNTRY_CODES, 'Unsupported country code').default('+91'),
    phone: z.string('Phone number is required').trim(),
    password: passwordSchema,
    ageConfirmed: z.literal(true, 'You must confirm you are 18 years of age or older'),
    // Sign-up steps 2-3 and the tier: the app sends everything from its tier screen, before the
    // OTP screen. Stored with the pending sign-up and applied when the account is created.
    profile: signupProfileSchema,
    preferences: preferencesSchema,
    tier: tierChoiceSchema,
  })
  .strict()
  .transform((body, ctx) => {
    const phone = normalizePhone(body.countryCode, body.phone);
    if (!phone) {
      ctx.addIssue({ code: 'custom', path: ['phone'], message: PHONE_RULES[body.countryCode].message });
      return z.NEVER;
    }
    if (passwordContainsIdentity(body.password, body.email, phone)) {
      ctx.addIssue({
        code: 'custom',
        path: ['password'],
        message: 'Password must not contain your email name or phone number',
      });
      return z.NEVER;
    }
    return { ...body, phone };
  });

const otpCodeSchema = z.string('Code is required').regex(/^\d{4}$/, 'Code must be 4 digits');

export const otpVerifySchema = z
  .object({ challengeId: z.uuid('Invalid challenge'), code: otpCodeSchema, device: deviceSchema })
  .strict();

// Resend the code of an existing challenge (sign-up or password reset).
export const otpSendSchema = z.object({ challengeId: z.uuid('Invalid challenge') }).strict();

export const loginSchema = z
  .object({
    identifier: identifierSchema,
    password: z.string('Password is required').min(1, 'Password is required').max(128),
    device: deviceSchema,
  })
  .strict();

export const refreshSchema = z
  .object({ refreshToken: z.string('Refresh token is required').min(1).max(200) })
  .strict();

export const forgotPasswordSchema = z.object({ identifier: identifierSchema }).strict();

export const resetPasswordSchema = z
  .object({ resetToken: z.string('Reset token is required').min(1).max(200), newPassword: passwordSchema })
  .strict();
