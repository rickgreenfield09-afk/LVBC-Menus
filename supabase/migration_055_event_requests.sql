-- ============================================================
-- Migration 055 — Public event requests
-- ============================================================
-- Submitted from event-request.html (embedded in the brewery website)
-- through api/event-request.js, which inserts with the service role.
-- Staff can read and update them; nobody else touches the table.
-- Safe to re-run.

create table if not exists event_requests (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  name text not null,
  organization text,
  email text not null,
  phone text,
  event_type text not null,
  event_date date not null,
  alt_date date,
  start_time text,
  end_time text,
  guest_count int,
  details text,
  status text not null default 'new' check (status in ('new', 'contacted', 'confirmed', 'declined')),
  staff_notes text
);

-- Covers a table created by an earlier run of this file, before this column existed.
alter table event_requests add column if not exists organization text;

alter table event_requests enable row level security;
drop policy if exists "staff read event_requests" on event_requests;
create policy "staff read event_requests" on event_requests for select using (is_staff());
drop policy if exists "staff update event_requests" on event_requests;
create policy "staff update event_requests" on event_requests for update using (is_staff());
