import type { PageMeta } from '../../lib/http';
import { hasFullAccess } from '../../lib/membership';
import { fetchPage, supabaseAdmin, unwrap } from '../../lib/supabase';
import { HttpError } from '../../middleware/errorHandler';
import type { Enums, Tables } from '../../types/database';
import type { User } from '../users/users.repository';
import type { ListWebinarsQuery } from './webinars.schemas';

export interface Webinar {
  id: string;
  title: string;
  description: string | null;
  hostName: string | null;
  startsAt: string;
  endsAt: string;
  access: Enums<'content_access'>;
  /** PREMIUM webinar and the member is not verified Prive or Institutional. */
  locked: boolean;
  registered: boolean;
  /** For registered members until the webinar ends. */
  joinUrl: string | null;
  recordingUrl: string | null;
  /** When an Observer's delayed recording becomes available; null when not applicable. */
  recordingAvailableAt: string | null;
}

export interface WebinarRegistration {
  webinarId: string;
  registeredAt: string;
  joinUrl: string | null;
}

type WebinarRow = Tables<'webinars'>;

const hasEnded = (row: Pick<WebinarRow, 'ends_at'>, now: number) => Date.parse(row.ends_at) <= now;

/** Full members see recordings at once; Observers once `observer_recording_at` has passed. */
function recordingFor(
  row: WebinarRow,
  fullAccess: boolean,
  now: number,
): Pick<Webinar, 'recordingUrl' | 'recordingAvailableAt'> {
  if (row.recording_url === null) return { recordingUrl: null, recordingAvailableAt: null };
  if (fullAccess) return { recordingUrl: row.recording_url, recordingAvailableAt: null };
  if (row.observer_recording_at === null) return { recordingUrl: null, recordingAvailableAt: null };
  const released = Date.parse(row.observer_recording_at) <= now;
  return {
    recordingUrl: released ? row.recording_url : null,
    recordingAvailableAt: row.observer_recording_at,
  };
}

function toWebinar(row: WebinarRow, user: User, registered: boolean, now: number): Webinar {
  const fullAccess = hasFullAccess(user);
  const locked = row.access === 'PREMIUM' && !fullAccess;
  const recording = locked
    ? { recordingUrl: null, recordingAvailableAt: null }
    : recordingFor(row, fullAccess, now);

  return {
    id: row.id,
    title: row.title,
    description: row.description,
    hostName: row.host_name,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    access: row.access,
    locked,
    registered,
    joinUrl: registered && !locked && !hasEnded(row, now) ? row.join_url : null,
    ...recording,
  };
}

async function registeredIds(user: User, webinarIds: string[]): Promise<Set<string>> {
  if (webinarIds.length === 0) return new Set();
  const rows = unwrap(
    await supabaseAdmin
      .from('webinar_registrations')
      .select('webinar_id')
      .eq('user_id', user.publicId)
      .in('webinar_id', webinarIds),
  );
  return new Set(rows.map((r) => r.webinar_id));
}

export async function listWebinars(
  user: User,
  query: ListWebinarsQuery,
): Promise<{ items: Webinar[]; meta: PageMeta }> {
  const nowIso = new Date().toISOString();
  const upcoming = query.when === 'upcoming';

  const build = (head: boolean) => {
    const q = supabaseAdmin
      .from('webinars')
      .select('*', { count: 'exact', head })
      .eq('status', 'PUBLISHED');
    return upcoming ? q.gt('ends_at', nowIso) : q.lte('ends_at', nowIso);
  };

  const { rows, meta } = await fetchPage(query, {
    rows: (from, to) =>
      build(false).order('starts_at', { ascending: upcoming }).order('id').range(from, to),
    count: () => build(true),
  });

  const registered = await registeredIds(
    user,
    rows.map((r) => r.id),
  );
  const now = Date.parse(nowIso);
  return { items: rows.map((row) => toWebinar(row, user, registered.has(row.id), now)), meta };
}

/** Registers for a webinar that has not ended. Registering again returns the same registration. */
export async function registerForWebinar(user: User, id: string): Promise<WebinarRegistration> {
  const webinar = unwrap(
    await supabaseAdmin
      .from('webinars')
      .select('*')
      .eq('id', id)
      .eq('status', 'PUBLISHED')
      .maybeSingle(),
  );
  if (!webinar) throw new HttpError(404, 'Webinar not found');
  if (webinar.access === 'PREMIUM' && !hasFullAccess(user)) {
    throw new HttpError(403, 'Available to verified Prive and Institutional members', {
      code: 'PREMIUM_CONTENT',
    });
  }
  if (hasEnded(webinar, Date.now())) {
    throw new HttpError(409, 'This webinar has ended', { code: 'WEBINAR_ENDED' });
  }

  unwrap(
    await supabaseAdmin
      .from('webinar_registrations')
      .upsert(
        { webinar_id: id, user_id: user.publicId },
        { onConflict: 'webinar_id,user_id', ignoreDuplicates: true },
      ),
  );
  const registration = unwrap(
    await supabaseAdmin
      .from('webinar_registrations')
      .select('created_at')
      .eq('webinar_id', id)
      .eq('user_id', user.publicId)
      .single(),
  );
  return { webinarId: id, registeredAt: registration.created_at, joinUrl: webinar.join_url };
}
