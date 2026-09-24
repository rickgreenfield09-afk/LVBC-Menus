// api/spotify-search.js
// Vercel serverless function (Node runtime, no dependencies).
// Any staff. Track search for the playlist editor, run as the
// connected brewery account. Spotify caps search at 10 results.

import { spotifyEnvError, requireStaff, spotifyApi, trackSummary } from './_lib/spotify.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const envErr = spotifyEnvError();
  if (envErr) return res.status(500).json({ error: envErr });
  if (!(await requireStaff(req, res))) return;

  const q = String((req.body || {}).q || '').trim();
  if (!q) return res.status(200).json({ tracks: [] });

  try {
    const { data } = await spotifyApi('GET', '/search?' + new URLSearchParams({ q, type: 'track', limit: '10' }).toString());
    const tracks = (data && data.tracks && data.tracks.items || []).filter(Boolean).map(trackSummary);
    return res.status(200).json({ tracks });
  } catch (e) {
    return res.status(502).json({ error: e.message });
  }
}
