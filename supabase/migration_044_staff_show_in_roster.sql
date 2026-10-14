-- ============================================================
-- Migration 044 — Hide a staffer from the phone app's Team page
-- ============================================================
-- staff_profiles.show_in_roster: admins untick it in Admin > Staff for
-- anyone who shouldn't appear on the staff phone app's Team page (a
-- placeholder profile, someone no longer working shifts). It only
-- hides them from that list — their login, shifts and history are
-- untouched.
--
-- Admin-only: protect_staff_profile_fields() now restores it on a
-- staffer's own update, alongside role, position and the rest.

alter table staff_profiles add column if not exists show_in_roster boolean not null default true;

create or replace function protect_staff_profile_fields()
returns trigger as $$
begin
  if not is_admin() then
    new.role := old.role;
    new.position := old.position;
    new.can_schedule := old.can_schedule;
    new.email := old.email;
    new.receives_bingo_materials := old.receives_bingo_materials;
    new.show_in_roster := old.show_in_roster;
  end if;
  return new;
end;
$$ language plpgsql security definer;
