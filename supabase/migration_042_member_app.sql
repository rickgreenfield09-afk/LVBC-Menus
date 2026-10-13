-- ============================================================
-- Migration 042 — Member app (/member): member sign-in and
-- member-level access
-- ============================================================
-- The member app is the customer's side of the membership program
-- (migration_040): their card and QR code, activity, badges, the
-- leaderboard, the menus, events, rewards and their profile. It is a
-- rebuild of the first member app (lvbc-member-app), which signed
-- people in by reading the whole members row — PIN included — from
-- the browser with the public key. Here a member is a real Supabase
-- Auth user:
--
--   * Sign-up and sign-in are Supabase Auth, email + a 6-digit PIN
--     (the PIN is the account password, so it is hashed by Auth and
--     never stored in a table). members.pin is dropped.
--   * members.auth_user_id ties the account to its member row.
--     member_claim_account() makes that link the first time someone
--     signs in: it attaches them to the row staff already created for
--     their email, or creates a new Free member.
--   * RLS lets a member read their own rows and nothing else. They
--     never write a table directly: the profile goes through
--     member_update_profile(), and points still only move through the
--     staff-side member_* functions.
--   * The two things a member sees about other people — the
--     leaderboard and the events calendar — come from functions that
--     hand back only what is meant to be public.
--
-- Staff policies are untouched; these are added alongside them.

-- ---------- MEMBERS ----------
alter table members
  drop column pin,
  add column auth_user_id uuid unique references auth.users(id) on delete set null,
  -- beer styles they like, picked on the Profile page
  add column taste_profile text[] not null default '{}',
  add column comms_opt_in boolean not null default true,
  add column comms_events boolean not null default true,
  add column comms_new_releases boolean not null default true,
  add column comms_promotions boolean not null default true;

-- The signed-in member's own members.id, or null for anyone else.
create or replace function my_member_id()
returns uuid as $$
  select id from members where auth_user_id = auth.uid();
$$ language sql security definer stable set search_path = public;

create policy "member reads own record" on members for select using (auth_user_id = auth.uid());
create policy "member reads own qr_tokens" on qr_tokens for select using (member_id = my_member_id());
create policy "member reads own check_ins" on check_ins for select using (member_id = my_member_id());
create policy "member reads own points_transactions" on points_transactions for select using (member_id = my_member_id());
create policy "member reads own redemptions" on redemptions for select using (member_id = my_member_id());
create policy "member reads own free_pours" on free_pours for select using (member_id = my_member_id());
create policy "member reads own member_beers" on member_beers for select using (member_id = my_member_id());
create policy "member reads own member_badges" on member_badges for select using (member_id = my_member_id());

-- ---------- ACCOUNT LINKING ----------
-- Called by the app right after every sign-in. Returns the member id.
-- An existing row (added by staff, or carried over from the old app)
-- is only handed to an account whose email has been confirmed —
-- otherwise signing up with someone else's address would take over
-- their points. Keep "Confirm email" switched on in Supabase Auth.
create or replace function member_claim_account(p_name text default null)
returns uuid as $$
declare
  v_uid uuid := auth.uid();
  v_email text;
  v_confirmed timestamptz;
  v_id uuid;
  v_linked uuid;
begin
  if v_uid is null then raise exception 'Sign in first'; end if;

  select id into v_id from members where auth_user_id = v_uid;
  if found then return v_id; end if;

  select lower(email), email_confirmed_at into v_email, v_confirmed from auth.users where id = v_uid;

  select id, auth_user_id into v_id, v_linked from members where lower(email) = v_email;
  if found then
    if v_linked is not null then raise exception 'That email already has a member account'; end if;
    if v_confirmed is null then raise exception 'Confirm your email to finish setting up your account'; end if;
    update members set auth_user_id = v_uid where id = v_id;
    return v_id;
  end if;

  insert into members (name, email, auth_user_id)
  values (coalesce(nullif(trim(p_name), ''), split_part(v_email, '@', 1)), v_email, v_uid)
  returning id into v_id;
  return v_id;
end;
$$ language plpgsql security definer set search_path = public;

-- ---------- PROFILE ----------
-- The only way a member changes their own row. p_patch may carry any
-- of: name, phone, birthday, taste_profile, comms_opt_in, comms_events,
-- comms_new_releases, comms_promotions, profile_photo_url. Anything
-- else in it (tier, points, ...) is ignored. A photo URL must point
-- into the member's own folder in the assets bucket.
create or replace function member_update_profile(p_patch jsonb)
returns void as $$
declare
  v_id uuid := my_member_id();
  v_photo text := p_patch->>'profile_photo_url';
