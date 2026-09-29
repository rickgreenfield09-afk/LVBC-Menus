// api/_lib/staff-auth.js
// Shared by api/invite-staff.js and api/update-staff-email.js. Not a
// route itself — Vercel skips any api/ path with an "_"-prefixed
// segment.
//
// Requires SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY
// as Vercel project environment variables.

export function isValidEmail(email) {
  return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export function serviceHeaders() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return { apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' };
}

// Confirms the caller is a signed-in admin using their own token
// (RLS on staff_profiles lets any staff read the roster, so this
// only proves who they are — the role check is what gates writes).
// Returns { id, token } or null (after sending the error response).
export async function requireAdmin(req, res) {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) { res.status(401).json({ error: 'Missing auth token' }); return null; }

  const { SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY) {
    res.status(500).json({ error: 'Missing SUPABASE_URL/SUPABASE_ANON_KEY/SUPABASE_SERVICE_ROLE_KEY env vars.' });
    return null;
  }

  const callerRes = await fetch(SUPABASE_URL + '/auth/v1/user', {
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: 'Bearer ' + token },
  });
  const caller = await callerRes.json();
  if (!callerRes.ok || !caller || !caller.id) { res.status(401).json({ error: 'Could not verify session' }); return null; }

  const profRes = await fetch(SUPABASE_URL + '/rest/v1/staff_profiles?select=role&id=eq.' + caller.id, {
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: 'Bearer ' + token },
  });
  const prof = await profRes.json();
  if (!profRes.ok || !prof || !prof.length || prof[0].role !== 'admin') {
    res.status(403).json({ error: 'Only admins can manage staff.' });
    return null;
  }
  return { id: caller.id, token };
}

// The Auth admin API has no filter-by-email, so page through every
// user. Fine at brewery-roster scale.
export async function findAuthUserByEmail(email) {
  const target = email.toLowerCase();
  for (let page = 1; page < 50; page++) {
    const r = await fetch(process.env.SUPABASE_URL + '/auth/v1/admin/users?per_page=200&page=' + page, { headers: serviceHeaders() });
    const data = await r.json();
    const users = (data && data.users) || [];
    const hit = users.find((u) => (u.email || '').toLowerCase() === target);
    if (hit) return hit;
    if (users.length < 200) return null;
  }
  return null;
}

// Creates the auth account and emails an invite link. `data` lands in
// user_metadata — needs_password flags this session as "no real
// password set yet" so app-core.js can force the set-password screen
// instead of treating the invite link's session as a normal login
// (inviteUserByEmail sessions are authenticated immediately, before a
// password exists). Returns { user } or { error, status }.
export async function inviteAuthUser(email, name, redirectTo) {
  const r = await fetch(
    process.env.SUPABASE_URL + '/auth/v1/invite?redirect_to=' + encodeURIComponent(redirectTo || ''),
    { method: 'POST', headers: serviceHeaders(), body: JSON.stringify({ email, data: { name, needs_password: true } }) }
  );
  const data = await r.json();
  if (r.ok && data && data.id) return { user: data };
  return { error: data, status: r.status };
}
