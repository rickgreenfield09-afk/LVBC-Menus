// api/send-schedule.js
// Vercel serverless function (Node runtime, no dependencies).
// Sends the calling staffer their own month's shifts via Resend.
// Auth: the client forwards their Supabase access token; this
// function uses it (not a service-role key) to read staff_profiles
// and shifts, so results are scoped by that user's own RLS policies.
// Requires SUPABASE_URL, SUPABASE_ANON_KEY, and RESEND_API_KEY set
// as Vercel project environment variables.

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
  if (!RESEND_API_KEY) return res.status(500).json({ error: 'Email is not configured yet (missing RESEND_API_KEY in Vercel env vars).' });
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return res.status(500).json({ error: 'Missing SUPABASE_URL/SUPABASE_ANON_KEY env vars.' });

  const { email, month, year } = req.body || {};
  if (!email) return res.status(400).json({ error: 'Missing email' });

  const authHeaders = { apikey: SUPABASE_ANON_KEY, Authorization: 'Bearer ' + token };

  const meRes = await fetch(SUPABASE_URL + '/rest/v1/staff_profiles?select=id,name', { headers: authHeaders });
  const me = await meRes.json();
  if (!meRes.ok || !me || !me[0]) return res.status(401).json({ error: 'Could not verify session' });
  const staffId = me[0].id;
  const staffName = me[0].name;

  const y = year || new Date().getFullYear();
  const m = month || (new Date().getMonth() + 1);
  const monthStart = y + '-' + String(m).padStart(2, '0') + '-01';
  const nextMonth = new Date(y, m, 1);
  const monthEndExclusive = nextMonth.getFullYear() + '-' + String(nextMonth.getMonth() + 1).padStart(2, '0') + '-01';

  const shiftsRes = await fetch(
    SUPABASE_URL + '/rest/v1/shifts?select=*&staff_id=eq.' + staffId + '&shift_date=gte.' + monthStart + '&shift_date=lt.' + monthEndExclusive + '&order=shift_date.asc',
    { headers: authHeaders }
  );
  const shifts = await shiftsRes.json();
  if (!shiftsRes.ok) return res.status(500).json({ error: 'Could not load shifts' });

  const rows = (shifts || []).map((s) => {
    const label = s.role === 'manager' ? 'Manager on Duty' : (s.period === 'morning' ? 'Morning' : 'Evening');
    const d = new Date(s.shift_date + 'T00:00:00');
    const dateLabel = d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
    const timeLabel = fmtTime(s.start_time) + (s.end_time ? '–' + fmtTime(s.end_time) : '');
    return '<tr><td style="padding:6px 12px;">' + dateLabel + '</td><td style="padding:6px 12px;">' + label + '</td><td style="padding:6px 12px;">' + timeLabel + '</td></tr>';
  }).join('');

  const monthLabel = new Date(y, m - 1, 1).toLocaleString('default', { month: 'long', year: 'numeric' });
  const html = '<h2>LVBC Schedule &mdash; ' + monthLabel + '</h2><p>Hi ' + (staffName || '') + ', here\'s your schedule.</p>'
    + (rows ? '<table>' + rows + '</table>' : '<p>No shifts scheduled this month.</p>');

  const sendRes = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + RESEND_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: 'LVBC Schedule <onboarding@resend.dev>',
      to: [email],
      subject: 'Your LVBC Schedule — ' + monthLabel,
      html,
    }),
  });

  if (!sendRes.ok) {
    const err = await sendRes.text();
    return res.status(502).json({ error: 'Resend error: ' + err });
  }

  return res.status(200).json({ ok: true });
}
