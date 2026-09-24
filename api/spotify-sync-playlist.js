// api/spotify-sync-playlist.js
// Vercel serverless function (Node runtime, no dependencies).
// Any staff. Makes the brewery's Spotify account hold an exact copy of
// one bingo playlist: creates a private "LVBC Bingo · <title>" playlist
// the first time (or again if someone deleted it in Spotify), then
// renames it and replaces its tracks on every sync.
//
// Songs with no spotify_track_id yet (typed in by hand or imported) are
// looked up by title + artist and the best hit is saved to the song,
// so it's only searched once. Every auto-match is returned so staff can
// double-check it; songs with no hit are left off the Spotify playlist
// and reported back.

import { spotifyEnvError, requireStaff, db, spotifyApi, trackSummary } from './_lib/spotify.js';

const NAME_PREFIX = 'LVBC Bingo · ';
const DESCRIPTION = 'Music Bingo playlist kept in sync by the LVBC staff app. Edit it in the app; changes made here get overwritten.';

// Spotify search syntax chokes on quotes; field filters narrow it down.
function clean(s) { return String(s || '').replace(/["']/g, ' ').replace(/\s+/g, ' ').trim(); }

async function findTrack(title, artist) {
  const tries = ['track:' + clean(title) + ' artist:' + clean(artist.split(/ ft\.| feat\.|,|&/i)[0]), clean(title) + ' ' + clean(artist)];
  for (const q of tries) {
    const { data } = await spotifyApi('GET', '/search?' + new URLSearchParams({ q, type: 'track', limit: '1' }).toString());
    const hit = data && data.tracks && data.tracks.items && data.tracks.items[0];
    if (hit) return trackSummary(hit);
  }
  return null;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const envErr = spotifyEnvError();
  if (envErr) return res.status(500).json({ error: envErr });
  if (!(await requireStaff(req, res))) return;

  const playlistId = String((req.body || {}).playlist_id || '');
  if (!/^[0-9a-f-]{36}$/i.test(playlistId)) return res.status(400).json({ error: 'Missing playlist_id' });

  try {
    const rows = await db('bingo_playlists?select=id,title,spotify_playlist_id,bingo_playlist_songs(position,bingo_songs(id,title,artist,spotify_track_id))&id=eq.' + playlistId);
    if (!rows || !rows.length) return res.status(404).json({ error: 'Playlist not found' });
    const pl = rows[0];
    const songs = (pl.bingo_playlist_songs || []).sort((a, b) => a.position - b.position).map((r) => r.bingo_songs);

    // Resolve missing track ids, a few at a time.
    const autoMatched = [], unmatched = [];
    const missing = songs.filter((s) => !s.spotify_track_id);
    for (let i = 0; i < missing.length; i += 6) {
      await Promise.all(missing.slice(i, i + 6).map(async (s) => {
        const hit = await findTrack(s.title, s.artist);
        if (!hit) { unmatched.push({ title: s.title, artist: s.artist }); return; }
        s.spotify_track_id = hit.id;
        autoMatched.push({ title: s.title, artist: s.artist, spotify_title: hit.title, spotify_artist: hit.artist });
        // Another library row may already own this track id (unique) —
        // the playlist still gets the track, the id just isn't saved twice.
        try { await db('bingo_songs?id=eq.' + s.id, { method: 'PATCH', body: { spotify_track_id: hit.id } }); } catch (e) { /* keep going */ }
      }));
    }
    const uris = songs.filter((s) => s.spotify_track_id).map((s) => 'spotify:track:' + s.spotify_track_id);

    // Reuse the Spotify playlist if it still exists, else create one.
    let spotifyId = pl.spotify_playlist_id;
    if (spotifyId) {
      const { status } = await spotifyApi('PUT', '/playlists/' + spotifyId, { name: NAME_PREFIX + pl.title, description: DESCRIPTION }, { allowStatus: [403, 404] });
      if (status === 403 || status === 404) spotifyId = null;
    }
    if (!spotifyId) {
      const { data } = await spotifyApi('POST', '/me/playlists', { name: NAME_PREFIX + pl.title, description: DESCRIPTION, public: false });
      spotifyId = data.id;
    }
    await spotifyApi('PUT', '/playlists/' + spotifyId + '/items', { uris });

    await db('bingo_playlists?id=eq.' + playlistId, {
      method: 'PATCH',
      body: { spotify_playlist_id: spotifyId, spotify_synced_at: new Date().toISOString() },
    });

    return res.status(200).json({
      spotify_playlist_id: spotifyId,
      url: 'https://open.spotify.com/playlist/' + spotifyId,
      synced: uris.length,
      auto_matched: autoMatched,
      unmatched,
    });
  } catch (e) {
    return res.status(502).json({ error: e.message });
  }
}
