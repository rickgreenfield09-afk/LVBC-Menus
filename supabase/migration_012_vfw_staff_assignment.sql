-- ============================================================
-- Migration 012 — Staff assignment for VFW events only
-- ============================================================
-- Events generally don't need a staffer assigned, but VFW night is
-- the one exception (a liaison needs to be on-site). One-off events
-- get a plain staff_id; recurring events already have
-- default_staff_id + a per-occurrence override column from
-- migration_011 — both were just unused in the UI until now.

alter table events add column if not exists staff_id uuid references staff_profiles(id) on delete set null;
