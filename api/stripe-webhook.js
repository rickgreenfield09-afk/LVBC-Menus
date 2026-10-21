// api/stripe-webhook.js
// Vercel serverless function (Node runtime, no dependencies).
// Receives subscription events from Stripe and keeps each member's
// subscription record and tier in step with what they've paid for.
//
// There's no user session here (Stripe is calling us, not a browser),
// so — like api/resend-webhook.js — this uses the Supabase service role
// key rather than a forwarded user token.
//
// Requires SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, STRIPE_SECRET_KEY
// and STRIPE_WEBHOOK_SECRET (the "whsec_..." signing secret shown when
// you add the endpoint in the Stripe dashboard) as Vercel env vars.
// Subscribe the endpoint to: checkout.session.completed,
// customer.subscription.created, customer.subscription.updated,
// customer.subscription.deleted.
//
// Events can arrive out of order or twice, so the event is only used to
// learn WHICH subscription changed — its current state is then read
// straight from Stripe and applied. That makes every event safe to
// replay, and Stripe retrying a failed delivery just redoes the work.
//
// Body parsing must be disabled — signature verification needs the
// exact raw bytes Stripe signed, not a re-serialized JSON.parse.
export const config = { api: { bodyParser: false } };

import crypto from 'crypto';
import { stripeFetch } from './_lib/stripe.js';
import { serviceHeaders } from './_lib/staff-auth.js';

const TOLERANCE_SECONDS = 300;

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

// Verifies the Stripe-Signature header ("t=...,v1=...,v1=..."). Returns
// true/false — never throws.
function isValidSignature(rawBody, header, secret) {
  try {
    if (!header) return false;
    const parts = header.split(',').map((p) => p.split('='));
    const timestamp = (parts.find((p) => p[0] === 't') || [])[1];
    const signatures = parts.filter((p) => p[0] === 'v1').map((p) => p[1]);
    if (!timestamp || !signatures.length) return false;
    if (Math.abs(Date.now() / 1000 - Number(timestamp)) > TOLERANCE_SECONDS) return false;

    const expected = crypto.createHmac('sha256', secret).update(timestamp + '.' + rawBody).digest('hex');
    return signatures.some((sig) => sig.length === expected.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected)));
  } catch {
    return false;
  }
}

// The member this subscription belongs to: the id we put on it at
// checkout, else whoever owns the Stripe customer.
async function findMemberId(subscription) {
  const { SUPABASE_URL } = process.env;
  const fromMeta = subscription.metadata && subscription.metadata.member_id;
  if (fromMeta) return fromMeta;
  const r = await fetch(
    SUPABASE_URL + '/rest/v1/members?select=id&stripe_customer_id=eq.' + encodeURIComponent(subscription.customer),
    { headers: serviceHeaders() }
  );
  const rows = await r.json();
  return r.ok && rows.length ? rows[0].id : null;
}

async function syncSubscription(subscriptionId) {
  const sub = await stripeFetch('GET', '/v1/subscriptions/' + encodeURIComponent(subscriptionId));
  const memberId = await findMemberId(sub);
  if (!memberId) return { skipped: 'no member for subscription ' + sub.id };

  const item = sub.items && sub.items.data && sub.items.data[0];
  const r = await fetch(process.env.SUPABASE_URL + '/rest/v1/rpc/membership_apply_subscription', {
    method: 'POST',
    headers: serviceHeaders(),
    body: JSON.stringify({
      p_member: memberId,
      p_subscription_id: sub.id,
      p_price_id: item && item.price ? item.price.id : null,
      p_status: sub.status,
      p_period_end: sub.current_period_end ? new Date(sub.current_period_end * 1000).toISOString() : null,
      p_cancel_at_period_end: !!sub.cancel_at_period_end,
    }),
  });
  if (!r.ok) throw new Error('Could not save subscription: ' + (await r.text()));
  return { ok: true };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, STRIPE_WEBHOOK_SECRET } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return res.status(500).json({ error: 'Missing SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY env vars.' });
  if (!STRIPE_WEBHOOK_SECRET) return res.status(500).json({ error: 'Missing STRIPE_WEBHOOK_SECRET env var.' });

  const rawBody = await readRawBody(req);
  if (!isValidSignature(rawBody, req.headers['stripe-signature'], STRIPE_WEBHOOK_SECRET)) {
    return res.status(401).json({ error: 'Invalid signature' });
  }

  let event;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return res.status(400).json({ error: 'Invalid JSON body' });
  }

  const obj = (event.data && event.data.object) || {};
  let subscriptionId = null;
  if (event.type === 'checkout.session.completed') subscriptionId = obj.mode === 'subscription' ? obj.subscription : null;
  else if (event.type.startsWith('customer.subscription.')) subscriptionId = obj.id;
  if (!subscriptionId) return res.status(200).json({ ok: true, skipped: event.type });

  try {
    return res.status(200).json(await syncSubscription(subscriptionId));
  } catch (err) {
    // A non-2xx makes Stripe retry, which is what we want for a failure.
    return res.status(500).json({ error: err.message });
  }
}
