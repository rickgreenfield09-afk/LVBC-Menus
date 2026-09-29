-- ============================================================
-- Migration 030 — Link placeholder staff profiles to real logins
-- ============================================================
-- The migration_008 placeholder rows have random ids with no
-- auth.users match, so those people can't sign in, and inviting them
-- through Admin → Add Staff would just create a second same-named
-- profile with none of their shift history.
--
-- link_staff_login() re-keys a profile onto a real auth.users id:
-- every foreign key pointing at the old staff_profiles id (shifts,
-- blackouts, coverage requests, audit log, created_by columns, ...)
-- is repointed to the new id, then the old row is removed. If the
-- auth account already has its own profile (a duplicate), the old
-- row is merged into it instead. It walks pg_constraint rather than
-- a hardcoded table list so future FKs to staff_profiles are covered
-- automatically.
--
-- Called by api/update-staff-email.js with the admin's own token
-- (not the service key) so is_admin() — and the
-- protect_staff_profile_fields trigger — see a real admin.

create or replace function link_staff_login(p_old_id uuid, p_new_id uuid, p_email text)
returns staff_profiles as $$
declare
  fk record;
  result staff_profiles;
begin
  if not is_admin() then
    raise exception 'Only admins can link staff logins.';
  end if;
  if not exists (select 1 from auth.users where id = p_new_id) then
    raise exception 'No login exists with id %', p_new_id;
  end if;
  if p_old_id = p_new_id then
    update staff_profiles set email = p_email where id = p_new_id returning * into result;
    return result;
  end if;

  if exists (select 1 from staff_profiles where id = p_new_id) then
    -- Merge into the existing profile, keeping the details the admin
    -- just saved on the old row in the edit form.
    update staff_profiles n
      set name = o.name, role = o.role, position = o.position,
          can_schedule = o.can_schedule, email = p_email,
          photo_url = coalesce(n.photo_url, o.photo_url)
      from staff_profiles o
      where n.id = p_new_id and o.id = p_old_id;
  else
    insert into staff_profiles (id, name, role, position, can_schedule, email, photo_url, created_at)
      select p_new_id, name, role, position, can_schedule, p_email, photo_url, created_at
      from staff_profiles where id = p_old_id;
  end if;

  for fk in
    select c.conrelid::regclass as tbl, a.attname as col
    from pg_constraint c
    join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
    where c.contype = 'f'
      and c.confrelid = 'staff_profiles'::regclass
      and array_length(c.conkey, 1) = 1
  loop
    execute format('update %s set %I = $1 where %I = $2', fk.tbl, fk.col, fk.col)
      using p_new_id, p_old_id;
  end loop;

  delete from staff_profiles where id = p_old_id;

  select * into result from staff_profiles where id = p_new_id;
  return result;
end;
$$ language plpgsql security definer set search_path = public;

revoke all on function link_staff_login(uuid, uuid, text) from public, anon;
grant execute on function link_staff_login(uuid, uuid, text) to authenticated;

-- Which roster rows are backed by a real login — lets Admin show a
-- "No login" badge. auth.users isn't readable from the client, so
-- this is a security definer, admin-only lookup.
create or replace function staff_profiles_with_login()
returns setof uuid as $$
  select sp.id from staff_profiles sp
  join auth.users au on au.id = sp.id
  where is_admin();
$$ language sql security definer stable set search_path = public;

revoke all on function staff_profiles_with_login() from public, anon;
grant execute on function staff_profiles_with_login() to authenticated;
