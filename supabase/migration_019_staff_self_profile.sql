-- ============================================================
-- Migration 019 — Staff self-service profile (name + photo)
-- ============================================================
-- Lets a signed-in staffer edit their OWN name and upload a profile
-- photo, without needing admin rights. role/position/can_schedule/
-- email stay admin-only — enforced by a trigger, not just RLS, so a
-- self-update can never smuggle in a privilege change even via a
-- raw API call that bypasses the app's own UI.

alter table staff_profiles add column photo_url text;

create policy "own profile self-update" on staff_profiles for update
  using (id = auth.uid()) with check (id = auth.uid());

create or replace function protect_staff_profile_fields()
returns trigger as $$
begin
  if not is_admin() then
    new.role := old.role;
    new.position := old.position;
    new.can_schedule := old.can_schedule;
    new.email := old.email;
  end if;
  return new;
end;
$$ language plpgsql security definer;

create trigger staff_profiles_protect_fields
  before update on staff_profiles
  for each row execute function protect_staff_profile_fields();

-- Storage: a staffer can upload/replace their own photo under
-- assets/staff/<their-uid>/... without needing admin — the existing
-- "admin write assets" policy is untouched for beer/wine photos.
create policy "staff upload own photo" on storage.objects for insert
  with check (
    bucket_id = 'assets'
    and (storage.foldername(name))[1] = 'staff'
    and (storage.foldername(name))[2] = auth.uid()::text
  );
create policy "staff update own photo" on storage.objects for update
  using (
    bucket_id = 'assets'
    and (storage.foldername(name))[1] = 'staff'
    and (storage.foldername(name))[2] = auth.uid()::text
  ) with check (
    bucket_id = 'assets'
    and (storage.foldername(name))[1] = 'staff'
    and (storage.foldername(name))[2] = auth.uid()::text
  );
