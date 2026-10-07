-- ============================================================
-- Migration 037 — Assignments (shift responsibilities)
-- ============================================================
-- Requires migration 036. Recurring and one-off responsibilities that
-- belong to a SHIFT, not a person: inventory counts, cleaning, opening
-- and closing. Whoever is scheduled on that shift sees them on their
-- phone; the people who build the schedule (can_schedule()) manage
-- them from the Assignments screen.
--
-- assignment_tasks — one row per responsibility.
--   category   inventory | cleaning | opening | closing
--   period     morning | evening — the AM or PM bartender shift. On a
--              day with a single shift (Sunday) that one shift takes
--              both periods' tasks; closed days get none. That rule
--              lives in the apps, read off shift_day_settings.
--   frequency  daily      every open day
--              weekly     on day_of_week
--              quarterly  once per calendar quarter: offered on every
--                         matching shift (optionally only on
--                         day_of_week) until someone completes it
--              adhoc      once, on due_date; if missed it stays on
--                         that period's shifts until done
--
-- assignment_task_targets — what an inventory task counts: a percent
--   item, or a merch style at one location (merch is counted per
--   location, see migration_036). A task with no targets is a plain
--   check-off.
--
-- assignment_completions — one row per task per occurrence.
--   due_key identifies the occurrence so it can only be done once:
--   the date (YYYY-MM-DD) for daily/weekly, YYYY-Qn for quarterly,
--   'adhoc' for ad hoc. An inventory task's row is written
--   automatically once every target has been counted that day; the
--   rest are checked off by hand.

create table assignment_tasks (
  id uuid primary key default gen_random_uuid(),
  title text not null check (length(trim(title)) > 0),
  category text not null check (category in ('inventory','cleaning','opening','closing')),
  instructions text,
  frequency text not null check (frequency in ('daily','weekly','quarterly','adhoc')),
  period text not null check (period in ('morning','evening')),
  day_of_week int check (day_of_week between 0 and 6), -- 0=Sun...6=Sat
  due_date date,
  is_active boolean not null default true,
  created_by uuid references staff_profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint assignment_tasks_shape check (
    (frequency = 'daily' and day_of_week is null and due_date is null) or
    (frequency = 'weekly' and day_of_week is not null and due_date is null) or
    (frequency = 'quarterly' and due_date is null) or
    (frequency = 'adhoc' and due_date is not null and day_of_week is null)
  )
);

create trigger assignment_tasks_set_updated_at
  before update on assignment_tasks
  for each row execute function set_updated_at();

create table assignment_task_targets (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references assignment_tasks(id) on delete cascade,
  item_id uuid references inventory_items(id) on delete cascade,
  merch_style_id uuid references inventory_merch_styles(id) on delete cascade,
  -- where to count the merch style; null for percent items
  location_id uuid references inventory_locations(id) on delete cascade,
  constraint assignment_task_targets_shape check (
    (item_id is not null and merch_style_id is null and location_id is null) or
    (item_id is null and merch_style_id is not null and location_id is not null)
  ),
  constraint assignment_task_targets_uq unique nulls not distinct (task_id, item_id, merch_style_id, location_id)
);

create index assignment_task_targets_task_idx on assignment_task_targets (task_id);

create table assignment_completions (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references assignment_tasks(id) on delete cascade,
  due_key text not null,
  completed_on date not null default current_date,
  completed_at timestamptz not null default now(),
  completed_by uuid references staff_profiles(id) on delete set null,
  unique (task_id, due_key)
);

create index assignment_completions_date_idx on assignment_completions (completed_on);

alter table assignment_tasks enable row level security;
alter table assignment_task_targets enable row level security;
alter table assignment_completions enable row level security;

create policy "staff read assignment_tasks" on assignment_tasks for select using (is_staff());
create policy "schedulers write assignment_tasks" on assignment_tasks for all
  using (can_schedule()) with check (can_schedule());

create policy "staff read assignment_task_targets" on assignment_task_targets for select using (is_staff());
create policy "schedulers write assignment_task_targets" on assignment_task_targets for all
  using (can_schedule()) with check (can_schedule());

-- Any staffer can check a task off as themselves and undo their own
-- check; schedulers can also mark or clear on anyone's behalf.
create policy "staff read assignment_completions" on assignment_completions for select using (is_staff());
create policy "staff complete assignments" on assignment_completions for insert
  with check (is_staff() and (completed_by = auth.uid() or can_schedule()));
create policy "undo own or scheduler" on assignment_completions for delete
  using (completed_by = auth.uid() or can_schedule());
