-- ============================================================
-- Migration 009 — Personal blackout dates ("My Shifts")
-- ============================================================
-- Each staffer manages their own blackout rows: either a standing
-- weekday rule ('recurring', e.g. "never Thursdays") or a one-off
-- date. Soft flag only for now — the scheduler's day view doesn't
-- surface conflicts against these yet (fast-follow).

create table blackout_dates (
  id uuid primary key default gen_random_uuid(),
  staff_id uuid not null references staff_profiles(id) on delete cascade,
  kind text not null check (kind in ('recurring','date')),
  day_of_week int check (day_of_week between 0 and 6),
  blackout_date date,
  notes text,
  created_at timestamptz not null default now(),
  constraint blackout_shape check (
    (kind = 'recurring' and day_of_week is not null and blackout_date is null) or
    (kind = 'date' and blackout_date is not null and day_of_week is null)
  )
);

create index blackout_dates_staff_idx on blackout_dates (staff_id);

alter table blackout_dates enable row level security;

create policy "own blackout dates" on blackout_dates for all
  using (staff_id = auth.uid()) with check (staff_id = auth.uid());
create policy "schedulers read all blackout dates" on blackout_dates for select
  using (can_schedule());
