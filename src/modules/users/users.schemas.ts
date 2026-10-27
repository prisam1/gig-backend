import { z } from 'zod';
import { TIERS } from '../../types/domain';

/** Job profile code that means "not in the list"; the user types it into `otherJob`. */
export const OTHER_JOB_PROFILE = 'OTHERS';

export const updateProfileSchema = z
  .strictObject({
    name: z.string().trim().min(4, 'Name must be at least 4 characters').max(100),
    experience: z.string().trim().min(1).max(50),
    jobProfile: z.string().trim().min(1).max(50),
    otherJob: z.string().trim().min(1).max(100),
    location: z.string().trim().min(1).max(100),
    avatarFileId: z.uuid('Invalid file ID'),
  })
  .partial()
  .refine((input) => Object.keys(input).length > 0, 'Provide at least one field to update')
  .refine((input) => input.jobProfile !== OTHER_JOB_PROFILE || input.otherJob, {
    path: ['otherJob'],
    message: 'Describe your job profile when choosing Others',
  });

export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;

const optionCodes = (label: string) =>
  z
    .array(z.string().trim().min(1))
    .min(1, `Choose at least 1 ${label}`)
    .max(3, `Choose up to 3 ${label}`)
    .refine((codes) => new Set(codes).size === codes.length, `Each ${label} can be chosen once`);

export const preferencesSchema = z.strictObject({
  focus: z.string().trim().min(1),
  risk: z.string().trim().min(1),
  styles: optionCodes('styles'),
  sectors: optionCodes('sectors'),
});

export type PreferencesInput = z.infer<typeof preferencesSchema>;

export const chooseTierSchema = z.strictObject({
  tier: z.enum(TIERS),
});

export const userIdParamSchema = z.object({
  id: z.uuid('Invalid user ID'),
});
