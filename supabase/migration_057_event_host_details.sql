-- ============================================================
-- Migration 057 — Host details on events, link to requests
-- ============================================================
-- The Events tab now mirrors what the public request form collects
-- (migration_055). An event can carry the host's organization, contact
-- and guest count, and remembers the request it was converted from.
-- Safe to re-run.

alter table events add column if not exists organization text;
alter table events add column if not exists contact_name text;
alter table events add column if not exists contact_email text;
alter table events add column if not exists contact_phone text;
alter table events add column if not exists guest_count int;
alter table events add column if not exists request_id uuid references event_requests(id) on delete set null;
