// api/subscribe.js
// Vercel serverless function (Node runtime, no dependencies).
// Public signup endpoint for the email marketing list — no user is
// logged in here, so (unlike the other api/*.js functions) this uses
// the Supabase service role key instead of forwarding a user token.
// The function itself is the only thing standing between the public
// internet and this table, so it validates/normalizes input rather
// than relying on RLS.
// Requires SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY as Vercel project
// environment variables. RESEND_API_KEY is optional — if unset,
// subscribers are still saved, just not synced to Resend yet.
// Resend's Contacts API (as of 2026) has no "audience" concept —
// contacts live in one flat list per account, POST /contacts.

function isValidEmail(email) {
  return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, RESEND_API_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ error: 'Missing SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY env vars.' });
  }

  const body = req.body || {};
  const email = String(body.email || '').trim().toLowerCase();
  const name = body.name ? String(body.name).trim() : null;
  const topicIds = Array.isArray(body.topicIds) ? body.topicIds.filter((t) => typeof t === 'string') : [];

  if (!isValidEmail(email)) return res.status(400).json({ error: 'Please enter a valid email address.' });

  const adminHeaders = {
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: 'Bearer ' + SUPABASE_SERVICE_ROLE_KEY,
    'Content-Type': 'application/json',
  };

  const subRes = await fetch(SUPABASE_URL + '/rest/v1/email_subscribers?on_conflict=email', {
    method: 'POST',
    headers: { ...adminHeaders, Prefer: 'resolution=merge-duplicates,return=representation' },
    body: JSON.stringify([{ email, name, source: 'website', unsubscribed_at: null }]),
  });
  const subRows = await subRes.json();
  if (!subRes.ok || !subRows || !subRows.length) {
    return res.status(500).json({ error: 'Could not save subscriber', detail: subRows });
  }
  const subscriberId = subRows[0].id;

  if (topicIds.length) {
    const prefRes = await fetch(SUPABASE_URL + '/rest/v1/subscriber_topic_preferences?on_conflict=subscriber_id,topic_id', {
      method: 'POST',
      headers: { ...adminHeaders, Prefer: 'resolution=merge-duplicates' },
      body: JSON.stringify(topicIds.map((topic_id) => ({ subscriber_id: subscriberId, topic_id, subscribed: true }))),
    });
    if (!prefRes.ok) {
      const detail = await prefRes.text();
      return res.status(500).json({ error: 'Saved subscriber but could not save topic preferences', detail });
    }
  }

  let resendSynced = false;
  if (RESEND_API_KEY) {
    const [firstName, ...rest] = name ? name.split(' ') : [];
    const resendRes = await fetch('https://api.resend.com/contacts', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + RESEND_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email,
        first_name: firstName || undefined,
        last_name: rest.length ? rest.join(' ') : undefined,
        unsubscribed: false,
      }),
    });
    resendSynced = resendRes.ok;
  }

  return res.status(200).json({ ok: true, resendSynced });
}
