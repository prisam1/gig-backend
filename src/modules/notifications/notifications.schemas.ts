import { z } from 'zod';
import { devicePlatformSchema, uuidSchema } from '../../lib/enums';
import { pagination } from '../../lib/http';

// GET /me/notifications?unread=true&page=&pageSize=
export const listNotificationsQuery = z.object({
  ...pagination,
  unread: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
});
export type ListNotificationsQuery = z.output<typeof listNotificationsQuery>;

// POST /me/notifications/read { ids?: [...] } — omit `ids` to mark everything read.
export const markReadBody = z.object({
  ids: z.array(uuidSchema).min(1).max(100).optional(),
});

// POST /me/devices
export const registerDeviceBody = z.object({
  token: z
    .string({ message: 'Push token is required' })
    .trim()
    .min(16, { message: 'Invalid push token' })
    .max(4096, { message: 'Invalid push token' }),
  platform: devicePlatformSchema,
  appVersion: z.string().trim().max(40).optional(),
});
export type RegisterDeviceInput = z.output<typeof registerDeviceBody>;
