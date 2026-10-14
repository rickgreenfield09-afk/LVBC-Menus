-- ============================================================
-- Migration 043 — Staff phone numbers
-- ============================================================
-- Every staffer keeps a phone number on their profile so the Team
-- page in the staff phone app can text or call them, one person or a
-- group. Stored as +1 and ten digits (US numbers only); the apps
-- format it for display.
--
-- A staffer edits their own number: the "own profile self-update"
-- policy from migration_019 already allows it, and phone is not one of
-- the admin-only columns protect_staff_profile_fields() locks. Admins
-- can set it from Admin > Staff too.
--
-- The column has to allow null for profiles that exist today; the
-- apps require a number before letting a staffer in.

alter table staff_profiles add column if not exists phone text;
alter table staff_profiles add constraint staff_profiles_phone_format
  check (phone is null or phone ~ '^\+1[0-9]{10}$');
