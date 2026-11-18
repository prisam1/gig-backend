-- The Learn tab, exactly as the app shows it, from the database: the app's 6 items (title, the
-- rating and the figure its sorts use, the date, the list order), and the app's orders.
-- The earlier sample items the app does not show are archived.

alter table public.learn_items
  -- Place in the app's list (its default order; ties keep it, and the colour follows it).
  add column display_order integer not null default 0,
  -- The app's "rating" and "avg" figures (Most Relevant / Improving Trend, Trending / Most Reviewed).
  add column display_rating numeric(3, 1),
  add column display_avg integer;

update public.learn_items set status = 'ARCHIVED'
where title in ('Reading an offer document', 'Green bonds explained', 'Mutual fund house scorecard 2026');

insert into public.learn_items (
  id, title, format, access, status, published_at, display_order, display_rating, display_avg
)
select l.id::uuid, l.title, 'VIDEO', 'FREE', 'PUBLISHED', to_timestamp(l.opened_ms / 1000.0),
       l.display_order, l.rating, l.avg
from (values
  ('1ea40000-0000-4000-8000-000000000001', 1, 'Standardize Hidden Fee Transparency Across', 1714500000000, 4.8, 120),
  ('1ea40000-0000-4000-8000-000000000002', 2, 'Understanding the New SEC Regulatory Guidelines', 1714550000000, 4.2, 85),
  ('1ea40000-0000-4000-8000-000000000003', 3, 'How to Read a Term Sheet Like a Pro', 1714600000000, 4.9, 210),
  ('1ea40000-0000-4000-8000-000000000004', 4, 'The Future of Real Estate Tokenization', 1714650000000, 3.5, 45),
  ('1ea40000-0000-4000-8000-000000000005', 5, 'Navigating Cross-Border Investment Tax Laws', 1714700000000, 4.5, 150),
  ('1ea40000-0000-4000-8000-000000000006', 6, 'Cross-Border Investment Tax Laws', 1714700000000, 2, 20)
) as l (id, display_order, title, opened_ms, rating, avg)
on conflict (id) do update set
  title = excluded.title, status = excluded.status, published_at = excluded.published_at,
  display_order = excluded.display_order, display_rating = excluded.display_rating,
  display_avg = excluded.display_avg;
