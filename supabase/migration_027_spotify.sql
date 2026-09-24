-- ============================================================
-- Migration 027 — Spotify connection for Music Bingo
-- ============================================================
-- The brewery's one Spotify (Premium) account is connected once by an
-- admin; every bingo playlist then gets a matching private Spotify
-- playlist that the app keeps in sync, so nobody rebuilds playlists
-- by hand. Songs are added by searching Spotify, which stores the
-- exact track (bingo_songs.spotify_track_id).
--
-- Tokens live in spotify_connection, which has RLS on and NO policies:
-- only the api/ functions (service role key) can read or write it.
-- The browser only ever sees spotify_connection_status().

create table spotify_connection (
  id int primary key default 1 check (id = 1),  -- singleton
  spotify_user_id text not null,
  display_name text,
  refresh_token text not null,
  access_token text,
  access_token_expires_at timestamptz,
  scopes text,
  connected_by uuid references staff_profiles(id) on delete set null,
  connected_at timestamptz not null default now()
);

-- One-time CSRF tokens for the OAuth round trip (api/spotify-connect
-- writes one, api/spotify-callback consumes it).
create table spotify_oauth_states (
  state text primary key,
  created_by uuid references staff_profiles(id) on delete cascade,
  created_at timestamptz not null default now()
);

alter table spotify_connection enable row level security;
alter table spotify_oauth_states enable row level security;

create or replace function spotify_connection_status()
returns table (connected boolean, display_name text, spotify_user_id text, connected_at timestamptz, connected_by_name text) as $$
begin
  if not is_staff() then raise exception 'Not authorized'; end if;
  return query
    select true, c.display_name, c.spotify_user_id, c.connected_at, s.name
    from spotify_connection c left join staff_profiles s on s.id = c.connected_by;
  if not found then
    return query select false, null::text, null::text, null::timestamptz, null::text;
  end if;
end;
$$ language plpgsql security definer set search_path = public;

create or replace function disconnect_spotify()
returns void as $$
begin
  if not is_admin() then raise exception 'Only admins can disconnect Spotify'; end if;
  delete from spotify_connection;
end;
$$ language plpgsql security definer set search_path = public;

grant execute on function spotify_connection_status() to authenticated;
grant execute on function disconnect_spotify() to authenticated;

-- ---------- save_bingo_playlist: carry Spotify track ids ----------
-- Same as migration_025, plus each song may carry spotify_track_id.
-- A song is matched by track id first (so a Spotify pick always lands
-- on the same library row), then by title+artist; a matched row that
-- has no track id yet picks up the one provided.
create or replace function save_bingo_playlist(p_id uuid, p_title text, p_notes text, p_songs jsonb)
returns uuid as $$
declare
  v_id uuid := p_id;
  v_song jsonb;
  v_song_id uuid;
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
    update bingo_playlists set title = trim(p_title), notes = nullif(trim(p_notes), '') where id = v_id;
    if not found then raise exception 'Playlist not found'; end if;
    delete from bingo_playlist_songs where playlist_id = v_id;
  end if;

  for v_song in select * from jsonb_array_elements(coalesce(p_songs, '[]'::jsonb)) loop
    v_pos := v_pos + 1;
    v_track := nullif(trim(v_song->>'spotify_track_id'), '');
    v_song_id := null;

    if v_track is not null then
      select id into v_song_id from bingo_songs where spotify_track_id = v_track;
    end if;
    if v_song_id is null then
      select id into v_song_id from bingo_songs
        where lower(trim(title)) = lower(trim(v_song->>'title'))
          and lower(trim(artist)) = lower(trim(v_song->>'artist'));
    end if;

    if v_song_id is null then
      insert into bingo_songs (title, artist, clip_start_seconds, clip_end_seconds, spotify_track_id, created_by)
      values (trim(v_song->>'title'), trim(v_song->>'artist'),
              (v_song->>'clip_start_seconds')::int, (v_song->>'clip_end_seconds')::int, v_track, auth.uid())
      returning id into v_song_id;
    else
      update bingo_songs set
        clip_start_seconds = (v_song->>'clip_start_seconds')::int,
        clip_end_seconds = (v_song->>'clip_end_seconds')::int,
        spotify_track_id = coalesce(spotify_track_id, v_track)
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
