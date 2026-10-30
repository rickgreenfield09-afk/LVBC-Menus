// api/event-request.js
// Vercel serverless function (Node runtime, no dependencies).
// Public endpoint behind event-request.html (the form embedded in the
// brewery website). No user is logged in, so this inserts with the
// service role key and validates input itself instead of relying on RLS.
// Requires SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.

const EVENT_TYPES = ['Private party', 'Birthday', 'Corporate event', 'Fundraiser', 'Live music', 'Wedding or shower', 'Other'];

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function cleanDate(v) {
  return /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
}

function cleanTime(v) {
  return /^\d{2}:\d{2}$/.test(v) ? v : null;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ error: 'Missing SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY env vars.' });
  }

  const body = req.body || {};
  // Hidden field real people never fill in; pretend success for bots.
  if (body.website) return res.status(200).json({ ok: true });

  const str = (v, max) => String(v == null ? '' : v).trim().slice(0, max);
  const name = str(body.name, 120);
  const organization = str(body.organization, 160) || null;
  const email = str(body.email, 200).toLowerCase();
  const phone = str(body.phone, 40) || null;
  const eventType = EVENT_TYPES.includes(body.eventType) ? body.eventType : null;
  const eventDate = cleanDate(String(body.eventDate || ''));
  const altDate = cleanDate(String(body.altDate || ''));
  const guests = parseInt(body.guestCount, 10);

  if (!name) return res.status(400).json({ error: 'Please enter your name.' });
  if (!isValidEmail(email)) return res.status(400).json({ error: 'Please enter a valid email address.' });
  if (!eventType) return res.status(400).json({ error: 'Please choose an event type.' });
  if (!eventDate) return res.status(400).json({ error: 'Please choose a preferred date.' });
  if (eventDate < new Date().toISOString().slice(0, 10)) {
    return res.status(400).json({ error: 'Please choose a date in the future.' });
  }

  const row = {
    name,
    organization,
    email,
    phone,
    event_type: eventType,
    event_date: eventDate,
    alt_date: altDate,
    start_time: cleanTime(String(body.startTime || '')),
    end_time: cleanTime(String(body.endTime || '')),
    guest_count: Number.isFinite(guests) && guests > 0 && guests < 10000 ? guests : null,
    details: str(body.details, 3000) || null,
  };

  const insRes = await fetch(SUPABASE_URL + '/rest/v1/event_requests', {
    method: 'POST',
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: 'Bearer ' + SUPABASE_SERVICE_ROLE_KEY,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
    body: JSON.stringify(row),
  });
  if (!insRes.ok) {
    return res.status(500).json({ error: 'Could not save your request. Please try again or call us.' });
  }

  return res.status(200).json({ ok: true });
}
