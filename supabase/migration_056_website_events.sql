-- ============================================================
-- Migration 056 — Events on the public website
-- ============================================================
-- Events can now carry a description and a flier picture and be marked
-- "show on website". events-embed.html (iframed into
-- lagovistabrewingco.com) reads them through website_events(), which is
-- callable by anon and returns only what is meant to be public.
-- Recurring events can be shown too (the "Weekly Events" tiles).
--
--   * events.description / image_url / is_public
--   * recurring_events.is_public
--   * assets/events/... — schedulers may upload fliers (the assets
--     bucket is otherwise admin-write; see migration_002)
--
-- Safe to re-run.

alter table events add column if not exists description text;
alter table events add column if not exists image_url text;
alter table events add column if not exists is_public boolean not null default false;
alter table recurring_events add column if not exists is_public boolean not null default false;

drop policy if exists "schedulers insert event fliers" on storage.objects;
create policy "schedulers insert event fliers" on storage.objects for insert
  with check (bucket_id = 'assets' and (storage.foldername(name))[1] = 'events' and can_schedule());
drop policy if exists "schedulers update event fliers" on storage.objects;
create policy "schedulers update event fliers" on storage.objects for update
  using (bucket_id = 'assets' and (storage.foldername(name))[1] = 'events' and can_schedule())
  with check (bucket_id = 'assets' and (storage.foldername(name))[1] = 'events' and can_schedule());
drop policy if exists "schedulers delete event fliers" on storage.objects;
create policy "schedulers delete event fliers" on storage.objects for delete
  using (bucket_id = 'assets' and (storage.foldername(name))[1] = 'events' and can_schedule());

create or replace function website_events()
returns jsonb as $$
  select jsonb_build_object(
    'weekly', coalesce((
      select jsonb_agg(jsonb_build_object(
          'name', re.name, 'day_of_week', re.day_of_week, 'recurrence_type', re.recurrence_type,
          'week_of_month', re.week_of_month, 'start_time', re.start_time, 'end_time', re.end_time)
        order by re.day_of_week, re.start_time)
      from recurring_events re where re.is_active and re.is_public), '[]'::jsonb),
    'upcoming', coalesce((
      select jsonb_agg(jsonb_build_object(
          'id', e.id, 'name', e.event_name, 'event_date', e.event_date, 'event_end', e.event_end,
          'description', e.description, 'image_url', e.image_url)
        order by e.event_date)
      from events e
      where e.is_public
        and (e.event_date at time zone 'America/Chicago')::date >= (now() at time zone 'America/Chicago')::date), '[]'::jsonb)
  );
$$ language sql security definer stable set search_path = public;

revoke all on function website_events() from public;
grant execute on function website_events() to anon, authenticated;
