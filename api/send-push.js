// api/send-push.js
// Vercel serverless function. Admin-only (same caller-is-admin check as
// the other marketing endpoints).
//   GET  -> { configured, members, staff }   whether push is set up, and
//                                            how many devices could receive
//   POST { title, body, url?, audience }     send now; audience is
//                                            'members' | 'staff' | 'both'
// Members are only pushed when their comms_opt_in toggle is on. Devices
// the push service reports as gone are deleted. Each send is logged in
// push_notifications.
// Requires SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY,
// VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY.

import { requireAdmin, serviceHeaders } from './_lib/staff-auth.js';
import { pushConfigured, sendToSubscriptions } from './_lib/push.js';

async function loadSubscriptions(audiences) {
  const base = process.env.SUPABASE_URL + '/rest/v1/push_subscriptions';
  const r = await fetch(base + '?select=id,endpoint,p256dh,auth,audience,members(comms_opt_in)&audience=in.(' + audiences.join(',') + ')', { headers: serviceHeaders() });
  const rows = await r.json();
  if (!r.ok) throw new Error('Could not load subscriptions.');
  return rows.filter((s) => s.audience === 'staff' || (s.members && s.members.comms_opt_in));
}

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const caller = await requireAdmin(req, res);
  if (!caller) return;

  if (req.method === 'GET') {
    if (!pushConfigured()) return res.status(200).json({ configured: false, members: 0, staff: 0 });
    try {
      const subs = await loadSubscriptions(['member', 'staff']);
      return res.status(200).json({
        configured: true,
        members: subs.filter((s) => s.audience === 'member').length,
        staff: subs.filter((s) => s.audience === 'staff').length,
      });
    } catch (e) { return res.status(500).json({ error: e.message }); }
  }

  if (!pushConfigured()) return res.status(500).json({ error: 'Push is not configured yet (missing VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY in Vercel env vars).' });

  const { title, body, url, audience } = req.body || {};
  const t = (title || '').trim(), b = (body || '').trim();
  if (!t || !b) return res.status(400).json({ error: 'A title and message are required.' });
  if (t.length > 65 || b.length > 240) return res.status(400).json({ error: 'Title max 65 characters, message max 240.' });
  if (!['members', 'staff', 'both'].includes(audience)) return res.status(400).json({ error: 'Choose who to send to.' });
  // Same-site paths only: tapping a notification should never leave the app.
  const link = (url || '').trim();
  if (link && !/^\/(?![/\\])/.test(link)) return res.status(400).json({ error: 'Link must be a path on this site, like /member/.' });

  let subs;
  try {
    subs = await loadSubscriptions(audience === 'both' ? ['member', 'staff'] : [audience === 'members' ? 'member' : 'staff']);
  } catch (e) { return res.status(500).json({ error: e.message }); }
  if (!subs.length) return res.status(400).json({ error: 'No devices have turned on notifications for that audience yet.' });

  const result = await sendToSubscriptions(subs, { title: t, body: b, url: link || null });

  const sb = process.env.SUPABASE_URL + '/rest/v1/';
  if (result.gone.length) {
    await fetch(sb + 'push_subscriptions?id=in.(' + result.gone.join(',') + ')', { method: 'DELETE', headers: serviceHeaders() });
  }
  await fetch(sb + 'push_notifications', {
    method: 'POST',
    headers: { ...serviceHeaders(), Prefer: 'return=minimal' },
    body: JSON.stringify({ title: t, body: b, url: link || null, audience, sent_count: result.sent, failed_count: result.failed, sent_by: caller.id }),
  });
  return res.status(200).json({ ok: true, sent: result.sent, failed: result.failed });
}
