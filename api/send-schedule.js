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

// event_date is a timestamptz stored from the brewery's own local wall
// clock (see localDateTimeToISOString in js/events.js) — converting it
// back with the brewery's timezone, not the server's (Vercel runs in
// UTC), keeps late-evening events on the calendar day staff expect.
const BREWERY_TIMEZONE = 'America/Chicago';
function chicagoDateKey(isoString) {
  return new Date(isoString).toLocaleDateString('en-CA', { timeZone: BREWERY_TIMEZONE });
}

// ---- Recurring event occurrences for the month (ported from
// js/recurring.js — same weekly / monthly-nth-weekday + overrides
// logic used by the in-app calendar, so the emailed schedule matches
// what staff see there). ----
function nthWeekdayOfMonth(year, month, dow, n) {
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  if (n === 5) {
    const lastDate = new Date(year, month, daysInMonth);
    const diff = (lastDate.getDay() - dow + 7) % 7;
    return daysInMonth - diff;
  }
  const firstDow = new Date(year, month, 1).getDay();
  const day = 1 + ((dow - firstDow + 7) % 7) + (n - 1) * 7;
  return day <= daysInMonth ? day : null;
}
function isRecurringOccurrenceDate(re, d) {
  if (re.recurrence_type === 'weekly') return d.getDay() === re.day_of_week;
  return nthWeekdayOfMonth(d.getFullYear(), d.getMonth(), re.day_of_week, re.week_of_month) === d.getDate();
}
function computeRecurringOccurrences(recurringEvents, recurringOverrides, startDate, endDate) {
  const toDateStr = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  const startStr = toDateStr(startDate), endStr = toDateStr(endDate);
  const results = [];

  recurringEvents.forEach((re) => {
    for (let d = new Date(startDate); d <= endDate; d.setDate(d.getDate() + 1)) {
      if (!isRecurringOccurrenceDate(re, d)) continue;
      const baseDateStr = toDateStr(d);
      const override = recurringOverrides.find((o) => o.recurring_event_id === re.id && o.occurrence_date === baseDateStr);
      if (override && (override.skipped || override.moved_to_date)) continue;
      results.push({ date: baseDateStr, name: re.name });
    }
  });

  recurringOverrides.forEach((o) => {
    if (o.skipped || !o.moved_to_date) return;
    if (o.moved_to_date < startStr || o.moved_to_date > endStr) return;
    const re = recurringEvents.find((x) => x.id === o.recurring_event_id);
    if (re) results.push({ date: o.moved_to_date, name: re.name });
  });

  return results;
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

  // A duplicate/placeholder profile (see migration_008/014) can hold
  // shift assignments meant for this person under a different id —
  // pull every staff_profiles row sharing this session's email.
  const meRes = await fetch(SUPABASE_URL + '/rest/v1/staff_profiles?select=id,name&email=eq.' + encodeURIComponent(email), { headers: authHeaders });
  const me = await meRes.json();
  if (!meRes.ok || !me || !me.length) return res.status(401).json({ error: 'Could not verify session' });
  const staffIds = me.map((r) => r.id);
  const staffName = me[0].name;

  const y = year || new Date().getFullYear();
  const m = month || (new Date().getMonth() + 1);
  const monthStart = y + '-' + String(m).padStart(2, '0') + '-01';
  const nextMonth = new Date(y, m, 1);
  const monthEndExclusive = nextMonth.getFullYear() + '-' + String(nextMonth.getMonth() + 1).padStart(2, '0') + '-01';

  const staffIdList = staffIds.map((id) => '"' + id + '"').join(',');
  const shiftsRes = await fetch(
    SUPABASE_URL + '/rest/v1/shifts?select=*&staff_id=in.(' + staffIdList + ')&shift_date=gte.' + monthStart + '&shift_date=lt.' + monthEndExclusive + '&order=shift_date.asc',
    { headers: authHeaders }
  );
  const shifts = await shiftsRes.json();
  if (!shiftsRes.ok) return res.status(500).json({ error: 'Could not load shifts' });

  // Who's MOD each day this month (a day-level assignment, separate
  // from this person's own rows — see schema.sql's note on `shifts`).
  const modRes = await fetch(
    SUPABASE_URL + '/rest/v1/shifts?select=shift_date,staff:staff_id(name)&role=eq.manager&shift_date=gte.' + monthStart + '&shift_date=lt.' + monthEndExclusive,
    { headers: authHeaders }
  );
  const modShifts = modRes.ok ? await modRes.json() : [];
  const modByDate = {};
  (modShifts || []).forEach((s) => {
    if (!s.staff || !s.staff.name) return;
    modByDate[s.shift_date] = modByDate[s.shift_date] ? modByDate[s.shift_date] + ', ' + s.staff.name : s.staff.name;
  });

  // One-off events (Beer release, VFW night, etc.) plus recurring
  // series (trivia, live music) computed the same way the in-app
  // calendar does, so the email matches what staff see there.
  const [oneOffRes, recEventsRes, recOverridesRes] = await Promise.all([
    fetch(SUPABASE_URL + '/rest/v1/events?select=event_name,event_date&event_date=gte.' + monthStart + 'T00:00:00&event_date=lt.' + monthEndExclusive + 'T00:00:00', { headers: authHeaders }),
    fetch(SUPABASE_URL + '/rest/v1/recurring_events?select=*&is_active=eq.true', { headers: authHeaders }),
    fetch(SUPABASE_URL + '/rest/v1/recurring_event_overrides?select=*', { headers: authHeaders }),
  ]);
  const oneOffEvents = oneOffRes.ok ? await oneOffRes.json() : [];
  const recurringEvents = recEventsRes.ok ? await recEventsRes.json() : [];
  const recurringOverrides = recOverridesRes.ok ? await recOverridesRes.json() : [];

  const eventsByDate = {};
  const addEvent = (date, name) => {
    if (!date || !name) return;
    eventsByDate[date] = eventsByDate[date] ? eventsByDate[date] + ', ' + name : name;
  };
  (oneOffEvents || []).forEach((e) => addEvent(chicagoDateKey(e.event_date), e.event_name));
  computeRecurringOccurrences(recurringEvents || [], recurringOverrides || [], new Date(y, m - 1, 1), new Date(y, m, 0))
    .forEach((occ) => addEvent(occ.date, occ.name));

  const rows = (shifts || []).map((s) => {
    const label = s.role === 'manager' ? 'Manager on Duty' : (s.period === 'morning' ? 'Morning' : 'Evening');
    const d = new Date(s.shift_date + 'T00:00:00');
    const dateLabel = d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
    const timeLabel = fmtTime(s.start_time) + (s.end_time ? '–' + fmtTime(s.end_time) : '');
    const modLabel = s.role === 'manager' ? '' : (modByDate[s.shift_date] || '');
    const eventsLabel = eventsByDate[s.shift_date] || '';
    return '<tr><td style="padding:6px 12px;">' + dateLabel + '</td><td style="padding:6px 12px;">' + label + '</td><td style="padding:6px 12px;">' + timeLabel + '</td>'
      + '<td style="padding:6px 12px;">' + modLabel + '</td><td style="padding:6px 12px;">' + eventsLabel + '</td></tr>';
  }).join('');

  const monthLabel = new Date(y, m - 1, 1).toLocaleString('default', { month: 'long', year: 'numeric' });
  const headerRow = '<tr><th style="text-align:left;padding:6px 12px;">Date</th><th style="text-align:left;padding:6px 12px;">Shift</th>'
    + '<th style="text-align:left;padding:6px 12px;">Time</th><th style="text-align:left;padding:6px 12px;">MOD</th><th style="text-align:left;padding:6px 12px;">Events</th></tr>';
  const html = '<h2>LVBC Schedule &mdash; ' + monthLabel + '</h2><p>Hi ' + (staffName || '') + ', here\'s your schedule.</p>'
    + (rows ? '<table>' + headerRow + rows + '</table>' : '<p>No shifts scheduled this month.</p>');

  const sendRes = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + RESEND_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: 'LVBC Schedule <ricky.greenfield@axiomfwd.com>',
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
