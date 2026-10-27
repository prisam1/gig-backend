import type { PageMeta } from '../../lib/http';
import { fetchPage, supabaseAdmin, unwrap } from '../../lib/supabase';
import type { Enums, Json, Tables } from '../../types/database';
import type { AuthUser } from '../../middleware/auth';
import type { ListNotificationsQuery, RegisterDeviceInput } from './notifications.schemas';

export interface Notification {
  id: string;
  type: Enums<'notification_type'>;
  title: string;
  body: string;
  /** Deep-link payload, e.g. { "roadshowId": "..." }. */
  data: Json;
  readAt: string | null;
  createdAt: string;
}

export interface InboxMeta extends PageMeta {
  /** Unread notifications in the whole inbox, for the app badge. */
  unread: number;
}

export interface RegisteredDevice {
  platform: Enums<'device_platform'>;
  registeredAt: string;
}

function toNotification(row: Tables<'notifications'>): Notification {
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    body: row.body,
    data: row.data,
    readAt: row.read_at,
    createdAt: row.created_at,
  };
}

async function countUnread(user: AuthUser): Promise<number> {
  const result = await supabaseAdmin
    .from('notifications')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', user.id)
    .is('read_at', null);
  unwrap(result);
  return result.count ?? 0;
}

/** The inbox, newest first. */
export async function listNotifications(
  user: AuthUser,
  query: ListNotificationsQuery,
): Promise<{ items: Notification[]; meta: InboxMeta }> {
  const build = (head: boolean) => {
    const q = supabaseAdmin
      .from('notifications')
      .select('*', { count: 'exact', head })
      .eq('user_id', user.id);
    return query.unread ? q.is('read_at', null) : q;
  };

  const [{ rows, meta }, unread] = await Promise.all([
    fetchPage(query, {
      rows: (from, to) =>
        build(false).order('created_at', { ascending: false }).order('id').range(from, to),
      count: () => build(true),
    }),
    countUnread(user),
  ]);
  return { items: rows.map(toNotification), meta: { ...meta, unread } };
}

/** Marks the given notifications (or all of them) read. Returns how many changed. */
export async function markRead(user: AuthUser, ids: string[] | undefined): Promise<number> {
  let q = supabaseAdmin
    .from('notifications')
    .update({ read_at: new Date().toISOString() })
    .eq('user_id', user.id)
    .is('read_at', null);
  if (ids) q = q.in('id', ids);
  const updated = unwrap(await q.select('id'));
  return updated.length;
}

/** Registers a push token for the signed-in user; a token seen before moves to this user. */
export async function registerDevice(
  user: AuthUser,
  input: RegisterDeviceInput,
): Promise<RegisteredDevice> {
  const row = unwrap(
    await supabaseAdmin
      .from('device_tokens')
      .upsert(
        {
          token: input.token,
          user_id: user.id,
          platform: input.platform,
          app_version: input.appVersion ?? null,
          last_seen_at: new Date().toISOString(),
        },
        { onConflict: 'token' },
      )
      .select('platform, last_seen_at')
      .single(),
  );
  return { platform: row.platform, registeredAt: row.last_seen_at };
}
