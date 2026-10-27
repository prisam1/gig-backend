-- Reviews belong to the auth module's users (app.users), not Supabase Auth. The API identifies a
-- user by app.users.public_id, so that is the uuid stored in reviews.user_id and
-- review_versions.actor_id, and the first folder of each evidence path in Storage.

alter table public.reviews
  drop constraint reviews_user_id_fkey,
  add constraint reviews_user_id_fkey
    foreign key (user_id) references app.users (public_id) on delete cascade;

alter table public.review_versions
  drop constraint review_versions_actor_id_fkey,
  add constraint review_versions_actor_id_fkey
    foreign key (actor_id) references app.users (public_id) on delete set null;
