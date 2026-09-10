-- ============================================================
-- Migration 014 — staff_profiles.email, for matching "my shifts"
-- ============================================================
-- Root cause of shifts not showing up on My Shifts: demo/placeholder
-- profiles (seeded in migration_008, before real logins existed)
-- share a name with a real, auth-linked profile but have a
-- different id — so a shift assigned to the wrong same-named entry
-- in a picker never matches the logged-in session's id. Matching by
-- email instead lets the app pull shifts assigned to either row.

alter table staff_profiles add column if not exists email text;

-- Backfill real, already-linked accounts (id already equals their
-- auth.users id) — demo/placeholder rows are left null since they
-- aren't tied to a real login.
update staff_profiles sp
set email = au.email
from auth.users au
where sp.id = au.id and sp.email is null;

-- Link the "Ricky Greenfield" demo placeholder row (seeded in
-- migration_008, no real login) to the same email as the real
-- account, so shifts assigned to either one show up on My Shifts.
update staff_profiles
set email = 'ricky.greenfield@axiomfwd.com'
where name = 'Ricky Greenfield' and email is null;
