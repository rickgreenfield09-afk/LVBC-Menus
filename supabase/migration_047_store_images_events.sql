-- ============================================================
-- Migration 047 — Store item pictures, and linking items to events
-- ============================================================
-- A store item (migration_046) can now carry up to two pictures and be
-- tied to an event on the calendar.
--
--   * store_items.image_urls — public URLs of up to two photos in the
--     "assets" bucket (store/<item id>/...). The Payments screen
--     uploads them; the member app shows them on the item, and
--     api/store-checkout.js hands them to Stripe so they appear on the
--     checkout page and receipts.
--   * store_items.event_id — the event this item belongs to (a Maifest
--     stein pre-order -> the Maifest event). The member app's Events
--     page shows a buy button under an event with a linked item.
--   * member_upcoming_events() now also returns the event's id (null for
--     the weekly regulars) so the app can match events to items. A
--     function's return type can't be changed in place, so it is dropped
--     and recreated; the body is otherwise as in migration_042.

alter table store_items
  add column image_urls text[] not null default '{}' check (cardinality(image_urls) <= 2),
  add column event_id uuid references events(id) on delete set null;

drop function member_upcoming_events(int);

create function member_upcoming_events(p_days int default 60)
returns table (event_date date, start_time time, end_time time, name text, event_type text,
               is_beer_release boolean, points int, recurring boolean, event_id uuid) as $$
declare
  v_from date := (now() at time zone 'America/Chicago')::date;
  v_to date := (now() at time zone 'America/Chicago')::date + least(greatest(p_days, 0), 366);
  v_recurring_pts int := (select pr.points from point_rules pr where pr.transaction_type = 'event_attendance' and pr.is_active);
begin
  return query
    select (e.event_date at time zone 'America/Chicago')::date,
           (e.event_date at time zone 'America/Chicago')::time,
           (e.event_end at time zone 'America/Chicago')::time,
           e.event_name, e.event_type, e.is_beer_release, e.points_available, false, e.id
    from events e
    where (e.event_date at time zone 'America/Chicago')::date between v_from and v_to

    union all

    -- occurrences on their computed date, unless skipped or moved away
    select d::date, re.start_time, re.end_time, re.name, re.event_type, false, v_recurring_pts, true, null::uuid
    from recurring_events re
    cross join generate_series(v_from::timestamp, v_to::timestamp, interval '1 day') d
    where re.is_active
      and extract(dow from d)::int = re.day_of_week
      and (re.recurrence_type = 'weekly'
           or re.week_of_month = ((extract(day from d)::int - 1) / 7) + 1
           or (re.week_of_month = 5 and extract(month from d + interval '7 days') <> extract(month from d)))
      and not exists (
        select 1 from recurring_event_overrides o
        where o.recurring_event_id = re.id and o.occurrence_date = d::date
          and (o.skipped or o.moved_to_date is not null))

    union all

    -- occurrences moved into the window from another date
    select o.moved_to_date, re.start_time, re.end_time, re.name, re.event_type, false, v_recurring_pts, true, null::uuid
    from recurring_event_overrides o
    join recurring_events re on re.id = o.recurring_event_id
    where re.is_active and not o.skipped and o.moved_to_date between v_from and v_to

    order by 1, 2 nulls first, 4;
end;
$$ language plpgsql security definer stable set search_path = public;

revoke all on function member_upcoming_events(int) from public;
grant execute on function member_upcoming_events(int) to anon, authenticated;
