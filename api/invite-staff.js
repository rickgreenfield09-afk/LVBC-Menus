// api/invite-staff.js
// Vercel serverless function (Node runtime, no dependencies).
// Admin-only: creates a real Supabase Auth account for a new staff
// member and emails them an invite link, then creates their
// staff_profiles row with the chosen role/access.
// Auth: the client forwards their own Supabase access token. This
// function first uses that token (not the service key) to confirm the
// caller is an admin, per the same staff_profiles.role check the RLS
// policies use — only after that does it switch to the service role
// key to call the Auth admin API and write staff_profiles directly.
// Requires SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY
// as Vercel project environment variables.

import { isValidEmail, serviceHeaders, requireAdmin, findAuthUserByEmail, inviteAuthUser } from './_lib/staff-auth.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const caller = await requireAdmin(req, res);
  if (!caller) return;
  const { SUPABASE_URL } = process.env;

  const body = req.body || {};
  const name = String(body.name || '').trim();
  const email = String(body.email || '').trim().toLowerCase();
  const role = body.role === 'admin' ? 'admin' : 'user';
  const position = ['bartender', 'cellarman', 'manager'].includes(body.position) ? body.position : 'bartender';
  const canSchedule = !!body.canSchedule;

  if (!name) return res.status(400).json({ error: 'Name is required.' });
  if (!isValidEmail(email)) return res.status(400).json({ error: 'Please enter a valid email address.' });

  let userId;
  const inv = await inviteAuthUser(email, name, body.redirectTo);
  if (inv.user) {
    userId = inv.user.id;
  } else if (inv.status === 422 || (inv.error && /already registered/i.test(inv.error.msg || inv.error.error_description || ''))) {
    // Already has an auth account (e.g. re-adding someone who left and
    // came back) — look them up instead of creating a duplicate.
    const existing = await findAuthUserByEmail(email);
    if (!existing) return res.status(409).json({ error: 'That email is already registered, but the existing account could not be found.' });
    userId = existing.id;
  } else {
    return res.status(500).json({ error: 'Could not create the invite', detail: inv.error });
  }

  // Upsert so re-adding someone who already has a staff_profiles row
  // (e.g. retry after a partial failure) just updates it in place.
  const profileRes = await fetch(SUPABASE_URL + '/rest/v1/staff_profiles?on_conflict=id', {
    method: 'POST',
    headers: { ...serviceHeaders(), Prefer: 'resolution=merge-duplicates,return=representation' },
    body: JSON.stringify([{ id: userId, name, email, role, position, can_schedule: canSchedule }]),
  });
  const profileRows = await profileRes.json();
  if (!profileRes.ok || !profileRows || !profileRows.length) {
    return res.status(500).json({ error: 'Invited the account but could not save the staff profile', detail: profileRows });
  }

  return res.status(200).json({ ok: true, staff: profileRows[0] });
}
