-- ============================================================
-- Migration 031 — email Music Bingo materials on print
-- ============================================================
-- Printing a game also emails PDFs of the card sheets, TV slideshow
-- and host call sheet (api/email-bingo-game.js) to every staff member
-- whose profile has receives_bingo_materials on — set per person by an
-- admin on the Admin screen. Starts with Dylan and Samantha.
--
-- bingo_games records the last send (or failure) so History can show
-- it and offer "Email Again".

alter table staff_profiles add column receives_bingo_materials boolean not null default false;

-- Admin-only, like role/position: a staffer's self-update can't flip it.
create or replace function protect_staff_profile_fields()
returns trigger as $$
begin
  if not is_admin() then
    new.role := old.role;
    new.position := old.position;
    new.can_schedule := old.can_schedule;
    new.email := old.email;
    new.receives_bingo_materials := old.receives_bingo_materials;
  end if;
  return new;
end;
$$ language plpgsql security definer;

update staff_profiles set receives_bingo_materials = true
  where lower(email) in ('dylan@lagovistabrewingco.com', 'samantha@lagovistabrewingco.com');

alter table bingo_games
  add column materials_emailed_at timestamptz,
  add column materials_emailed_to text[],
  add column materials_email_error text;
