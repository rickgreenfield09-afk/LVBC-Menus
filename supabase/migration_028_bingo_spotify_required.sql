-- ============================================================
-- Migration 028 — every bingo song must be a Spotify track
-- ============================================================
-- Songs can only come from Spotify search, so each one is spelled one
-- way and its usage is counted against that one entry. The first
-- person to add a song chooses the version everyone uses after that:
-- picking another version later (same cleaned title + artist) reuses
-- the existing song instead of adding a second one.
--
-- Songs typed in before this (the manual import) are linked one at a
-- time from the Song Bank tab with link_bingo_song(). Linking replaces
-- the typed title/artist with Spotify's; if the pick is a song that's
-- already in the bank, the two are merged (usage counts combined).
--
-- Enforcement:
--   * new songs must have a spotify_track_id (insert trigger), and a
--     linked song can never be unlinked (update trigger). Once every
--     old song is linked, the column can be made NOT NULL.
--   * a game can only be printed from playlists whose songs are all
--     linked and whose Spotify copy is up to date (spotify_dirty is
--     set by every save/link, cleared by api/spotify-sync-playlist).

alter table bingo_playlists add column spotify_dirty boolean not null default true;

create or replace function bingo_songs_require_spotify()
returns trigger as $$
begin
  if tg_op = 'INSERT' and new.spotify_track_id is null then
    raise exception 'Songs must be picked from Spotify';
  end if;
  if tg_op = 'UPDATE' and old.spotify_track_id is not null and new.spotify_track_id is null then
    raise exception 'A song linked to Spotify can''t be unlinked';
  end if;
  return new;
end;
$$ language plpgsql;

create trigger bingo_songs_require_spotify
  before insert or update on bingo_songs
  for each row execute function bingo_songs_require_spotify();

