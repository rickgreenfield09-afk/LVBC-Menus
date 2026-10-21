// api/push-subscribe.js
// Vercel serverless function. Called by push-client.js from the member
// and staff mobile apps.
//   GET    -> { publicKey }                 the VAPID key the browser needs
//   POST   { subscription, audience }       save this device (signed in as
//                                           a member or as staff)
//   DELETE { endpoint, audience }           forget this device
// The caller is identified from their own token; the row is written with
// the service role (nothing writes push_subscriptions from the browser).
// Requires SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY,
// VAPID_PUBLIC_KEY.

import { serviceHeaders } from './_lib/staff-auth.js';
import { requireMember } from './_lib/member-auth.js';

export default async function handler(req, res) {
  const { SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY, VAPID_PUBLIC_KEY } = process.env;

  if (req.method === 'GET') {
    if (!VAPID_PUBLIC_KEY) return res.status(503).json({ error: 'Push notifications are not set up yet.' });
    return res.status(200).json({ publicKey: VAPID_PUBLIC_KEY });
  }
  if (req.method !== 'POST' && req.method !== 'DELETE') return res.status(405).json({ error: 'Method not allowed' });
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ error: 'Missing SUPABASE_URL/SUPABASE_ANON_KEY/SUPABASE_SERVICE_ROLE_KEY env vars.' });
  }

  const base = SUPABASE_URL + '/rest/v1/push_subscriptions';
  const { subscription, endpoint, audience } = req.body || {};
  const owner = await identify(req, res, audience);
  if (!owner) return;

  if (req.method === 'DELETE') {
    if (!endpoint) return res.status(400).json({ error: 'Missing endpoint' });
    const col = owner.audience === 'member' ? 'member_id' : 'staff_id';
    await fetch(base + '?endpoint=eq.' + encodeURIComponent(endpoint) + '&' + col + '=eq.' + owner.id, { method: 'DELETE', headers: serviceHeaders() });
    return res.status(200).json({ ok: true });
  }

  const keys = subscription && subscription.keys;
  if (!subscription || !subscription.endpoint || !keys || !keys.p256dh || !keys.auth) {
    return res.status(400).json({ error: 'Invalid subscription' });
  }
  const row = {
    endpoint: subscription.endpoint, p256dh: keys.p256dh, auth: keys.auth,
    audience: owner.audience,
    member_id: owner.audience === 'member' ? owner.id : null,
    staff_id: owner.audience === 'staff' ? owner.id : null,
    user_agent: (req.headers['user-agent'] || '').slice(0, 300),
  };
  // Upsert on endpoint: a browser re-subscribing (or a different person
  // signing in on the same device) just takes over the row.
  const r = await fetch(base + '?on_conflict=endpoint', {
    method: 'POST',
    headers: { ...serviceHeaders(), Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(row),
  });
  if (!r.ok) return res.status(500).json({ error: 'Could not save subscription.' });
  return res.status(200).json({ ok: true });
}

// Resolves who is calling: { audience, id } or null (response already sent).
async function identify(req, res, audience) {
  if (audience === 'member') {
    const member = await requireMember(req, res);
    return member ? { audience: 'member', id: member.id } : null;
  }
  if (audience === 'staff') {
    const { SUPABASE_URL, SUPABASE_ANON_KEY } = process.env;
    const token = (req.headers.authorization || '').replace('Bearer ', '');
    if (!token) { res.status(401).json({ error: 'Sign in first.' }); return null; }
    const h = { apikey: SUPABASE_ANON_KEY, Authorization: 'Bearer ' + token };
    const userRes = await fetch(SUPABASE_URL + '/auth/v1/user', { headers: h });
    const user = await userRes.json();
    if (!userRes.ok || !user || !user.id) { res.status(401).json({ error: 'Could not verify session' }); return null; }
    const profRes = await fetch(SUPABASE_URL + '/rest/v1/staff_profiles?select=id&id=eq.' + user.id, { headers: h });
    const prof = await profRes.json();
    if (!profRes.ok || !prof || !prof.length) { res.status(403).json({ error: 'Not a staff account.' }); return null; }
    return { audience: 'staff', id: user.id };
  }
  res.status(400).json({ error: 'Missing audience' });
  return null;
}
