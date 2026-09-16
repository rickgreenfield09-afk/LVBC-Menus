// api/send-campaign.js
// Vercel serverless function (Node runtime, no dependencies).
// Sends a saved campaign to its audience (a specific topic's opted-in
// subscribers, or everyone if no topic is set) and marks it sent.
//
// Recipients get individual emails via Resend's batch endpoint (not
// a Resend Broadcast) — Resend's Contacts API has no audience/segment
// concept we can rely on (see api/subscribe.js), so Supabase stays
// the single source of truth for who's subscribed to what. Each
// email is tagged with campaign_id so api/resend-webhook.js can
// attribute opens/clicks back to this campaign, and gets its own
// unsubscribe link (CAN-SPAM requires this on every marketing send).
//
// Auth: same caller-is-admin check as api/invite-staff.js, then reads
// with the caller's own forwarded token — RLS already lets any staff
// read subscribers/preferences/campaigns, so no service role key is
// needed here.
// Requires SUPABASE_URL, SUPABASE_ANON_KEY, RESEND_API_KEY.

function unsubscribeFooter(subscriberId, baseUrl) {
  return '<hr style="margin-top:24px;border:none;border-top:1px solid #ddd;">'
    + '<p style="font-size:11px;color:#999;margin-top:8px;">You\'re receiving this because you subscribed to Lago Vista Brewing Company emails. '
    + '<a href="' + baseUrl + '/api/unsubscribe?id=' + subscriberId + '" style="color:#999;">Unsubscribe</a></p>';
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Missing auth token' });

  const { SUPABASE_URL, SUPABASE_ANON_KEY, RESEND_API_KEY } = process.env;
  if (!RESEND_API_KEY) return res.status(500).json({ error: 'Email is not configured yet (missing RESEND_API_KEY in Vercel env vars).' });
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return res.status(500).json({ error: 'Missing SUPABASE_URL/SUPABASE_ANON_KEY env vars.' });

  const { campaignId } = req.body || {};
  if (!campaignId) return res.status(400).json({ error: 'Missing campaignId' });

  const authHeaders = { apikey: SUPABASE_ANON_KEY, Authorization: 'Bearer ' + token };

  const callerRes = await fetch(SUPABASE_URL + '/auth/v1/user', { headers: authHeaders });
  const caller = await callerRes.json();
  if (!callerRes.ok || !caller || !caller.id) return res.status(401).json({ error: 'Could not verify session' });

  const callerProfileRes = await fetch(SUPABASE_URL + '/rest/v1/staff_profiles?select=role&id=eq.' + caller.id, { headers: authHeaders });
  const callerProfile = await callerProfileRes.json();
  if (!callerProfileRes.ok || !callerProfile || !callerProfile.length || callerProfile[0].role !== 'admin') {
    return res.status(403).json({ error: 'Only admins can send campaigns.' });
  }

  const campRes = await fetch(SUPABASE_URL + '/rest/v1/email_campaigns?id=eq.' + campaignId + '&select=*', { headers: authHeaders });
  const campRows = await campRes.json();
  if (!campRes.ok || !campRows || !campRows.length) return res.status(404).json({ error: 'Campaign not found' });
  const campaign = campRows[0];
  if (campaign.status === 'sent') return res.status(409).json({ error: 'This campaign has already been sent.' });

  let recipients;
  if (campaign.topic_id) {
    const prefRes = await fetch(
      SUPABASE_URL + '/rest/v1/subscriber_topic_preferences?select=subscriber:subscriber_id(id,email,unsubscribed_at)&topic_id=eq.' + campaign.topic_id + '&subscribed=eq.true',
      { headers: authHeaders }
    );
    const prefRows = await prefRes.json();
    if (!prefRes.ok) return res.status(500).json({ error: 'Could not load this topic\'s subscribers' });
    recipients = (prefRows || []).map((r) => r.subscriber).filter((s) => s && !s.unsubscribed_at);
  } else {
    const subRes = await fetch(SUPABASE_URL + '/rest/v1/email_subscribers?select=id,email&unsubscribed_at=is.null', { headers: authHeaders });
    recipients = await subRes.json();
    if (!subRes.ok) return res.status(500).json({ error: 'Could not load subscribers' });
  }

  if (!recipients.length) return res.status(400).json({ error: 'No subscribers match this campaign\'s audience.' });

  const baseUrl = 'https://' + req.headers.host;
  const messages = recipients.map((r) => ({
    from: 'Lago Vista Brewing Company <ricky.greenfield@axiomfwd.com>',
    to: [r.email],
    subject: campaign.subject,
    html: campaign.html_body + unsubscribeFooter(r.id, baseUrl),
    tags: [{ name: 'campaign_id', value: campaign.id }],
  }));

  for (let i = 0; i < messages.length; i += 100) {
    const chunk = messages.slice(i, i + 100);
    const batchRes = await fetch('https://api.resend.com/emails/batch', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + RESEND_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify(chunk),
    });
    if (!batchRes.ok) {
      const err = await batchRes.text();
      return res.status(502).json({ error: 'Resend error: ' + err, sentBeforeError: i });
    }
  }

  const updateRes = await fetch(SUPABASE_URL + '/rest/v1/email_campaigns?id=eq.' + campaign.id, {
    method: 'PATCH',
    headers: { ...authHeaders, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify({ status: 'sent', sent_at: new Date().toISOString() }),
  });
  if (!updateRes.ok) {
    return res.status(200).json({ ok: true, sent: recipients.length, warning: 'Emails were sent, but the campaign status could not be updated — refresh to check.' });
  }

  return res.status(200).json({ ok: true, sent: recipients.length });
}