-- ---------- save_bingo_playlist: Spotify picks only ----------
-- Every song must carry spotify_track_id. Matched to the bank by track
-- id, then by title+artist (another version of a song already in the
-- bank — the bank's version wins). A not-yet-linked old song matched by
-- name takes this pick's track and spelling.
create or replace function save_bingo_playlist(p_id uuid, p_title text, p_notes text, p_songs jsonb)
returns uuid as $$
declare
  v_id uuid := p_id;
  v_song jsonb;
  v_song_id uuid;
  v_song_track text;
  v_track text;
  v_pos int := 0;
begin
  if not is_staff() then raise exception 'Not authorized'; end if;
  if coalesce(trim(p_title), '') = '' then raise exception 'Playlist title is required'; end if;
  if jsonb_array_length(coalesce(p_songs, '[]'::jsonb)) > 24 then
    raise exception 'A playlist holds at most 24 songs';
  end if;

  if v_id is null then
    insert into bingo_playlists (title, notes, created_by)
    values (trim(p_title), nullif(trim(p_notes), ''), auth.uid())
    returning id into v_id;
  else
    update bingo_playlists set title = trim(p_title), notes = nullif(trim(p_notes), ''), spotify_dirty = true where id = v_id;
    if not found then raise exception 'Playlist not found'; end if;
    delete from bingo_playlist_songs where playlist_id = v_id;
  end if;

  for v_song in select * from jsonb_array_elements(coalesce(p_songs, '[]'::jsonb)) loop
    v_pos := v_pos + 1;
    v_track := nullif(trim(v_song->>'spotify_track_id'), '');
    if v_track is null then
      raise exception '"%" isn''t linked to Spotify — link it in the Song Bank or pick it from Spotify search', v_song->>'title';
    end if;

    v_song_id := null;
    select id, spotify_track_id into v_song_id, v_song_track from bingo_songs where spotify_track_id = v_track;
    if v_song_id is null then
      select id, spotify_track_id into v_song_id, v_song_track from bingo_songs
        where lower(trim(title)) = lower(trim(v_song->>'title'))
          and lower(trim(artist)) = lower(trim(v_song->>'artist'));
    end if;

    if v_song_id is null then
      insert into bingo_songs (title, artist, clip_start_seconds, clip_end_seconds, spotify_track_id, created_by)
      values (trim(v_song->>'title'), trim(v_song->>'artist'),
              (v_song->>'clip_start_seconds')::int, (v_song->>'clip_end_seconds')::int, v_track, auth.uid())
      returning id into v_song_id;
    elsif v_song_track is null then
      update bingo_songs set
        title = trim(v_song->>'title'), artist = trim(v_song->>'artist'), spotify_track_id = v_track,
        clip_start_seconds = (v_song->>'clip_start_seconds')::int,
        clip_end_seconds = (v_song->>'clip_end_seconds')::int
      where id = v_song_id;
    else
      update bingo_songs set
        clip_start_seconds = (v_song->>'clip_start_seconds')::int,
        clip_end_seconds = (v_song->>'clip_end_seconds')::int
      where id = v_song_id;
    end if;

    begin
      insert into bingo_playlist_songs (playlist_id, song_id, position) values (v_id, v_song_id, v_pos);
    exception when unique_violation then
      raise exception '"%" by % is on this playlist twice', v_song->>'title', v_song->>'artist';
    end;
  end loop;

  return v_id;
end;
$$ language plpgsql security invoker;

-- ---------- link an old (typed-in) song to a Spotify track ----------
-- p_title/p_artist are Spotify's (cleaned) spelling. If the track, or
-- another song with that spelling, is already in the bank, this song
-- is merged into it: playlists point at the bank's song, usage counts
-- are combined, and this row is removed. Returns the surviving song id.
-- Security definer because a merge deletes a song (admin-only by RLS).
create or replace function link_bingo_song(p_song_id uuid, p_track_id text, p_title text, p_artist text)
returns uuid as $$
declare
  v_old bingo_songs%rowtype;
  v_keep bingo_songs%rowtype;
begin
  if not is_staff() then raise exception 'Not authorized'; end if;
  if coalesce(trim(p_track_id), '') = '' or coalesce(trim(p_title), '') = '' or coalesce(trim(p_artist), '') = '' then
    raise exception 'Missing Spotify track details';
  end if;

  select * into v_old from bingo_songs where id = p_song_id for update;
  if not found then raise exception 'Song not found'; end if;
  if v_old.spotify_track_id is not null then raise exception '"%" is already linked to Spotify', v_old.title; end if;

  select * into v_keep from bingo_songs where spotify_track_id = trim(p_track_id) and id <> p_song_id;
  if not found then
    select * into v_keep from bingo_songs
      where lower(trim(title)) = lower(trim(p_title)) and lower(trim(artist)) = lower(trim(p_artist)) and id <> p_song_id;
  end if;

  if v_keep.id is null then
    update bingo_songs set spotify_track_id = trim(p_track_id), title = trim(p_title), artist = trim(p_artist) where id = p_song_id;
    update bingo_playlists set spotify_dirty = true
      where id in (select playlist_id from bingo_playlist_songs where song_id = p_song_id);
    return p_song_id;
  end if;

  -- Merge v_old into v_keep.
  update bingo_playlists set spotify_dirty = true
    where id in (select playlist_id from bingo_playlist_songs where song_id in (p_song_id, v_keep.id));
  update bingo_playlist_songs set song_id = v_keep.id
    where song_id = p_song_id
      and playlist_id not in (select playlist_id from bingo_playlist_songs where song_id = v_keep.id);
  delete from bingo_playlist_songs where song_id = p_song_id;  -- playlist already had v_keep
  update bingo_songs set
    times_used = v_keep.times_used + v_old.times_used,
    last_used_on = greatest(v_keep.last_used_on, v_old.last_used_on),
    clip_start_seconds = coalesce(v_keep.clip_start_seconds, v_old.clip_start_seconds),
    clip_end_seconds = coalesce(v_keep.clip_end_seconds, v_old.clip_end_seconds),
    -- an unlinked name-match takes this track and spelling
    spotify_track_id = coalesce(v_keep.spotify_track_id, trim(p_track_id)),
    title = case when v_keep.spotify_track_id is null then trim(p_title) else v_keep.title end,
    artist = case when v_keep.spotify_track_id is null then trim(p_artist) else v_keep.artist end
  where id = v_keep.id;
  delete from bingo_songs where id = p_song_id;
  return v_keep.id;
end;
$$ language plpgsql security definer set search_path = public;

grant execute on function link_bingo_song(uuid, text, text, text) to authenticated;

-- ---------- create_bingo_game: Spotify must be ready ----------
-- Same as migration_025 plus two checks per playlist: every song is
-- linked, and the Spotify copy is current.
create or replace function create_bingo_game(
  p_event_date date,
  p_sheet_count int,
  p_rounds jsonb,
  p_sheet_events jsonb,
  p_slide_events jsonb
) returns uuid as $$
declare
  v_today date := (now() at time zone 'America/Chicago')::date;
  v_game_id uuid;
  v_round jsonb;
  v_round_no int;
  v_playlist bingo_playlists%rowtype;
  v_pattern bingo_patterns%rowtype;
  v_songs jsonb;
  v_song_count int;
  v_overridden boolean := false;
  v_sheet int;
begin
  if not is_staff() then raise exception 'Not authorized'; end if;
  if p_sheet_count is null or p_sheet_count < 1 or p_sheet_count > 200 then
    raise exception 'Sheet count must be between 1 and 200';
  end if;
  if jsonb_array_length(coalesce(p_rounds, '[]'::jsonb)) <> 3 then
    raise exception 'A game needs exactly 3 rounds';
  end if;
  if (select count(distinct r->>'playlist_id') from jsonb_array_elements(p_rounds) r) <> 3 then
    raise exception 'Pick 3 different playlists';
  end if;

  insert into bingo_games (event_date, printed_on, printed_by, sheet_count, sheet_events, slide_events)
  values (p_event_date, v_today, auth.uid(), p_sheet_count,
          coalesce(p_sheet_events, '[]'::jsonb), coalesce(p_slide_events, '[]'::jsonb))
  returning id into v_game_id;

  for v_round in select * from jsonb_array_elements(p_rounds) loop
    v_round_no := (v_round->>'round_no')::int;
    if v_round_no not between 1 and 3 then raise exception 'Bad round number'; end if;

    select * into v_playlist from bingo_playlists where id = (v_round->>'playlist_id')::uuid for update;
    if not found then raise exception 'Round %: playlist not found', v_round_no; end if;

    select count(*), jsonb_agg(jsonb_build_object('id', s.id, 'title', s.title, 'artist', s.artist) order by ps.position)
      into v_song_count, v_songs
      from bingo_playlist_songs ps join bingo_songs s on s.id = ps.song_id
      where ps.playlist_id = v_playlist.id;
    if v_song_count <> 24 then
      raise exception '"%" has % songs — a playlist needs exactly 24', v_playlist.title, v_song_count;
    end if;

    if exists (select 1 from bingo_playlist_songs ps join bingo_songs s on s.id = ps.song_id
               where ps.playlist_id = v_playlist.id and s.spotify_track_id is null) then
      raise exception '"%" has songs that aren''t linked to Spotify — link them in the Song Bank first', v_playlist.title;
    end if;
    if v_playlist.spotify_playlist_id is null or v_playlist.spotify_dirty then
      raise exception '"%" isn''t synced to Spotify yet — click Sync on the Playlists tab first', v_playlist.title;
    end if;

    if v_playlist.last_used_on is not null and v_playlist.last_used_on + 90 > v_today then
      if not is_admin() then
        raise exception '"%" was used on % and is not ready again until %',
          v_playlist.title, v_playlist.last_used_on, v_playlist.last_used_on + 90;
      end if;
      v_overridden := true;
    end if;

    if v_round_no = 1 then
      insert into bingo_game_rounds (game_id, round_no, playlist_id, playlist_title, songs, pattern_name, pattern_cells)
      values (v_game_id, 1, v_playlist.id, v_playlist.title, v_songs, '5 in a Row', null);
    else
      select * into v_pattern from bingo_patterns where id = (v_round->>'pattern_id')::uuid;
      if not found then raise exception 'Round %: pick a win pattern', v_round_no; end if;
      insert into bingo_game_rounds (game_id, round_no, playlist_id, playlist_title, songs, pattern_id, pattern_name, pattern_cells)
      values (v_game_id, v_round_no, v_playlist.id, v_playlist.title, v_songs, v_pattern.id, v_pattern.name, v_pattern.cells);
    end if;

    for v_sheet in 1..p_sheet_count loop
      insert into bingo_game_cards (game_id, round_no, sheet_no, song_order)
      values (v_game_id, v_round_no, v_sheet,
              (select array_agg(i::smallint order by random()) from generate_series(0, 23) i));
    end loop;

    update bingo_playlists set last_used_on = v_today, times_used = times_used + 1 where id = v_playlist.id;
    update bingo_songs set last_used_on = v_today, times_used = times_used + 1
      where id in (select song_id from bingo_playlist_songs where playlist_id = v_playlist.id);
  end loop;

  if (select count(distinct round_no) from bingo_game_rounds where game_id = v_game_id) <> 3 then
    raise exception 'Rounds must be numbered 1, 2 and 3';
  end if;

  update bingo_games set cooldown_overridden = v_overridden where id = v_game_id;
  return v_game_id;
end;
$$ language plpgsql security definer set search_path = public;
