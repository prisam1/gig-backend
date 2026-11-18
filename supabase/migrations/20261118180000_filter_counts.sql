-- Live counts for the filter sheet, per tab. The sheet's categories and options live in the app;
-- the numbers next to them are computed here from what each tab lists, so they are true and
-- follow the data:
--   reviews          companies   sentiment, asset class (as the card shows it), resolution (% of
--                                companies), average score, country, invested status and year
--                                (companies with a published review of that kind)
--   representations  petitions   country, resolution (% of petitions), year opened
--   ratings          issuers     sentiment, asset class (Equity, Bonds, REIT), year opened
--   roadshows        roadshows   country, average score, year
-- Returns { "<option id>": { "value": n, "unit": "count" | "percent" } } for the options that
-- have a count; the others (e.g. the sort options) are left out.

create or replace function public.app_filter_counts(p_section text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_result jsonb := '{}'::jsonb;
  v_total numeric;
begin
  if p_section = 'reviews' then
    select v_result || coalesce(jsonb_object_agg(k, jsonb_build_object('value', n, 'unit', 'count')), '{}')
    into v_result
    from (
      select c.dominant_sentiment::text as k, count(*) as n
      from public.company_cards c where c.dominant_sentiment is not null group by 1
      union all
      select o.id, count(c.id)
      from (values ('MF', 'Mutual Fund / SIP'), ('INS', 'Insurance'), ('EQ', 'Equity / IPO'),
                   ('BRK', 'Broker / Platform'), ('BND', 'Bonds / Sukuk'), ('PMS', 'PMS / AIF'),
                   ('RE', 'Real Estate'), ('CRY', 'Crypto / VDA')) as o (id, label)
      left join public.company_cards c on c.asset_type_label = o.label
      group by o.id
      union all
      select round(c.score)::integer::text, count(*)
      from public.company_cards c where c.review_count > 0 group by 1
      union all
      select case c.country when 'IN' then 'India' when 'AE' then 'UAE' else 'Other' end, count(*)
      from public.company_cards c group by 1
      union all
      select case r.investment_status
               when 'CURRENTLY_INVESTED' then 'invested' when 'EXITED' then 'exited' else 'never' end,
             count(distinct r.company_id)
      from public.reviews r
      join public.company_cards c on c.id = r.company_id
      where r.status = 'PUBLISHED' and r.deleted_at is null
      group by 1
      union all
      select case when r.investment_year is null or r.investment_year < 2021 then 'before_2021'
                  else r.investment_year::text end,
             count(distinct r.company_id)
      from public.reviews r
      join public.company_cards c on c.id = r.company_id
      where r.status = 'PUBLISHED' and r.deleted_at is null
      group by 1
    ) counts;

    select count(*) into v_total from public.company_cards;
    select v_result || coalesce(jsonb_object_agg(k, jsonb_build_object(
             'value', case when v_total = 0 then 0 else round(100 * n / v_total) end, 'unit', 'percent')), '{}')
    into v_result
    from (
      select o.id as k, count(c.id)::numeric as n
      from (values ('Resolved', 'RESOLVED'), ('In Progress', 'IN_PROGRESS'),
                   ('Unresolved', 'UNRESOLVED'), ('Not Contacted', 'NOT_CONTACTED')) as o (id, bucket)
      left join public.company_cards c on c.dominant_resolution::text = o.bucket
      group by o.id
    ) shares;

  elsif p_section = 'representations' then
    select v_result || coalesce(jsonb_object_agg(k, jsonb_build_object('value', n, 'unit', 'count')), '{}')
    into v_result
    from (
      select case c.country when 'IN' then 'India' when 'AE' then 'UAE' else 'Other' end as k, count(*) as n
      from app.representation_cards c group by 1
      union all
      select case when extract(year from c.opens_at) < 2021 then 'before_2021'
                  else extract(year from c.opens_at)::integer::text end, count(*)
      from app.representation_cards c group by 1
    ) counts;

    select count(*) into v_total from app.representation_cards;
    select v_result || coalesce(jsonb_object_agg(k, jsonb_build_object(
             'value', case when v_total = 0 then 0 else round(100 * n / v_total) end, 'unit', 'percent')), '{}')
    into v_result
    from (
      select o.id as k, count(c.internal_id)::numeric as n
      from (values ('Resolved', array['RESOLVED']),
                   ('In Progress', array['UNDER_REVIEW', 'SUBMITTED_TO_REGULATOR', 'MEETING_REQUESTED',
                                         'MEETING_SCHEDULED', 'REGULATOR_RESPONDED']),
                   ('Unresolved', array['OPEN', 'CLOSING_SOON']),
                   ('Not Contacted', array['OPEN', 'CLOSING_SOON'])) as o (id, steps)
      left join app.representation_cards c on c.track_status = any (o.steps)
      group by o.id
    ) shares;

  elsif p_section = 'ratings' then
    select v_result || coalesce(jsonb_object_agg(k, jsonb_build_object('value', n, 'unit', 'count')), '{}')
    into v_result
    from (
      select initcap(c.sentiment) as k, count(*) as n
      from app.issuer_cards c where c.sentiment is not null group by 1
      union all
      select o.id, count(c.id)
      from (values ('EQ', 'Equity'), ('BND', 'Bonds'), ('RE', 'REIT')) as o (id, asset_type)
      left join app.issuer_cards c on c.asset_type = o.asset_type
      group by o.id
      union all
      select case when extract(year from c.open_date) < 2021 then 'before_2021'
                  else extract(year from c.open_date)::integer::text end, count(*)
      from app.issuer_cards c where c.open_date is not null group by 1
    ) counts;

  elsif p_section = 'roadshows' then
    select v_result || coalesce(jsonb_object_agg(k, jsonb_build_object('value', n, 'unit', 'count')), '{}')
    into v_result
    from (
      select r.country_label as k, count(*) as n
      from public.roadshows r where r.status = 'PUBLISHED' and r.country_label is not null group by 1
      union all
      select r.avg_score::text, count(*)
      from public.roadshows r where r.status = 'PUBLISHED' and r.avg_score is not null group by 1
      union all
      select case when r.display_year < 2021 then 'before_2021' else r.display_year::text end, count(*)
      from public.roadshows r where r.status = 'PUBLISHED' and r.display_year is not null group by 1
    ) counts;

  else
    raise exception 'UNKNOWN_SECTION';
  end if;

  return v_result;
end;
$$;

-- The sheet's options live in the app again; only the counts are served.
delete from public.app_content where key = 'filters.sheet';

revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on all functions in schema public to service_role;
