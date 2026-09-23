-- ============================================================
-- Migration 025 — Music Bingo (v1)
-- ============================================================
-- A game night is 3 rounds, each played from one 24-song playlist.
-- Every player gets one 8.5x11 sheet holding a card per round; each
-- card is the round's same 24 songs in a different shuffle around a
-- free center square.
--
-- bingo_songs is the shared song library — a song can sit on any
-- number of playlists. Title+artist is unique (case-insensitive) so
-- the same song typed on two playlists resolves to one row, and its
-- clip start/stop apply everywhere it's used.
--
-- "Used" means printed: running a game (create_bingo_game) stamps the
-- 3 playlists and every song on them with today's date and bumps
-- their counters. A playlist is back in rotation 90 days after its
-- last use. Only admins can print a playlist that's still cooling
-- down — enforced here, not just in the UI.
--
-- Everything that went into a game (songs, pattern grids, the events
-- printed on the sheet/slideshow, every card's shuffle) is copied
-- into bingo_games / bingo_game_rounds / bingo_game_cards at print
-- time, so later edits to a playlist or pattern never change history
-- and a reprint comes out identical.
--
-- spotify_* columns are unused placeholders for the planned Spotify
-- sync (search-to-add songs, one Spotify playlist per bingo playlist).

-- ---------- SONG LIBRARY ----------
create table bingo_songs (
  id uuid primary key default gen_random_uuid(),
  title text not null check (length(trim(title)) > 0),
  artist text not null check (length(trim(artist)) > 0),
  -- optional clip window, in seconds from the start of the track
  clip_start_seconds int check (clip_start_seconds >= 0),
  clip_end_seconds int check (clip_end_seconds >= 0),
  -- rounds this song has been printed in, across all playlists
  times_used int not null default 0,
  last_used_on date,
  spotify_track_id text unique,
  created_by uuid references staff_profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint bingo_songs_clip_order check (
    clip_start_seconds is null or clip_end_seconds is null or clip_end_seconds > clip_start_seconds
  )
);

create unique index bingo_songs_title_artist_uq on bingo_songs (lower(trim(title)), lower(trim(artist)));

-- ---------- PLAYLISTS ----------
-- A playlist can be saved while still being built, but only one with
-- exactly 24 songs can be printed.
create table bingo_playlists (
  id uuid primary key default gen_random_uuid(),
  title text not null check (length(trim(title)) > 0),
  notes text,
  last_used_on date,
  times_used int not null default 0,
  spotify_playlist_id text,
  spotify_synced_at timestamptz,
  created_by uuid references staff_profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger bingo_playlists_set_updated_at
  before update on bingo_playlists
  for each row execute function set_updated_at();

create table bingo_playlist_songs (
  playlist_id uuid not null references bingo_playlists(id) on delete cascade,
  song_id uuid not null references bingo_songs(id) on delete restrict,
  position int not null check (position between 1 and 24),
  primary key (playlist_id, song_id),
  unique (playlist_id, position)
);

create index bingo_playlist_songs_song_idx on bingo_playlist_songs (song_id);

-- ---------- WIN PATTERNS ----------
-- cells = indexes 0..24 of the 5x5 grid in reading order that must be
-- marked. 12 (the free center) is always implicitly marked and never
-- stored. Round 1 is always "5 in a row" and has no stored pattern.
create table bingo_patterns (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) > 0),
  cells smallint[] not null check (
    cardinality(cells) between 1 and 24
    and cells <@ array[0,1,2,3,4,5,6,7,8,9,10,11,13,14,15,16,17,18,19,20,21,22,23,24]::smallint[]
  ),
  created_by uuid references staff_profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

create unique index bingo_patterns_name_uq on bingo_patterns (lower(trim(name)));

-- ---------- GAMES (print-time snapshot) ----------
create table bingo_games (
  id uuid primary key default gen_random_uuid(),
  -- the night it's played (drives the events printed); the date the
  -- playlists are marked used is printed_on
  event_date date not null,
  printed_on date not null,
  printed_at timestamptz not null default now(),
  printed_by uuid references staff_profiles(id) on delete set null,
  sheet_count int not null check (sheet_count between 1 and 200),
  -- true when an admin printed a playlist still inside its 90 days
  cooldown_overridden boolean not null default false,
  -- [{date, time, name}] as printed on the sheet (event week) and the
  -- slideshow's between-rounds slide (next 2 weeks)
  sheet_events jsonb not null default '[]'::jsonb,
  slide_events jsonb not null default '[]'::jsonb
);

create table bingo_game_rounds (
  game_id uuid not null references bingo_games(id) on delete cascade,
  round_no int not null check (round_no between 1 and 3),
  playlist_id uuid references bingo_playlists(id) on delete set null,
  playlist_title text not null,
  -- [{id, title, artist}] in playlist order; card song_order indexes into this
  songs jsonb not null,
  pattern_id uuid references bingo_patterns(id) on delete set null,
  pattern_name text not null,
  -- null = "5 in a row" (round 1)
  pattern_cells smallint[],
  primary key (game_id, round_no)
);

create table bingo_game_cards (
  game_id uuid not null references bingo_games(id) on delete cascade,
  round_no int not null check (round_no between 1 and 3),
  sheet_no int not null,
  -- 24 indexes into bingo_game_rounds.songs, reading order, skipping the center
  song_order smallint[] not null check (cardinality(song_order) = 24),
  primary key (game_id, round_no, sheet_no),
  -- no two cards in the same round are alike
  unique (game_id, round_no, song_order)
);

-- ---------- RLS ----------
alter table bingo_songs enable row level security;
alter table bingo_playlists enable row level security;
alter table bingo_playlist_songs enable row level security;
alter table bingo_patterns enable row level security;
alter table bingo_games enable row level security;
alter table bingo_game_rounds enable row level security;
alter table bingo_game_cards enable row level security;

-- Any staff can build playlists/patterns; only the creator or an admin
-- can delete one. Games are read-only here — they're only ever written
-- by create_bingo_game().
create policy "staff read bingo_songs" on bingo_songs for select using (is_staff());
create policy "staff insert bingo_songs" on bingo_songs for insert with check (is_staff());
create policy "staff update bingo_songs" on bingo_songs for update using (is_staff()) with check (is_staff());
create policy "admin delete bingo_songs" on bingo_songs for delete using (is_admin());

create policy "staff read bingo_playlists" on bingo_playlists for select using (is_staff());
create policy "staff insert bingo_playlists" on bingo_playlists for insert with check (is_staff());
create policy "staff update bingo_playlists" on bingo_playlists for update using (is_staff()) with check (is_staff());
create policy "owner or admin delete bingo_playlists" on bingo_playlists for delete
  using (is_admin() or created_by = auth.uid());

create policy "staff all bingo_playlist_songs" on bingo_playlist_songs for all
  using (is_staff()) with check (is_staff());

create policy "staff read bingo_patterns" on bingo_patterns for select using (is_staff());
create policy "staff insert bingo_patterns" on bingo_patterns for insert with check (is_staff());
create policy "staff update bingo_patterns" on bingo_patterns for update using (is_staff()) with check (is_staff());
create policy "owner or admin delete bingo_patterns" on bingo_patterns for delete
  using (is_admin() or created_by = auth.uid());

create policy "staff read bingo_games" on bingo_games for select using (is_staff());
create policy "staff read bingo_game_rounds" on bingo_game_rounds for select using (is_staff());
create policy "staff read bingo_game_cards" on bingo_game_cards for select using (is_staff());

-- ---------- SAVE PLAYLIST ----------
-- Saves a playlist and its songs in one transaction. p_songs is
-- [{title, artist, clip_start_seconds, clip_end_seconds}] in order;
-- each is matched to an existing library song by title+artist
-- (case-insensitive) or added to the library. Clip times are a
-- property of the song, so they're written back to the library row.
-- Runs as the caller, so RLS still applies.
create or replace function save_bingo_playlist(p_id uuid, p_title text, p_notes text, p_songs jsonb)
returns uuid as $$
declare
  v_id uuid := p_id;
  v_song jsonb;
  v_song_id uuid;
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
    update bingo_playlists set title = trim(p_title), notes = nullif(trim(p_notes), '') where id = v_id;
    if not found then raise exception 'Playlist not found'; end if;
    delete from bingo_playlist_songs where playlist_id = v_id;
  end if;

  for v_song in select * from jsonb_array_elements(coalesce(p_songs, '[]'::jsonb)) loop
    v_pos := v_pos + 1;
    select id into v_song_id from bingo_songs
      where lower(trim(title)) = lower(trim(v_song->>'title'))
        and lower(trim(artist)) = lower(trim(v_song->>'artist'));
    if v_song_id is null then
      insert into bingo_songs (title, artist, clip_start_seconds, clip_end_seconds, created_by)
      values (trim(v_song->>'title'), trim(v_song->>'artist'),
              (v_song->>'clip_start_seconds')::int, (v_song->>'clip_end_seconds')::int, auth.uid())
      returning id into v_song_id;
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

-- ---------- PRINT A GAME ----------
-- p_rounds = [{round_no, playlist_id, pattern_id}] for rounds 1-3
-- (round 1's pattern_id is ignored — it's always 5 in a row).
-- Checks every rule, snapshots everything, generates a unique shuffle
-- per card, and marks the playlists + songs as used today. Security
-- definer because staff have no direct write access to the game
-- tables or the usage counters.
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

grant execute on function save_bingo_playlist(uuid, text, text, jsonb) to authenticated;
grant execute on function create_bingo_game(date, int, jsonb, jsonb, jsonb) to authenticated;

-- ---------- STARTER PATTERNS ----------
-- Cells are 0..24 in reading order (row*5 + col); 12 is the free center.
-- No created_by, so only admins can delete them.
insert into bingo_patterns (name, cells) values
  ('Four Corners',  '{0,4,20,24}'),
  ('Big X',         '{0,4,6,8,16,18,20,24}'),
  ('Plus Sign',     '{2,7,10,11,13,14,17,22}'),
  ('Picture Frame', '{0,1,2,3,4,5,9,10,14,15,19,20,21,22,23,24}'),
  ('Blackout',      '{0,1,2,3,4,5,6,7,8,9,10,11,13,14,15,16,17,18,19,20,21,22,23,24}');
