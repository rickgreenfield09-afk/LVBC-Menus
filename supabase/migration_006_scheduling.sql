-- ============================================================
-- Migration 006 — Staff Scheduling (monthly grid, v1)
-- Adds shift assignments + a scheduling-permission flag on
-- staff_profiles. Scope: view + manual assign only — no
-- copy-forward, coverage requests, trades, or blackout dates yet
-- (see HANDOFF.md for the full planned module).
-- ============================================================

alter table staff_profiles
  add column if not exists can_schedule boolean not null default false;

create table shifts (
  id uuid primary key default gen_random_uuid(),
  shift_date date not null,
  shift_label text not null default 'Shift',
  start_time time,
  end_time time,
  staff_id uuid references staff_profiles(id) on delete set null,
  role text not null check (role in ('bartender','manager')) default 'bartender',
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index shifts_date_idx on shifts (shift_date);

create trigger shifts_set_updated_at
  before update on shifts
  for each row execute function set_updated_at();

create or replace function can_schedule()
returns boolean as $$
  select exists (
    select 1 from staff_profiles
    where id = auth.uid() and (can_schedule = true or role = 'admin')
  );
$$ language sql security definer stable;

alter table shifts enable row level security;

create policy "staff read shifts" on shifts for select using (is_staff());
create policy "schedulers write shifts" on shifts for all
  using (can_schedule()) with check (can_schedule());
