// api/resend-webhook.js
// Vercel serverless function (Node runtime, no dependencies).
// Receives delivery/open/click/bounce/complaint events from Resend
// and logs them to email_events for the campaign analytics view.
//
// Resend signs webhooks using Svix (https://docs.svix.com/receiving/verifying-payloads/how).
// There's no user session here (Resend is calling us, not a browser),
// so — like api/subscribe.js — this uses the Supabase service role
// key rather than a forwarded user token.
//
// Requires SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, and
// RESEND_WEBHOOK_SECRET (the "whsec_..." signing secret shown when
// you add the endpoint in the Resend dashboard) as Vercel env vars.
//
// Body parsing must be disabled — signature verification needs the
// exact raw bytes Resend signed, not a re-serialized JSON.parse.
export const config = { api: { bodyParser: false } };

import crypto from 'crypto';

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

// Verifies a Svix-signed webhook. Returns true/false — never throws.
function isValidSignature(rawBody, headers, secret) {
  try {
    const svixId = headers['svix-id'];
    const svixTimestamp = headers['svix-timestamp'];
    const svixSignature = headers['svix-signature'];
    if (!svixId || !svixTimestamp || !svixSignature) return false;

    const secretBytes = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
    const signedContent = svixId + '.' + svixTimestamp + '.' + rawBody;
    const expected = crypto.createHmac('sha256', secretBytes).update(signedContent).digest('base64');

    return svixSignature.split(' ').some((part) => {
      const sig = part.split(',')[1] || '';
      return sig.length === expected.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
    });
  } catch {
    return false;
  }
}

// Maps a Resend event "type" to our email_events.event_type enum.
// Unrecognized types (email.sent, email.delivery_delayed, etc.) are
// intentionally ignored rather than force-fit into the enum.
const EVENT_TYPE_MAP = {
  'email.delivered': 'delivered',
  'email.opened': 'opened',
  'email.clicked': 'clicked',
  'email.bounced': 'bounced',
  'email.complained': 'complained',
};

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, RESEND_WEBHOOK_SECRET } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return res.status(500).json({ error: 'Missing SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY env vars.' });
  if (!RESEND_WEBHOOK_SECRET) return res.status(500).json({ error: 'Missing RESEND_WEBHOOK_SECRET env var.' });

  const rawBody = await readRawBody(req);
  if (!isValidSignature(rawBody, req.headers, RESEND_WEBHOOK_SECRET)) {
    return res.status(401).json({ error: 'Invalid signature' });
  }

  let event;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return res.status(400).json({ error: 'Invalid JSON body' });
  }

  const eventType = EVENT_TYPE_MAP[event.type];
  if (!eventType) return res.status(200).json({ ok: true, skipped: event.type });

  const data = event.data || {};
  const subscriberEmail = Array.isArray(data.to) ? data.to[0] : data.to;
  if (!subscriberEmail) return res.status(200).json({ ok: true, skipped: 'no recipient on event' });

  const adminHeaders = {
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: 'Bearer ' + SUPABASE_SERVICE_ROLE_KEY,
    'Content-Type': 'application/json',
  };

  // Campaign sends (api/send-campaign.js) tag each message with
  // campaign_id since they go out as individual batched emails, not
  // Resend Broadcasts — there's no broadcast_id to key off. Resend
  // echoes tags back as an object keyed by name, but handle an array
  // of {name,value} too in case that ever changes.
  let campaignId = null;
  const tags = data.tags;
  if (tags) {
    campaignId = Array.isArray(tags)
      ? (tags.find((t) => t.name === 'campaign_id') || {}).value || null
      : tags.campaign_id || null;
  }

  const insertRes = await fetch(SUPABASE_URL + '/rest/v1/email_events', {
    method: 'POST',
    headers: adminHeaders,
    body: JSON.stringify([{
      campaign_id: campaignId,
      subscriber_email: subscriberEmail,
      event_type: eventType,
      link_url: data.click ? data.click.link : null,
      occurred_at: event.created_at || new Date().toISOString(),
      raw_payload: event,
    }]),
  });

  if (!insertRes.ok) {
    const detail = await insertRes.text();
    return res.status(500).json({ error: 'Could not save event', detail });
  }

  // Auto-suppress: a spam complaint always means stop emailing them.
  // A bounce only means that if it's permanent (bad/closed address) —
  // a transient bounce (mailbox full, server down) is expected to
  // clear up on its own and shouldn't unsubscribe someone.
  const isPermanentBounce = eventType === 'bounced' && String((data.bounce || {}).type || '').toLowerCase() === 'permanent';
  if (eventType === 'complained' || isPermanentBounce) {
    await fetch(
      SUPABASE_URL + '/rest/v1/email_subscribers?email=eq.' + encodeURIComponent(subscriberEmail) + '&unsubscribed_at=is.null',
      { method: 'PATCH', headers: adminHeaders, body: JSON.stringify({ unsubscribed_at: event.created_at || new Date().toISOString() }) }
    );
  }

  return res.status(200).json({ ok: true });
}
