-- ============================================================
-- Migration 011 — Events upgrade: custom types, start/end time,
-- recurring events (weekly + monthly-nth-weekday) with per-
-- occurrence overrides (skip / move / reassign staffer).
-- ============================================================

-- ---------- CUSTOM EVENT TYPES ----------
-- Seeded by "Other..." + "save this type" in the Events form.
create table event_types (
  id uuid primary key default gen_random_uuid(),
  key text not null unique,
  label text not null,
  created_at timestamptz not null default now()
);

alter table event_types enable row level security;
create policy "staff read event_types" on event_types for select using (is_staff());
create policy "schedulers write event_types" on event_types for all
  using (can_schedule()) with check (can_schedule());

-- ---------- EVENTS: explicit end time ----------
alter table events add column if not exists event_end timestamptz;

-- ---------- RECURRING EVENTS ----------
-- 'weekly' fires every <day_of_week>. 'monthly_nth_weekday' fires on
-- the <week_of_month>-th <day_of_week> of every month (5 = last).
create table recurring_events (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  event_type text,
  recurrence_type text not null check (recurrence_type in ('weekly','monthly_nth_weekday')),
  day_of_week int not null check (day_of_week between 0 and 6),
  week_of_month int check (week_of_month between 1 and 5),
  start_time time,
  end_time time,
  default_staff_id uuid references staff_profiles(id) on delete set null,
  notes text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  constraint recurring_week_of_month_shape check (
    (recurrence_type = 'weekly' and week_of_month is null) or
    (recurrence_type = 'monthly_nth_weekday' and week_of_month is not null)
  )
);

-- ---------- RECURRING EVENT OCCURRENCE OVERRIDES ----------
-- One row per exception to the computed pattern for a given
-- originally-computed date: skip it, move it, and/or reassign staff
-- for that single occurrence — the series itself is untouched.
create table recurring_event_overrides (
  id uuid primary key default gen_random_uuid(),
  recurring_event_id uuid not null references recurring_events(id) on delete cascade,
  occurrence_date date not null,
  skipped boolean not null default false,
  moved_to_date date,
  staff_id uuid references staff_profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (recurring_event_id, occurrence_date)
);

alter table recurring_events enable row level security;
alter table recurring_event_overrides enable row level security;

create policy "staff read recurring_events" on recurring_events for select using (is_staff());
create policy "schedulers write recurring_events" on recurring_events for all
  using (can_schedule()) with check (can_schedule());

create policy "staff read recurring_event_overrides" on recurring_event_overrides for select using (is_staff());
create policy "schedulers write recurring_event_overrides" on recurring_event_overrides for all
  using (can_schedule()) with check (can_schedule());

-- Seed: VFW hosts the 3rd Tuesday of the month, 6-9pm.
insert into recurring_events (name, event_type, recurrence_type, day_of_week, week_of_month, start_time, end_time, notes)
values ('VFW Night', 'vfw', 'monthly_nth_weekday', 2, 3, '18:00', '21:00', 'Local VFW hosts — move via an override if it falls on a different Tuesday that month.');
