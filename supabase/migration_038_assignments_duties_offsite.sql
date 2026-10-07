-- ============================================================
-- Migration 038 — Assignments: turnover, maintenance, special
-- assignments, credit, and off-site event checklists
-- ============================================================
-- Requires migration 037.
--
-- 1. Two more task categories.
--    turnover     AM-to-PM handoff duties. They belong to the AM
--                 bartender, so period is always 'morning'; a day
--                 with a single shift has no turnover (the apps skip
--                 it there).
--    maintenance  sits beside cleaning on its own page.
--    Closing stays an 'evening' task: it belongs to the closing
--    bartender.
--
-- 2. Special assignments. assigned_staff_id on an ad hoc task hands
--    it to one employee instead of to whoever holds the shift. Only
--    ad hoc tasks can carry it.
--
-- 3. Credit. completed_by is whoever ticked the box; credited_to is
--    who the work counts for on the Assignments dashboard. They
--    differ when a manager marks a task done on someone's behalf —
--    credit goes to the person scheduled on that shift (or the
--    assignee of a special assignment). Existing rows are credited
--    to whoever completed them.
--
-- 4. Off-site events. Separate from the in-brewery `events` table
--    (which drives the schedule and member check-ins): these are
--    festivals and booths away from the brewery, planned as a
--    bring-along checklist.
--      offsite_events              the event
--      offsite_event_staff         who is working it
--      offsite_checklist_templates a reusable starting list
--      offsite_checklist_items     one line of a template OR of an
--                                  event's own list, never both
--    Applying a template COPIES its lines onto the event, so each
--    event's list can then be changed freely without touching the
--    template. An event line has two ticks: packed (going out) and
--    returned (back at the brewery).
--    Schedulers manage events and templates. Anyone assigned to an
--    event can also edit and tick that event's checklist — they are
--    the ones standing at the van.

-- ---------- 1 + 2. categories and special assignments ----------
alter table assignment_tasks drop constraint assignment_tasks_category_check;
alter table assignment_tasks add constraint assignment_tasks_category_check
  check (category in ('inventory','cleaning','maintenance','opening','turnover','closing'));

alter table assignment_tasks add column assigned_staff_id uuid references staff_profiles(id) on delete set null;
alter table assignment_tasks add constraint assignment_tasks_special check (assigned_staff_id is null or frequency = 'adhoc');
alter table assignment_tasks add constraint assignment_tasks_turnover_am check (category <> 'turnover' or period = 'morning');

-- ---------- 3. credit ----------
alter table assignment_completions add column credited_to uuid references staff_profiles(id) on delete set null;
update assignment_completions set credited_to = completed_by where credited_to is null;
create index assignment_completions_credit_idx on assignment_completions (credited_to);

-- ---------- 4. off-site events ----------
create table offsite_events (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) > 0),
  venue text,
  start_date date not null,
  end_date date not null,
  notes text,
  created_by uuid references staff_profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint offsite_events_dates check (end_date >= start_date)
);

create trigger offsite_events_set_updated_at
  before update on offsite_events
  for each row execute function set_updated_at();

create table offsite_event_staff (
  event_id uuid not null references offsite_events(id) on delete cascade,
  staff_id uuid not null references staff_profiles(id) on delete cascade,
  primary key (event_id, staff_id)
);

create table offsite_checklist_templates (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) > 0),
  created_at timestamptz not null default now()
);

create unique index offsite_checklist_templates_name_uq on offsite_checklist_templates (lower(trim(name)));

create table offsite_checklist_items (
  id uuid primary key default gen_random_uuid(),
  template_id uuid references offsite_checklist_templates(id) on delete cascade,
  event_id uuid references offsite_events(id) on delete cascade,
  label text not null check (length(trim(label)) > 0),
  quantity int not null default 1 check (quantity > 0),
  sort_order int not null default 0,
  packed_at timestamptz,
  packed_by uuid references staff_profiles(id) on delete set null,
  returned_at timestamptz,
  returned_by uuid references staff_profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint offsite_checklist_items_owner check ((template_id is null) <> (event_id is null)),
  -- a template line is never ticked
  constraint offsite_checklist_items_template_unticked check (template_id is null or (packed_at is null and returned_at is null))
);

create index offsite_checklist_items_event_idx on offsite_checklist_items (event_id);
create index offsite_checklist_items_template_idx on offsite_checklist_items (template_id);

create or replace function is_offsite_event_staff(p_event_id uuid)
returns boolean as $$
  select exists (select 1 from offsite_event_staff where event_id = p_event_id and staff_id = auth.uid());
$$ language sql security definer stable;

alter table offsite_events enable row level security;
alter table offsite_event_staff enable row level security;
alter table offsite_checklist_templates enable row level security;
alter table offsite_checklist_items enable row level security;

create policy "staff read offsite_events" on offsite_events for select using (is_staff());
create policy "schedulers write offsite_events" on offsite_events for all
  using (can_schedule()) with check (can_schedule());

create policy "staff read offsite_event_staff" on offsite_event_staff for select using (is_staff());
create policy "schedulers write offsite_event_staff" on offsite_event_staff for all
  using (can_schedule()) with check (can_schedule());

create policy "staff read offsite_checklist_templates" on offsite_checklist_templates for select using (is_staff());
create policy "schedulers write offsite_checklist_templates" on offsite_checklist_templates for all
  using (can_schedule()) with check (can_schedule());

create policy "staff read offsite_checklist_items" on offsite_checklist_items for select using (is_staff());
create policy "schedulers write offsite_checklist_items" on offsite_checklist_items for all
  using (can_schedule()) with check (can_schedule());
create policy "event staff write their checklist" on offsite_checklist_items for all
  using (event_id is not null and is_offsite_event_staff(event_id))
  with check (event_id is not null and is_offsite_event_staff(event_id));