begin
  if v_id is null then raise exception 'Sign in first'; end if;

  if p_patch ? 'name' and nullif(trim(p_patch->>'name'), '') is null then
    raise exception 'Name is required';
  end if;
  if v_photo is not null and position('/storage/v1/object/public/assets/members/' || auth.uid()::text || '/' in v_photo) = 0 then
    raise exception 'Invalid photo';
  end if;

  update members set
    name = case when p_patch ? 'name' then trim(p_patch->>'name') else name end,
    phone = case when p_patch ? 'phone' then nullif(trim(p_patch->>'phone'), '') else phone end,
    birthday = case when p_patch ? 'birthday' then nullif(p_patch->>'birthday', '')::date else birthday end,
    taste_profile = case when p_patch ? 'taste_profile'
      then array(select jsonb_array_elements_text(p_patch->'taste_profile')) else taste_profile end,
    comms_opt_in = case when p_patch ? 'comms_opt_in' then (p_patch->>'comms_opt_in')::boolean else comms_opt_in end,
    comms_events = case when p_patch ? 'comms_events' then (p_patch->>'comms_events')::boolean else comms_events end,
    comms_new_releases = case when p_patch ? 'comms_new_releases' then (p_patch->>'comms_new_releases')::boolean else comms_new_releases end,
    comms_promotions = case when p_patch ? 'comms_promotions' then (p_patch->>'comms_promotions')::boolean else comms_promotions end,
    profile_photo_url = case when p_patch ? 'profile_photo_url' then v_photo else profile_photo_url end
  where id = v_id;
end;
$$ language plpgsql security definer set search_path = public;

-- A member may upload/replace their own photo under
-- assets/members/<their-uid>/... — same shape as the staff rule
-- (migration_019). The bucket is already public-read.
create policy "member upload own photo" on storage.objects for insert
  with check (
    bucket_id = 'assets'
    and (storage.foldername(name))[1] = 'members'
    and (storage.foldername(name))[2] = auth.uid()::text
  );
create policy "member update own photo" on storage.objects for update
  using (
    bucket_id = 'assets'
    and (storage.foldername(name))[1] = 'members'
    and (storage.foldername(name))[2] = auth.uid()::text
  ) with check (
    bucket_id = 'assets'
    and (storage.foldername(name))[1] = 'members'
    and (storage.foldername(name))[2] = auth.uid()::text
  );

-- ---------- LEADERBOARD ----------
-- The one place a member sees other members: name, photo, tier and
-- points, top 20. 'month' ranks points earned this calendar month;
-- anything else ranks lifetime points.
create or replace function member_leaderboard(p_period text default 'month')
returns table (name text, profile_photo_url text, tier text, points int, is_you boolean) as $$
begin
  if my_member_id() is null and not is_staff() then raise exception 'Sign in first'; end if;

  if p_period = 'month' then
    return query
      select m.name, m.profile_photo_url, t.name, sum(pt.points)::int, m.id = my_member_id()
      from points_transactions pt
      join members m on m.id = pt.member_id
      join tiers t on t.id = m.tier_id
      where m.is_active and pt.points > 0
        and pt.created_at >= date_trunc('month', now() at time zone 'America/Chicago') at time zone 'America/Chicago'
      group by m.id, t.name
      order by 4 desc, m.name
      limit 20;
  else
    return query
      select m.name, m.profile_photo_url, t.name, m.points_earned_lifetime, m.id = my_member_id()
      from members m
      join tiers t on t.id = m.tier_id
      where m.is_active and m.points_earned_lifetime > 0
      order by 4 desc, m.name
      limit 20;
  end if;
end;
$$ language plpgsql security definer stable set search_path = public;

-- ---------- EVENTS CALENDAR ----------
-- One-off events plus the recurring ones (trivia every Tuesday, ...)
-- expanded into dates, from today through p_days ahead, in brewery
-- time. Same rules as js/recurring.js: a skipped occurrence is left
-- out, a moved one shows on its new date. Staffing and notes on the
-- recurring tables stay private — only what's returned here is public.
create or replace function member_upcoming_events(p_days int default 60)
returns table (event_date date, start_time time, end_time time, name text, event_type text,
               is_beer_release boolean, points int, recurring boolean) as $$
declare
  v_from date := (now() at time zone 'America/Chicago')::date;
  v_to date := (now() at time zone 'America/Chicago')::date + least(greatest(p_days, 0), 366);
  v_recurring_pts int := (select pr.points from point_rules pr where pr.transaction_type = 'event_attendance' and pr.is_active);
begin
  return query
    select (e.event_date at time zone 'America/Chicago')::date,
           (e.event_date at time zone 'America/Chicago')::time,
           (e.event_end at time zone 'America/Chicago')::time,
           e.event_name, e.event_type, e.is_beer_release, e.points_available, false
    from events e
    where (e.event_date at time zone 'America/Chicago')::date between v_from and v_to

    union all

    -- occurrences on their computed date, unless skipped or moved away
    select d::date, re.start_time, re.end_time, re.name, re.event_type, false, v_recurring_pts, true
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
    select o.moved_to_date, re.start_time, re.end_time, re.name, re.event_type, false, v_recurring_pts, true
    from recurring_event_overrides o
    join recurring_events re on re.id = o.recurring_event_id
    where re.is_active and not o.skipped and o.moved_to_date between v_from and v_to

    order by 1, 2 nulls first, 4;
