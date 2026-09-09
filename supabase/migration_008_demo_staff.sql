-- ============================================================
-- Migration 008 — Demo staff roster (temporary, pre-auth)
-- ============================================================
-- staff_profiles.id normally references auth.users(id) — every
-- profile is supposed to be tied to a real login. For the scheduling
-- demo we need named profiles before those logins exist, so this
-- temporarily drops that FK and seeds placeholder rows.
--
-- Bartenders -> role 'staff'. Management -> role 'admin' with
-- can_schedule = true (can build the schedule + stand as MOD).
--
-- When real auth accounts exist for these people, either:
--   1) create/invite the auth.users row for each person, then run
--      `update staff_profiles set id = '<real-auth-id>' where name = '...'`
--      to relink the existing row (keeps their can_schedule flag etc), or
--   2) delete a placeholder row and insert a fresh one once that
--      person signs in for the first time.
-- Once every staff_profiles row is backed by a real auth.users row,
-- re-add the constraint this migration drops:
--   alter table staff_profiles add constraint staff_profiles_id_fkey
--     foreign key (id) references auth.users(id) on delete cascade;

alter table staff_profiles drop constraint if exists staff_profiles_id_fkey;

insert into staff_profiles (id, name, role, can_schedule) values
  (gen_random_uuid(), 'Ricky Greenfield', 'staff', false),
  (gen_random_uuid(), 'Brianna Stovall',  'staff', false),
  (gen_random_uuid(), 'Aaron Payne',      'staff', false),
  (gen_random_uuid(), 'Victoria Romer',   'staff', false),
  (gen_random_uuid(), 'Allison Morton',   'staff', false),
  (gen_random_uuid(), 'Tait Ralston',     'staff', false),
  (gen_random_uuid(), 'Amanda Wright',    'staff', false),
  (gen_random_uuid(), 'Dylan Byerly',     'admin', true),
  (gen_random_uuid(), 'Mark Norman',      'admin', true),
  (gen_random_uuid(), 'Samantha Norman',  'admin', true);
