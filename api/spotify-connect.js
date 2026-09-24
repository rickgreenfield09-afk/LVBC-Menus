// api/spotify-connect.js
// Vercel serverless function (Node runtime, no dependencies).
// Admin-only. Starts the one-time Spotify login: saves a random state
// token and returns Spotify's authorize URL for the browser to open.
// Spotify sends the admin back to api/spotify-callback.js.

import crypto from 'crypto';
import { spotifyEnvError, requireStaff, db, SPOTIFY_SCOPES } from './_lib/spotify.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const envErr = spotifyEnvError();
  if (envErr) return res.status(500).json({ error: envErr });

  const caller = await requireStaff(req, res, { admin: true });
  if (!caller) return;

  try {
    const state = crypto.randomBytes(24).toString('hex');
    // clear abandoned attempts older than an hour while we're here
    await db('spotify_oauth_states?created_at=lt.' + encodeURIComponent(new Date(Date.now() - 3600000).toISOString()), { method: 'DELETE' });
    await db('spotify_oauth_states', { method: 'POST', body: { state, created_by: caller.id } });

    const url = 'https://accounts.spotify.com/authorize?' + new URLSearchParams({
      response_type: 'code',
      client_id: process.env.SPOTIFY_CLIENT_ID,
      scope: SPOTIFY_SCOPES,
      redirect_uri: process.env.SPOTIFY_REDIRECT_URI,
      state,
      show_dialog: 'true',
    }).toString();
    return res.status(200).json({ url });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
