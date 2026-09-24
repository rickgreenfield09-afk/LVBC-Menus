// api/_lib/spotify.js
// Shared by the api/spotify-* routes. Not a route itself — Vercel
// skips any api/ path with an "_"-prefixed segment.
//
// The brewery's single Spotify account is stored in spotify_connection
// (migration_027), readable only with the service role key. Access
// tokens last an hour; getAccessToken() refreshes and saves a new one
// whenever the stored one is within a minute of expiring.
//
// Requires SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY,
// SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET, SPOTIFY_REDIRECT_URI as
// Vercel project environment variables.

export const SPOTIFY_SCOPES = 'playlist-read-private playlist-modify-private playlist-modify-public';

export function spotifyEnvError() {
  const { SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY, SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET, SPOTIFY_REDIRECT_URI } = process.env;
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY) return 'Missing SUPABASE_URL/SUPABASE_ANON_KEY/SUPABASE_SERVICE_ROLE_KEY env vars.';
  if (!SPOTIFY_CLIENT_ID || !SPOTIFY_CLIENT_SECRET || !SPOTIFY_REDIRECT_URI) {
    return 'Spotify is not configured yet (missing SPOTIFY_CLIENT_ID/SPOTIFY_CLIENT_SECRET/SPOTIFY_REDIRECT_URI in Vercel env vars).';
  }
  return null;
}

// Verifies the caller's Supabase session and staff role. Returns
// { id, role } or null (after sending the error response).
export async function requireStaff(req, res, { admin } = {}) {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) { res.status(401).json({ error: 'Missing auth token' }); return null; }
  const { SUPABASE_URL, SUPABASE_ANON_KEY } = process.env;

  const userRes = await fetch(SUPABASE_URL + '/auth/v1/user', { headers: { apikey: SUPABASE_ANON_KEY, Authorization: 'Bearer ' + token } });
  const user = await userRes.json();
  if (!userRes.ok || !user || !user.id) { res.status(401).json({ error: 'Could not verify session' }); return null; }

  const profRes = await fetch(SUPABASE_URL + '/rest/v1/staff_profiles?select=role&id=eq.' + user.id, {
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: 'Bearer ' + token },
  });
  const prof = await profRes.json();
  if (!profRes.ok || !prof || !prof.length) { res.status(403).json({ error: 'No staff profile for this account.' }); return null; }
  if (admin && prof[0].role !== 'admin') { res.status(403).json({ error: 'Only admins can do this.' }); return null; }
  return { id: user.id, role: prof[0].role };
}

// Supabase REST call with the service role key (bypasses RLS).
export async function db(path, { method = 'GET', body, prefer } = {}) {
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
  const headers = { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: 'Bearer ' + SUPABASE_SERVICE_ROLE_KEY, 'Content-Type': 'application/json' };
  if (prefer) headers.Prefer = prefer;
  const r = await fetch(SUPABASE_URL + '/rest/v1/' + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  const data = text ? JSON.parse(text) : null;
  if (!r.ok) throw new Error('Database error: ' + (data && data.message ? data.message : r.status));
  return data;
}

function basicAuth() {
  return 'Basic ' + Buffer.from(process.env.SPOTIFY_CLIENT_ID + ':' + process.env.SPOTIFY_CLIENT_SECRET).toString('base64');
}

// POST to Spotify's token endpoint (code exchange or refresh).
export async function spotifyToken(params) {
  const r = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { Authorization: basicAuth(), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  });
  const data = await r.json();
  if (!r.ok) throw new Error('Spotify token error: ' + (data.error_description || data.error || r.status));
  return data;
}

async function loadConnection() {
  const rows = await db('spotify_connection?select=*&id=eq.1');
  if (!rows || !rows.length) throw new Error('Spotify is not connected yet — an admin needs to connect it from the Bingo dashboard.');
  return rows[0];
}

// Memoized per warm function instance so parallel calls share one
// lookup/refresh — Spotify can rotate the refresh token, and two
// racing refreshes could leave the stored one stale.
let tokenCache = null; // { promise, expiresAt }

async function loadOrRefreshToken(forceRefresh) {
  const conn = await loadConnection();
  const expiresAt = conn.access_token_expires_at ? new Date(conn.access_token_expires_at).getTime() : 0;
  if (!forceRefresh && conn.access_token && expiresAt - Date.now() > 60000) return { token: conn.access_token, expiresAt };

  const tok = await spotifyToken({ grant_type: 'refresh_token', refresh_token: conn.refresh_token });
  const newExpiresAt = Date.now() + tok.expires_in * 1000;
  const patch = { access_token: tok.access_token, access_token_expires_at: new Date(newExpiresAt).toISOString() };
  // Spotify sometimes rotates the refresh token; keep the newest.
  if (tok.refresh_token) patch.refresh_token = tok.refresh_token;
  await db('spotify_connection?id=eq.1', { method: 'PATCH', body: patch });
  return { token: tok.access_token, expiresAt: newExpiresAt };
}

export async function getAccessToken(forceRefresh) {
  if (forceRefresh || !tokenCache || tokenCache.expiresAt - Date.now() < 60000) {
    const promise = loadOrRefreshToken(forceRefresh);
    tokenCache = { promise, expiresAt: Infinity };
    try {
      const { token, expiresAt } = await promise;
      tokenCache = { promise, expiresAt };
      return token;
    } catch (e) {
      tokenCache = null;
      throw e;
    }
  }
  return (await tokenCache.promise).token;
}

// Calls the Web API as the connected account. Retries once with a
// forced token refresh on 401. Returns { status, data }; throws on
// anything but 2xx unless allowStatus includes it.
export async function spotifyApi(method, path, body, { allowStatus = [] } = {}) {
  let token = await getAccessToken(false);
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await fetch('https://api.spotify.com/v1' + path, {
      method,
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (r.status === 401 && attempt === 0) { token = await getAccessToken(true); continue; }
    const text = await r.text();
    const data = text ? JSON.parse(text) : null;
    if (r.ok || allowStatus.includes(r.status)) return { status: r.status, data };
    const msg = data && data.error ? (data.error.message || data.error) : r.status;
    throw new Error('Spotify error (' + r.status + '): ' + msg);
  }
}

export function trackSummary(t) {
  return {
    id: t.id,
    title: t.name,
    artist: (t.artists || []).map((a) => a.name).join(', '),
    album: t.album ? t.album.name : '',
    image: t.album && t.album.images && t.album.images.length ? t.album.images[t.album.images.length - 1].url : null,
    duration_ms: t.duration_ms,
  };
}
