-- ============================================================
-- Migration 026 — delete a printed Music Bingo game (admin only)
-- ============================================================
-- Mostly for trying the feature out: deleting a game removes its
-- snapshot/cards (cascade) and reverses what create_bingo_game() did
-- to the usage counters, so a test print doesn't lock a playlist into
-- its 90-day cooldown.
--
-- last_used_on is only rolled back when it still equals the deleted
-- game's print date; then it falls back to the most recent other game
-- that used the playlist/song, or null. If it holds some other date
-- (e.g. set by a manual import), it's left alone.

create or replace function delete_bingo_game(p_game_id uuid)
returns void as $$
declare
  v_game bingo_games%rowtype;
  v_round bingo_game_rounds%rowtype;
begin
  if not is_admin() then raise exception 'Only admins can delete a game'; end if;
  select * into v_game from bingo_games where id = p_game_id for update;
  if not found then raise exception 'Game not found'; end if;

  for v_round in select * from bingo_game_rounds where game_id = p_game_id loop
    update bingo_playlists p set
      times_used = greatest(p.times_used - 1, 0),
      last_used_on = case when p.last_used_on = v_game.printed_on then (
        select max(g.printed_on) from bingo_games g
        join bingo_game_rounds r on r.game_id = g.id
        where r.playlist_id = p.id and g.id <> p_game_id
      ) else p.last_used_on end
    where p.id = v_round.playlist_id;

    update bingo_songs s set
      times_used = greatest(s.times_used - 1, 0),
      last_used_on = case when s.last_used_on = v_game.printed_on then (
        select max(g.printed_on) from bingo_games g
        join bingo_game_rounds r on r.game_id = g.id
        where g.id <> p_game_id and r.songs @> jsonb_build_array(jsonb_build_object('id', s.id))
      ) else s.last_used_on end
    where s.id in (select (e->>'id')::uuid from jsonb_array_elements(v_round.songs) e);
  end loop;

  delete from bingo_games where id = p_game_id;
end;
$$ language plpgsql security definer set search_path = public;

grant execute on function delete_bingo_game(uuid) to authenticated;
