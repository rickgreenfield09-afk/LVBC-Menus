// api/update-staff-email.js
// Vercel serverless function (Node runtime, no dependencies).
// Admin-only: sets or changes a staff member's email from the Admin
// edit form.
//   - Profile already backed by a login: changes the login's email
//     (pre-confirmed, no verification email) and the profile's copy.
//   - Placeholder profile with no login (migration_008 rows): finds
//     or invites a login for that email, then calls
//     link_staff_login() (migration_030) to re-key the profile onto
//     it, carrying over all shift/blackout/etc. history.
// If the email belongs to a login that already has a different
// profile, responds 409 { needsMerge } until the client resends with
// merge: true — so a typo can't silently fold two people together.
// The service key is only used for the Auth admin API; profile
// writes go out with the admin's own token so RLS and the
// protect_staff_profile_fields trigger see a real admin.

import { isValidEmail, serviceHeaders, requireAdmin, findAuthUserByEmail, inviteAuthUser } from './_lib/staff-auth.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const caller = await requireAdmin(req, res);
  if (!caller) return;

  const { SUPABASE_URL, SUPABASE_ANON_KEY } = process.env;
  const userHeaders = { apikey: SUPABASE_ANON_KEY, Authorization: 'Bearer ' + caller.token, 'Content-Type': 'application/json' };

  const body = req.body || {};
  const staffId = String(body.staffId || '');
  const email = String(body.email || '').trim().toLowerCase();
  if (!/^[0-9a-f-]{36}$/i.test(staffId)) return res.status(400).json({ error: 'Missing staff id.' });
  if (!isValidEmail(email)) return res.status(400).json({ error: 'Please enter a valid email address.' });

  const profRes = await fetch(SUPABASE_URL + '/rest/v1/staff_profiles?select=id,name&id=eq.' + staffId, { headers: userHeaders });
  const prof = await profRes.json();
  if (!profRes.ok || !prof || !prof.length) return res.status(404).json({ error: 'Staff member not found.' });
  const name = prof[0].name;

  const ownLoginRes = await fetch(SUPABASE_URL + '/auth/v1/admin/users/' + staffId, { headers: serviceHeaders() });
  const existing = await findAuthUserByEmail(email);

  if (ownLoginRes.ok) {
    // Already a real login — just change its email.
    if (existing && existing.id !== staffId) {
      return res.status(409).json({ error: 'That email is already used by another login.' });
    }
    if (!existing) {
      const upd = await fetch(SUPABASE_URL + '/auth/v1/admin/users/' + staffId, {
        method: 'PUT', headers: serviceHeaders(), body: JSON.stringify({ email, email_confirm: true }),
      });
      if (!upd.ok) return res.status(500).json({ error: 'Could not change the login email.', detail: await upd.json() });
    }
    const patch = await fetch(SUPABASE_URL + '/rest/v1/staff_profiles?id=eq.' + staffId, {
      method: 'PATCH', headers: { ...userHeaders, Prefer: 'return=representation' }, body: JSON.stringify({ email }),
    });
    const rows = await patch.json();
    if (!patch.ok || !rows || !rows.length) return res.status(500).json({ error: 'Changed the login email but could not update the profile.', detail: rows });
    return res.status(200).json({ ok: true, staff: rows[0], action: 'email_changed' });
  }

  // Placeholder profile — find or invite a login, then relink.
  let loginId, invited = false;
  if (existing) {
    loginId = existing.id;
    const otherRes = await fetch(SUPABASE_URL + '/rest/v1/staff_profiles?select=name&id=eq.' + loginId, { headers: userHeaders });
    const other = await otherRes.json();
    if (other && other.length && !body.merge) {
      return res.status(409).json({ needsMerge: true, otherName: other[0].name, error: 'That email already belongs to ' + other[0].name + "'s profile." });
    }
  } else {
    const inv = await inviteAuthUser(email, name, body.redirectTo);
    if (!inv.user) return res.status(500).json({ error: 'Could not create the invite.', detail: inv.error });
    loginId = inv.user.id;
    invited = true;
  }

  const linkRes = await fetch(SUPABASE_URL + '/rest/v1/rpc/link_staff_login', {
    method: 'POST', headers: userHeaders, body: JSON.stringify({ p_old_id: staffId, p_new_id: loginId, p_email: email }),
  });
  const linked = await linkRes.json();
  if (!linkRes.ok) {
    return res.status(500).json({ error: 'Could not link the profile to the login: ' + ((linked && linked.message) || 'unknown error'), detail: linked });
  }
  return res.status(200).json({ ok: true, staff: linked, action: invited ? 'invited' : 'linked' });
}
