-- ============================================================
-- Migration 010 — Audit log + events management tightened
-- ============================================================

-- Append-only edit trail for scheduler actions (shift add/remove,
-- event add/edit/delete). Not surfaced anywhere yet beyond a raw
-- table — a proper "activity" view is a fast-follow.
create table audit_log (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid references staff_profiles(id) on delete set null,
  action text not null,
  entity_type text not null,
  entity_id uuid,
  detail jsonb,
  created_at timestamptz not null default now()
);

create index audit_log_entity_idx on audit_log (entity_type, entity_id);

alter table audit_log enable row level security;

create policy "schedulers read audit log" on audit_log for select using (can_schedule());
create policy "schedulers write audit log" on audit_log for insert with check (can_schedule());

-- Events management is moving under Schedule as an admin-only
-- sub-page — tighten writes from "any staff" to schedulers/admins.
-- Public read stays (needed for the public calendar embed + every
-- staffer's own calendar view).
drop policy if exists "staff write events" on events;
create policy "schedulers write events" on events for all
  using (can_schedule()) with check (can_schedule());
