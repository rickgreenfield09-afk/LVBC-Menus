// api/notify-count-sheet.js
// Vercel serverless function. Any signed-in staff member.
//   POST { sheet_id }   push "you have an inventory count" to the
//                       employee the sheet is assigned to
//
// Called by the Run Inventory screen right after a sheet is created,
// reassigned, or resent. Only the assignee's own devices are pushed
// (audience 'staff', matched on staff_id). The roster can hold a second
// profile with the same email as the login one, so every profile
// sharing the assignee's email is included. Devices the push service
// reports as gone are deleted.
// Requires SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY,
// VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY.

import { requireStaff, serviceHeaders } from './_lib/staff-auth.js';
import { pushConfigured, sendToSubscriptions } from './_lib/push.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const caller = await requireStaff(req, res);
  if (!caller) return;

  const sheetId = ((req.body || {}).sheet_id || '').trim();
  if (!/^[0-9a-f-]{36}$/i.test(sheetId)) return res.status(400).json({ error: 'A sheet id is required.' });

  const { SUPABASE_URL, SUPABASE_ANON_KEY } = process.env;
  const asCaller = { apikey: SUPABASE_ANON_KEY, Authorization: 'Bearer ' + caller.token };

  const sheetRes = await fetch(SUPABASE_URL + '/rest/v1/inventory_count_sheets?select=id,title,assigned_to,status&id=eq.' + sheetId, { headers: asCaller });
  const sheets = await sheetRes.json();
  const sheet = sheetRes.ok && sheets && sheets[0];
  if (!sheet) return res.status(404).json({ error: 'Count sheet not found.' });
  if (sheet.status !== 'assigned') return res.status(400).json({ error: 'That sheet is not waiting to be counted.' });
  if (!sheet.assigned_to) return res.status(400).json({ error: 'That sheet is not assigned to anyone.' });

  if (!pushConfigured()) return res.status(200).json({ ok: true, sent: 0, reason: 'not_configured' });

  const linesRes = await fetch(SUPABASE_URL + '/rest/v1/inventory_count_sheet_lines?select=id&sheet_id=eq.' + sheetId, { headers: asCaller });
  const lines = await linesRes.json();
  const count = linesRes.ok && Array.isArray(lines) ? lines.length : 0;

  const svc = serviceHeaders();
  const profRes = await fetch(SUPABASE_URL + '/rest/v1/staff_profiles?select=id,email&id=eq.' + sheet.assigned_to, { headers: svc });
  const prof = ((await profRes.json()) || [])[0];
  const staffIds = new Set([sheet.assigned_to]);
  if (prof && prof.email) {
    const sameRes = await fetch(SUPABASE_URL + '/rest/v1/staff_profiles?select=id&email=eq.' + encodeURIComponent(prof.email), { headers: svc });
    const same = await sameRes.json();
    if (sameRes.ok && Array.isArray(same)) same.forEach((r) => staffIds.add(r.id));
  }

  const subsRes = await fetch(SUPABASE_URL + '/rest/v1/push_subscriptions?select=id,endpoint,p256dh,auth&audience=eq.staff&staff_id=in.(' + [...staffIds].join(',') + ')', { headers: svc });
  const subs = await subsRes.json();
  if (!subsRes.ok || !Array.isArray(subs)) return res.status(500).json({ error: 'Could not load devices.' });
  if (!subs.length) return res.status(200).json({ ok: true, sent: 0, reason: 'no_devices' });

  const body = (sheet.title + (count ? ' — ' + count + ' to count' : '') + '. Open the app to start.').slice(0, 200);
  const result = await sendToSubscriptions(subs, { title: 'Inventory count for you', body, url: '/mobile/#count' });
  if (result.gone.length) {
    await fetch(SUPABASE_URL + '/rest/v1/push_subscriptions?id=in.(' + result.gone.join(',') + ')', { method: 'DELETE', headers: svc });
  }
  return res.status(200).json({ ok: true, sent: result.sent, failed: result.failed });
}
