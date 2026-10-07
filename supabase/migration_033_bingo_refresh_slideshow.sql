-- ============================================================
-- Migration 033 — refresh a printed game's TV slideshow events
-- ============================================================
-- The slideshow isn't printed, and its "Coming Up" slide looks two
-- weeks ahead — so an event fixed on the calendar after the cards were
-- printed (a misspelled name, a time change) should be able to reach
-- the slideshow without touching anything else. This replaces only
-- bingo_games.slide_events; the printed sheets' own one-week list
-- (sheet_events), the cards and the usage counts are untouched.
-- Admin only. The call sheet reads the same list, so one opened or
-- emailed afterwards shows the refreshed events too.

create or replace function set_bingo_game_slide_events(p_game_id uuid, p_events jsonb)
returns void as $$
begin
  if not is_admin() then raise exception 'Only admins can refresh a game''s slideshow'; end if;
  if p_events is null or jsonb_typeof(p_events) <> 'array' then raise exception 'Events must be a list'; end if;
  update bingo_games set slide_events = p_events where id = p_game_id;
  if not found then raise exception 'Game not found'; end if;
end;
$$ language plpgsql security definer set search_path = public;

grant execute on function set_bingo_game_slide_events(uuid, jsonb) to authenticated;
