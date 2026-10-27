import { Router } from 'express';
import { currentUser, requireUser } from '../../middleware/auth';
import { parse } from '../../middleware/validate';
import {
  chooseTierSchema,
  preferencesSchema,
  updateProfileSchema,
  userIdParamSchema,
} from './users.schemas';
import { usersService } from './users.service';

/** The signed-in user's own account: `/me`. */
export const meRouter = Router();

meRouter.use(requireUser);

meRouter.get('/', async (req, res) => {
  res.json({ data: await usersService.getMyProfile(currentUser(req)) });
});

meRouter.patch('/', async (req, res) => {
  const input = parse(updateProfileSchema, req.body);
  res.json({ data: await usersService.updateMyProfile(currentUser(req), input) });
});

meRouter.put('/preferences', async (req, res) => {
  const input = parse(preferencesSchema, req.body);
  res.json({ data: await usersService.replaceMyPreferences(currentUser(req), input) });
});

meRouter.put('/tier', async (req, res) => {
  const { tier } = parse(chooseTierSchema, req.body);
  res.json({ data: await usersService.chooseTier(currentUser(req), tier) });
});

/** Other investors' public profiles: `/users/:id`. */
export const usersRouter = Router();

usersRouter.use(requireUser);

usersRouter.get('/:id', async (req, res) => {
  const { id } = parse(userIdParamSchema, req.params);
  res.json({ data: await usersService.getPublicProfile(id) });
});

usersRouter.post('/:id/follow', async (req, res) => {
  const { id } = parse(userIdParamSchema, req.params);
  await usersService.follow(currentUser(req), id);
  res.status(204).end();
});

usersRouter.delete('/:id/follow', async (req, res) => {
  const { id } = parse(userIdParamSchema, req.params);
  await usersService.unfollow(currentUser(req), id);
  res.status(204).end();
});
