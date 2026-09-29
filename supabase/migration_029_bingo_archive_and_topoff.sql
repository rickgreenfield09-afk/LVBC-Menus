-- ============================================================
-- Migration 029 — archive playlists, top off a printed game
-- ============================================================
-- ARCHIVE: "Delete" on a playlist now archives it instead: the row and
-- its songs stay (so song history/usage is intact and it can be
-- restored), it drops out of every list and the game picker, and its
-- Spotify copy is removed from the brewery account (done by
-- api/spotify-sync-playlist.js, action "remove", before archiving).
-- Restoring clears archived_at; the next sync makes a fresh Spotify
-- copy. Admins can still delete an archived playlist for good.
--
-- TOP OFF: prints extra sheets for a game that's already been printed
-- — more players showed up. New sheets continue the numbering (41,
-- 42, …) and every new card is checked against every card already in
-- that round by the existing unique (game_id, round_no, song_order),
-- so no top-off card can repeat one from the original run. It's the
-- same game night, so usage counts don't change. Each top-off is
-- logged so its batch can be reprinted on its own.

alter table bingo_playlists
  add column archived_at timestamptz,
  add column archived_by uuid references staff_profiles(id) on delete set null;

-- Archiving follows the old delete rule (creator or admin); anyone on
-- staff can restore.
create or replace function set_bingo_playlist_archived(p_id uuid, p_archived boolean)
returns void as $$
declare
  v_pl bingo_playlists%rowtype;
begin
  if not is_staff() then raise exception 'Not authorized'; end if;
  select * into v_pl from bingo_playlists where id = p_id for update;
  if not found then raise exception 'Playlist not found'; end if;

  if p_archived then
    if not (is_admin() or v_pl.created_by = auth.uid()) then
      raise exception 'Only the person who made this playlist, or an admin, can delete it';
    end if;
    update bingo_playlists set archived_at = now(), archived_by = auth.uid(),
      spotify_playlist_id = null, spotify_synced_at = null, spotify_dirty = true
    where id = p_id;
  else
    update bingo_playlists set archived_at = null, archived_by = null, spotify_dirty = true where id = p_id;
  end if;
end;
$$ language plpgsql security definer set search_path = public;

grant execute on function set_bingo_playlist_archived(uuid, boolean) to authenticated;

-- An archived playlist can't be printed.
create or replace function bingo_rounds_reject_archived()
returns trigger as $$
declare
  v_title text;
begin
  select title into v_title from bingo_playlists where id = new.playlist_id and archived_at is not null;
  if v_title is not null then
    raise exception '"%" is archived — restore it on the Playlists tab first', v_title;
  end if;
  return new;
end;
$$ language plpgsql;

create trigger bingo_rounds_reject_archived
  before insert on bingo_game_rounds
  for each row execute function bingo_rounds_reject_archived();

-- ---------- TOP OFF ----------
create table bingo_game_topoffs (
  id uuid primary key default gen_random_uuid(),
  game_id uuid not null references bingo_games(id) on delete cascade,
  from_sheet int not null,
  to_sheet int not null,
  printed_by uuid references staff_profiles(id) on delete set null,
  printed_at timestamptz not null default now()
);

create index bingo_game_topoffs_game_idx on bingo_game_topoffs (game_id);

alter table bingo_game_topoffs enable row level security;
create policy "staff read bingo_game_topoffs" on bingo_game_topoffs for select using (is_staff());

-- Returns the first new sheet number. A shuffle that happens to match
-- an existing card in its round (astronomically unlikely with 24! ways
-- to order 24 songs) is simply re-drawn.
create or replace function top_off_bingo_game(p_game_id uuid, p_extra int)
returns int as $$
declare
  v_game bingo_games%rowtype;
  v_from int;
  v_round int;
  v_sheet int;
  v_tries int;
begin
  if not is_staff() then raise exception 'Not authorized'; end if;
  select * into v_game from bingo_games where id = p_game_id for update;
  if not found then raise exception 'Game not found'; end if;
  if p_extra is null or p_extra < 1 then raise exception 'Print at least 1 extra sheet'; end if;
  if v_game.sheet_count + p_extra > 200 then
    raise exception 'A game can have at most 200 sheets (this one has %)', v_game.sheet_count;
  end if;

  v_from := v_game.sheet_count + 1;
  for v_round in 1..3 loop
    for v_sheet in v_from..(v_game.sheet_count + p_extra) loop
      v_tries := 0;
      loop
        begin
          insert into bingo_game_cards (game_id, round_no, sheet_no, song_order)
          values (p_game_id, v_round, v_sheet,
                  (select array_agg(i::smallint order by random()) from generate_series(0, 23) i));
          exit;
        exception when unique_violation then
          v_tries := v_tries + 1;
          if v_tries >= 20 then raise exception 'Could not generate a unique card — try again'; end if;
        end;
      end loop;
    end loop;
  end loop;

  update bingo_games set sheet_count = sheet_count + p_extra where id = p_game_id;
  insert into bingo_game_topoffs (game_id, from_sheet, to_sheet, printed_by)
  values (p_game_id, v_from, v_game.sheet_count + p_extra, auth.uid());
  return v_from;
end;
$$ language plpgsql security definer set search_path = public;

grant execute on function top_off_bingo_game(uuid, int) to authenticated;
