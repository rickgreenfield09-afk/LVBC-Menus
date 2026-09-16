-- ============================================================
-- Migration 017 — Separate job position from app permission role
-- ============================================================
-- staff_profiles.role ('admin'/'staff') has been doing double duty:
-- it's both "can manage the portal" (RLS, admin screen access) AND,
-- via a hardcoded shortcut in js/schedule.js's populateStaffSelect(),
-- a stand-in for "is a real-world Manager eligible for MOD shifts."
-- That's wrong whenever an admin isn't a Manager (or vice versa).
--
-- This splits them: `position` is the person's actual job (Bartender/
-- Cellarman/Manager) and `role` becomes a pure portal permission
-- (admin/user). schedule.js's MOD-eligibility filter is updated in
-- the same change to key off `position`, not `role`.

alter table staff_profiles
  add column position text not null default 'bartender'
    check (position in ('bartender','cellarman','manager'));

-- Relax the old role constraint BEFORE writing 'user' values below —
-- otherwise the update itself violates the still-active old check.
alter table staff_profiles drop constraint if exists staff_profiles_role_check;

-- Preserve today's MOD-assignment behavior: every current admin except
-- the one known bartender-who-happens-to-be-an-admin keeps the
-- Manager position so they remain pickable for MOD shifts right after
-- this migration runs.
update staff_profiles
  set position = 'manager'
  where role = 'admin' and email <> 'ricky.greenfield@axiomfwd.com';

update staff_profiles set role = 'user' where role = 'staff';

alter table staff_profiles
  add constraint staff_profiles_role_check check (role in ('admin','user'));
alter table staff_profiles alter column role set default 'user';
