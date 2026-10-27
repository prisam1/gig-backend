import { Router } from 'express';
import { parse, sendData, sendPage } from '../../lib/http';
import { authUser, requireAuth } from '../../middleware/auth';
import { listNotificationsQuery, markReadBody, registerDeviceBody } from './notifications.schemas';
import { listNotifications, markRead, registerDevice } from './notifications.service';

/** `/me/notifications`: the in-app inbox. */
export const notificationsRouter = Router();

notificationsRouter.use(requireAuth);

// GET /me/notifications?unread=true — newest first; `meta.unread` is the badge count.
notificationsRouter.get('/', async (req, res) => {
  const query = parse(listNotificationsQuery, req.query);
  const { items, meta } = await listNotifications(authUser(req), query);
  sendPage(res, items, meta);
});

// POST /me/notifications/read { ids?: [...] } — mark some or all notifications read.
notificationsRouter.post('/read', async (req, res) => {
  const { ids } = parse(markReadBody, req.body);
  sendData(res, { updated: await markRead(authUser(req), ids) });
});

/** `/me/devices`: push notification tokens. */
export const devicesRouter = Router();

devicesRouter.use(requireAuth);

// POST /me/devices { token, platform, appVersion? } — register or refresh a push token.
devicesRouter.post('/', async (req, res) => {
  const body = parse(registerDeviceBody, req.body);
  sendData(res, await registerDevice(authUser(req), body), 201);
});
