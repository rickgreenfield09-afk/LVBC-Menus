// api/notify-coverage-claimed.js
// Vercel serverless function (Node runtime, no dependencies).
// Fires after a coverage request is marked 'claimed' — emails every
// bartender on file (role != admin, email set) that the shift has
// been covered, so no one else shows up to try to claim it too.
// Auth: the client forwards the claimer's Supabase access token; this
// function uses it (not a service-role key) to read staff_profiles /
// shifts / coverage_requests, so results are scoped by that user's
// own RLS policies (is_staff() covers all of these reads).
// Requires SUPABASE_URL, SUPABASE_ANON_KEY, and RESEND_API_KEY set
// as Vercel project environment variables — same as api/send-schedule.js.

function fmtTime(t) {
  if (!t) return '';
  const [h, mm] = t.split(':');
  const hr = ((+h + 11) % 12) + 1;
  return hr + (mm === '00' ? '' : ':' + mm) + (+h < 12 ? 'am' : 'pm');
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Missing auth token' });

  const { SUPABASE_URL, SUPABASE_ANON_KEY, RESEND_API_KEY } = process.env;
  if (!RESEND_API_KEY) return res.status(200).json({ ok: false, skipped: 'Email is not configured yet (missing RESEND_API_KEY in Vercel env vars).' });
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return res.status(500).json({ error: 'Missing SUPABASE_URL/SUPABASE_ANON_KEY env vars.' });

  const { requestId } = req.body || {};
  if (!requestId) return res.status(400).json({ error: 'Missing requestId' });

  const authHeaders = { apikey: SUPABASE_ANON_KEY, Authorization: 'Bearer ' + token };

  const reqRes = await fetch(
    SUPABASE_URL + '/rest/v1/coverage_requests?select=*,shifts(shift_date,role,period,start_time,end_time),requested:requested_by(name),claimer:claimed_by(name)&id=eq.' + encodeURIComponent(requestId),
    { headers: authHeaders }
  );
  const rows = await reqRes.json();
  if (!reqRes.ok || !rows || !rows.length) return res.status(404).json({ error: 'Coverage request not found' });
  const cr = rows[0];
  const shift = cr.shifts || {};

  const staffRes = await fetch(SUPABASE_URL + '/rest/v1/staff_profiles?select=email&role=neq.admin&email=not.is.null', { headers: authHeaders });
  const staff = await staffRes.json();
  if (!staffRes.ok) return res.status(500).json({ error: 'Could not load staff list' });
  const emails = Array.from(new Set((staff || []).map((s) => s.email).filter(Boolean)));
  if (!emails.length) return res.status(200).json({ ok: true, sent: 0 });

  const d = shift.shift_date ? new Date(shift.shift_date + 'T00:00:00') : null;
  const dateLabel = d ? d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' }) : '';
  const label = shift.role === 'manager' ? 'Manager on Duty' : (shift.period === 'morning' ? 'Morning' : 'Evening');
  const timeLabel = fmtTime(shift.start_time) + (shift.end_time ? '–' + fmtTime(shift.end_time) : '');
  const claimerName = (cr.claimer && cr.claimer.name) || 'Someone';
  const requesterName = (cr.requested && cr.requested.name) || 'A staffer';

  const html = '<h2>Shift Covered</h2>'
    + '<p><strong>' + claimerName + '</strong> has picked up ' + requesterName + '\'s ' + label + ' shift on ' + dateLabel + (timeLabel ? ' (' + timeLabel + ')' : '') + '.</p>'
    + '<p>No further action needed.</p>';

  const sendRes = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + RESEND_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: 'LVBC Schedule <onboarding@resend.dev>',
      to: emails,
      subject: 'Shift covered — ' + dateLabel,
      html,
    }),
  });

  if (!sendRes.ok) {
    const err = await sendRes.text();
    return res.status(502).json({ error: 'Resend error: ' + err });
  }

  return res.status(200).json({ ok: true, sent: emails.length });
}
