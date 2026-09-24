// api/spotify-callback.js
// Vercel serverless function (Node runtime, no dependencies).
// Spotify redirects here after the admin approves access. There's no
// Supabase session on this request — the one-time state token saved by
// api/spotify-connect.js is what proves an admin started it. Swaps the
// code for tokens, saves the connection, and sends the browser back to
// the app with ?spotify=connected (or ?spotify=error&reason=...).

import { spotifyEnvError, db, spotifyToken } from './_lib/spotify.js';

const STATE_MAX_AGE_MS = 15 * 60 * 1000;

function back(res, params) {
  res.writeHead(302, { Location: '/?' + new URLSearchParams(params).toString() });
  res.end();
}

export default async function handler(req, res) {
  const envErr = spotifyEnvError();
  if (envErr) return back(res, { spotify: 'error', reason: envErr });

  const { code, state, error } = req.query || {};
  if (error) return back(res, { spotify: 'error', reason: 'Spotify said: ' + error });
  if (!code || !state) return back(res, { spotify: 'error', reason: 'Missing code or state' });

  try {
    const rows = await db('spotify_oauth_states?select=*&state=eq.' + encodeURIComponent(state));
    if (!rows || !rows.length) return back(res, { spotify: 'error', reason: 'This login link expired — start again from the Bingo dashboard.' });
    await db('spotify_oauth_states?state=eq.' + encodeURIComponent(state), { method: 'DELETE' });
    if (Date.now() - new Date(rows[0].created_at).getTime() > STATE_MAX_AGE_MS) {
      return back(res, { spotify: 'error', reason: 'This login link expired — start again from the Bingo dashboard.' });
    }

    const tok = await spotifyToken({ grant_type: 'authorization_code', code, redirect_uri: process.env.SPOTIFY_REDIRECT_URI });
    const meRes = await fetch('https://api.spotify.com/v1/me', { headers: { Authorization: 'Bearer ' + tok.access_token } });
    const me = await meRes.json();
    if (!meRes.ok) {
      // Dev-mode apps return 403 for accounts not on the app's user list.
      return back(res, { spotify: 'error', reason: 'Spotify refused the account (' + meRes.status + '). Make sure it is added under User Management in the Spotify developer dashboard.' });
    }

    await db('spotify_connection', {
      method: 'POST',
      prefer: 'resolution=merge-duplicates',
      body: {
        id: 1,
        spotify_user_id: me.id,
        display_name: me.display_name || me.id,
        refresh_token: tok.refresh_token,
        access_token: tok.access_token,
        access_token_expires_at: new Date(Date.now() + tok.expires_in * 1000).toISOString(),
        scopes: tok.scope || null,
        connected_by: rows[0].created_by,
        connected_at: new Date().toISOString(),
      },
    });
    return back(res, { spotify: 'connected' });
  } catch (e) {
    return back(res, { spotify: 'error', reason: e.message });
  }
}
