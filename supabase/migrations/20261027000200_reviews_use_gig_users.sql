-- Reviews belong to GIG users (public.users), not directly to Supabase Auth. The API identifies a
-- user by users.public_id everywhere (/users/:id, file object keys), so that is the uuid stored in
-- reviews.user_id and review_versions.actor_id, and the first folder of each evidence path.

alter table public.reviews
  drop constraint reviews_user_id_fkey,
  add constraint reviews_user_id_fkey
    foreign key (user_id) references public.users (public_id) on delete cascade;

alter table public.review_versions
  drop constraint review_versions_actor_id_fkey,
  add constraint review_versions_actor_id_fkey
    foreign key (actor_id) references public.users (public_id) on delete set null;
