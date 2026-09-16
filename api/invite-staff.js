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

function isValidEmail(email) {
  return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Missing auth token' });

  const { SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ error: 'Missing SUPABASE_URL/SUPABASE_ANON_KEY/SUPABASE_SERVICE_ROLE_KEY env vars.' });
  }

  const body = req.body || {};
  const name = String(body.name || '').trim();
  const email = String(body.email || '').trim().toLowerCase();
  const role = body.role === 'admin' ? 'admin' : 'user';
  const position = ['bartender', 'cellarman', 'manager'].includes(body.position) ? body.position : 'bartender';
  const canSchedule = !!body.canSchedule;

  if (!name) return res.status(400).json({ error: 'Name is required.' });
  if (!isValidEmail(email)) return res.status(400).json({ error: 'Please enter a valid email address.' });

  // Confirm the caller is a signed-in admin, scoped by their own token
  // (RLS on staff_profiles lets any staff read the roster, so this
  // only proves who they are — not that they're allowed to write).
  const callerRes = await fetch(SUPABASE_URL + '/auth/v1/user', {
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: 'Bearer ' + token },
  });
  const caller = await callerRes.json();
  if (!callerRes.ok || !caller || !caller.id) return res.status(401).json({ error: 'Could not verify session' });

  const callerProfileRes = await fetch(
    SUPABASE_URL + '/rest/v1/staff_profiles?select=role&id=eq.' + caller.id,
    { headers: { apikey: SUPABASE_ANON_KEY, Authorization: 'Bearer ' + token } }
  );
  const callerProfile = await callerProfileRes.json();
  if (!callerProfileRes.ok || !callerProfile || !callerProfile.length || callerProfile[0].role !== 'admin') {
    return res.status(403).json({ error: 'Only admins can add staff.' });
  }

  const adminHeaders = {
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: 'Bearer ' + SUPABASE_SERVICE_ROLE_KEY,
    'Content-Type': 'application/json',
  };

  // Create the auth account and email an invite link. `data` lands in
  // user_metadata — needs_password flags this session as "no real
  // password set yet" so app-core.js can force the set-password screen
  // instead of treating the invite link's session as a normal login
  // (inviteUserByEmail sessions are authenticated immediately, before
  // a password exists).
  let userId;
  const inviteRes = await fetch(
    SUPABASE_URL + '/auth/v1/invite?redirect_to=' + encodeURIComponent(body.redirectTo || ''),
    {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ email, data: { name, needs_password: true } }),
    }
  );
  const inviteData = await inviteRes.json();

  if (inviteRes.ok && inviteData && inviteData.id) {
    userId = inviteData.id;
  } else if (inviteRes.status === 422 || (inviteData && /already registered/i.test(inviteData.msg || inviteData.error_description || ''))) {
    // Already has an auth account (e.g. re-adding someone who left and
    // came back) — look them up instead of creating a duplicate.
    const lookupRes = await fetch(SUPABASE_URL + '/auth/v1/admin/users?email=' + encodeURIComponent(email), { headers: adminHeaders });
    const lookupData = await lookupRes.json();
    const existing = lookupData && (lookupData.users || lookupData)[0];
    if (!existing || !existing.id) return res.status(409).json({ error: 'That email is already registered, but the existing account could not be found.' });
    userId = existing.id;
  } else {
    return res.status(500).json({ error: 'Could not create the invite', detail: inviteData });
  }

  // Upsert so re-adding someone who already has a staff_profiles row
  // (e.g. retry after a partial failure) just updates it in place.
  const profileRes = await fetch(SUPABASE_URL + '/rest/v1/staff_profiles?on_conflict=id', {
    method: 'POST',
    headers: { ...adminHeaders, Prefer: 'resolution=merge-duplicates,return=representation' },
    body: JSON.stringify([{ id: userId, name, email, role, position, can_schedule: canSchedule }]),
  });
  const profileRows = await profileRes.json();
  if (!profileRes.ok || !profileRows || !profileRows.length) {
    return res.status(500).json({ error: 'Invited the account but could not save the staff profile', detail: profileRows });
  }

  return res.status(200).json({ ok: true, staff: profileRows[0] });
}
