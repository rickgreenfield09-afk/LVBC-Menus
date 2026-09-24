// api/spotify-sync-playlist.js
// Vercel serverless function (Node runtime, no dependencies).
// Any staff. Makes the brewery's Spotify account hold an exact copy of
// one bingo playlist: creates a private "LVBC Bingo · <title>" playlist
// the first time (or again if someone deleted it in Spotify), then
// renames it and replaces its tracks on every sync.
//
// Every song must already be linked to a Spotify track (migration_028)
// — nothing is guessed here. A playlist holding old, unlinked songs is
// refused until they're linked in the Song Bank. Success clears
// bingo_playlists.spotify_dirty, which printing a game requires.

import { spotifyEnvError, requireStaff, db, spotifyApi } from './_lib/spotify.js';

const NAME_PREFIX = 'LVBC Bingo · ';
const DESCRIPTION = 'Music Bingo playlist kept in sync by the LVBC staff app. Edit it in the app; changes made here get overwritten.';

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

    const unlinked = songs.filter((s) => !s.spotify_track_id);
    if (unlinked.length) {
      return res.status(409).json({
        error: unlinked.length + ' song' + (unlinked.length === 1 ? ' isn\'t' : 's aren\'t') + ' linked to Spotify yet — link them in the Song Bank first: '
          + unlinked.map((s) => s.title + ' – ' + s.artist).join('; '),
      });
    }
    const uris = songs.map((s) => 'spotify:track:' + s.spotify_track_id);

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
      body: { spotify_playlist_id: spotifyId, spotify_synced_at: new Date().toISOString(), spotify_dirty: false },
    });

    return res.status(200).json({ spotify_playlist_id: spotifyId, url: 'https://open.spotify.com/playlist/' + spotifyId, synced: uris.length });
  } catch (e) {
    return res.status(502).json({ error: e.message });
  }
}
