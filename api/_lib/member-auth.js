// api/_lib/member-auth.js
// Shared by api/membership-checkout.js and api/membership-portal.js.
// Not a route itself — Vercel skips any api/ path with an "_"-prefixed
// segment.
//
// Requires SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY
// as Vercel project environment variables.

import { serviceHeaders } from './staff-auth.js';

// Confirms the caller is a signed-in member using their own token and
// returns their members row (read with the service role, so the
// stripe_customer_id column is included). Sends the error response and
// returns null when it can't.
export async function requireMember(req, res) {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) { res.status(401).json({ error: 'Sign in first.' }); return null; }

  const { SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY) {
    res.status(500).json({ error: 'Missing SUPABASE_URL/SUPABASE_ANON_KEY/SUPABASE_SERVICE_ROLE_KEY env vars.' });
    return null;
  }

  const userRes = await fetch(SUPABASE_URL + '/auth/v1/user', {
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: 'Bearer ' + token },
  });
  const user = await userRes.json();
  if (!userRes.ok || !user || !user.id) { res.status(401).json({ error: 'Could not verify session.' }); return null; }

  const memRes = await fetch(
    SUPABASE_URL + '/rest/v1/members?select=id,name,email,stripe_customer_id&auth_user_id=eq.' + user.id,
    { headers: serviceHeaders() }
  );
  const rows = await memRes.json();
  if (!memRes.ok || !rows || !rows.length) { res.status(404).json({ error: 'No member account found.' }); return null; }
  return rows[0];
}
