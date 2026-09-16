// api/send-campaign-test.js
// Vercel serverless function (Node runtime, no dependencies).
// Sends a one-off test copy of an in-progress campaign to the calling
// admin's own email address — the recipient is looked up from their
// verified session, never taken from the request body, so this can't
// be used to relay mail to an arbitrary address.
// Auth: same caller-is-admin check as api/invite-staff.js.
// Requires SUPABASE_URL, SUPABASE_ANON_KEY, RESEND_API_KEY as Vercel
// project environment variables.

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Missing auth token' });

  const { SUPABASE_URL, SUPABASE_ANON_KEY, RESEND_API_KEY } = process.env;
  if (!RESEND_API_KEY) return res.status(500).json({ error: 'Email is not configured yet (missing RESEND_API_KEY in Vercel env vars).' });
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return res.status(500).json({ error: 'Missing SUPABASE_URL/SUPABASE_ANON_KEY env vars.' });

  const { subject, html } = req.body || {};
  if (!subject || !html) return res.status(400).json({ error: 'Missing subject or message body.' });

  const callerRes = await fetch(SUPABASE_URL + '/auth/v1/user', {
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: 'Bearer ' + token },
  });
  const caller = await callerRes.json();
  if (!callerRes.ok || !caller || !caller.id || !caller.email) return res.status(401).json({ error: 'Could not verify session' });

  const callerProfileRes = await fetch(
    SUPABASE_URL + '/rest/v1/staff_profiles?select=role&id=eq.' + caller.id,
    { headers: { apikey: SUPABASE_ANON_KEY, Authorization: 'Bearer ' + token } }
  );
  const callerProfile = await callerProfileRes.json();
  if (!callerProfileRes.ok || !callerProfile || !callerProfile.length || callerProfile[0].role !== 'admin') {
    return res.status(403).json({ error: 'Only admins can send test campaigns.' });
  }

  const sendRes = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + RESEND_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: 'LVBC Marketing <ricky.greenfield@axiomfwd.com>',
      to: [caller.email],
      subject: '[TEST] ' + subject,
      html,
    }),
  });

  if (!sendRes.ok) {
    const err = await sendRes.text();
    return res.status(502).json({ error: 'Resend error: ' + err });
  }

  return res.status(200).json({ ok: true, sentTo: caller.email });
}