end;
$$ language plpgsql security definer stable set search_path = public;

revoke all on function my_member_id() from public, anon;
revoke all on function member_claim_account(text) from public, anon;
revoke all on function member_update_profile(jsonb) from public, anon;
revoke all on function member_leaderboard(text) from public, anon;
grant execute on function my_member_id() to authenticated;
grant execute on function member_claim_account(text) to authenticated;
grant execute on function member_update_profile(jsonb) to authenticated;
grant execute on function member_leaderboard(text) to authenticated;
grant execute on function member_upcoming_events(int) to anon, authenticated;

-- ---------- LIVE CHECK-IN ----------
-- The app shows "Welcome back" the moment staff scan the member's
-- code. Realtime only delivers rows the listener may read, so a
-- member hears about their own check-ins and no one else's.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables
                     where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'check_ins') then
    alter publication supabase_realtime add table check_ins;
  end if;
end $$;

-- ============================================================
-- CATALOG — what the old member app listed that migration_040 didn't
-- ============================================================
-- Left out: the two "LVBC U There" rewards; that program isn't part
-- of this build yet.

insert into rewards (reward_name, level, points_cost, paid_only, repeatable) values
  ('Partner discount coupon',     1,  150, false, true),
  ('Early RSVP access',           2,  350, false, true),
  ('Choose next staff pick',      2,  500, false, true),
  ('Growler (branded)',           3,  750, true,  true),
  ('VIP table at special event',  4, 1500, true,  true),
  ('Anniversary party invite',    5, 5000, true,  true);

-- Artwork lives with the app (member/badges/). null = no art yet;
-- the app draws a plain medal.
alter table badges add column image_url text;

update badges set image_url = '/member/badges/badge-' || v.file || '.png'
from (values
  ('Hop Head', 'hop_head'), ('Spring Sipper', 'spring_sipper'), ('Summer Regular', 'summer_regular'),
  ('Fall Faithful', 'fall_faithful'), ('Winter Warmer', 'winter_warmer'), ('Four Seasons', 'four_seasons')
) as v(name, file)
where badges.name = v.name;

-- The last six have no rule yet — nothing records event attendance,
-- wins, streaks or referrals per member — so they show in the catalog
-- but can't be earned until that exists.
insert into badges (name, category, rarity, border_color, description, trigger_description, rule_type, rule_params) values
  ('First Sip',          'Explorer',   'Standard', '#E8B84B', 'Log your first beer',            'First beer in the journal',      'unique_beers',  '{"count":1,"patterns":[]}'),
  ('Explorer 10',        'Explorer',   'Standard', '#E8B84B', '10 unique LVBC beers tried',     '10 unique beers in the journal', 'unique_beers',  '{"count":10,"patterns":[]}'),
  ('Regular (10)',       'Milestone',  'Standard', '#8E92B0', '10 lifetime check-ins',          '10 lifetime check-ins',          'checkin_count', '{"count":10}'),
  ('Local (25)',         'Milestone',  'Standard', '#8E92B0', '25 lifetime check-ins',          '25 lifetime check-ins',          'checkin_count', '{"count":25}'),
  ('Coffee Club Member', 'Membership', 'Standard', '#E8B84B', 'Active Coffee Club membership',  'Active Coffee Club membership',  'tier',          '{"tier":"Coffee Club"}'),
  ('Full Pour Member',   'Membership', 'Standard', '#BF5FFF', 'Active Full Pour membership',    'Active Full Pour membership',    'tier',          '{"tier":"Full Pour"}'),
  ('Streak Starter',     'Milestone',  'Standard', '#8E92B0', 'Complete a 4-week visit streak', 'Visit 4 weeks in a row',         null, '{}'),
  ('First Timer',        'Event',      'Standard', '#BF5FFF', 'Attend your first event',        'Attend first event',             null, '{}'),
  ('Regular',            'Event',      'Standard', '#BF5FFF', 'Attend 10 scheduled events',     'Attend 10 scheduled events',     null, '{}'),
  ('Lucky Break',        'Event',      'Standard', '#BF5FFF', 'Win your first trivia or bingo', 'First trivia or bingo win',      null, '{}'),
  ('Ambassador',         'Social',     'Standard', '#2AB8A6', 'Refer your first signup',        'First referral signup',          null, '{}'),
  ('Profile Complete',   'Social',     'Standard', '#2AB8A6', 'Complete taste profile & photo', 'Taste profile and photo set',    null, '{}');

-- give existing members anything the new rules say they already earned
select count(*) as members_evaluated from (select _evaluate_member_badges(id) from members) x;
