// api/marketing-status.js
// Vercel serverless function (Node runtime, no dependencies).
// Admin-only: reports whether the env vars the email marketing tool
// needs are actually set, without ever exposing their values — lets
// the Marketing > Settings screen show "Configured"/"Missing" instead
// of an owner having to guess why sends or tracking silently fail.
// Auth: same caller-is-admin check as api/invite-staff.js, using the
// forwarded user token against staff_profiles.role (not the service key).
// Requires SUPABASE_URL, SUPABASE_ANON_KEY as Vercel project env vars.

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Missing auth token' });

  const { SUPABASE_URL, SUPABASE_ANON_KEY, RESEND_API_KEY, RESEND_WEBHOOK_SECRET } = process.env;
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return res.status(500).json({ error: 'Missing SUPABASE_URL/SUPABASE_ANON_KEY env vars.' });

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
    return res.status(403).json({ error: 'Only admins can view marketing settings.' });
  }

  return res.status(200).json({
    resendConfigured: !!RESEND_API_KEY,
    webhookConfigured: !!RESEND_WEBHOOK_SECRET,
  });
}
