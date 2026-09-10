-- ============================================================
-- Migration 015 — Shift coverage requests (lightweight, v1)
-- ============================================================
-- A staffer flags one of their own shifts as needing coverage, with
-- an optional note. Any staff can see open requests and claim one.
-- No email notification yet (Resend isn't wired up) — "notify" is
-- in-app visibility only, on My Shifts, for now.

create table coverage_requests (
  id uuid primary key default gen_random_uuid(),
  shift_id uuid not null references shifts(id) on delete cascade,
  requested_by uuid not null references staff_profiles(id) on delete cascade,
  note text,
  status text not null check (status in ('open','claimed','cancelled')) default 'open',
  claimed_by uuid references staff_profiles(id) on delete set null,
  claimed_at timestamptz,
  created_at timestamptz not null default now()
);

create index coverage_requests_shift_idx on coverage_requests (shift_id);
create index coverage_requests_status_idx on coverage_requests (status);

alter table coverage_requests enable row level security;

create policy "staff read coverage requests" on coverage_requests for select using (is_staff());
create policy "staff create own coverage requests" on coverage_requests for insert
  with check (requested_by = auth.uid());
create policy "staff update coverage requests" on coverage_requests for update
  using (is_staff()) with check (is_staff());
create policy "staff delete own coverage requests" on coverage_requests for delete
  using (requested_by = auth.uid() or can_schedule());
