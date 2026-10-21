// api/store-checkout.js
// Vercel serverless function (Node runtime, no dependencies).
// Starts a Stripe Embedded Checkout for a one-off store item — an event
// ticket or a merch pre-order (migration_046). Open to anyone: a signed-in
// member (their token is sent) gets their tier's merch discount and the
// order lands in their account; a guest gives a name and email.
//
// POST { item_id, quantity, name?, email? } -> { clientSecret, publishableKey, orderId }
//
// The price is worked out in the database (store_reserve_order), which
// also holds the stock for the buyer while they pay — nothing about
// price or availability is trusted from the browser. The charge is made
// with an inline price, so the item needs no product in Stripe. Sales
// tax, when the item is taxable, is a Stripe tax rate built from
// store_settings.sales_tax_rate. api/stripe-webhook.js marks the order
// paid.
//
// Requires STRIPE_SECRET_KEY and STRIPE_PUBLISHABLE_KEY (plus the
// Supabase env vars) as Vercel env vars.
import { stripeFetch } from './_lib/stripe.js';
import { optionalMember } from './_lib/member-auth.js';
import { isValidEmail, serviceHeaders } from './_lib/staff-auth.js';

// The Stripe tax rate for the current store setting, made on first use
// and again whenever the rate in store_settings changes.
async function taxRateId(headers) {
  const { SUPABASE_URL } = process.env;
  const r = await fetch(SUPABASE_URL + '/rest/v1/store_settings?select=sales_tax_rate,stripe_tax_rate_id,stripe_tax_rate_percent&id=eq.1', { headers });
  const rows = await r.json();
  if (!r.ok || !rows.length) throw new Error('Store settings are missing.');
  const s = rows[0];
  const percent = Math.round(Number(s.sales_tax_rate) * 100000) / 1000;
  if (s.stripe_tax_rate_id && Number(s.stripe_tax_rate_percent) === percent) return s.stripe_tax_rate_id;

  const rate = await stripeFetch('POST', '/v1/tax_rates', { display_name: 'Sales tax', percentage: percent, inclusive: false });
  await fetch(SUPABASE_URL + '/rest/v1/store_settings?id=eq.1', {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ stripe_tax_rate_id: rate.id, stripe_tax_rate_percent: percent }),
  });
  return rate.id;
}

// Frees the held stock when checkout can't be started.
async function releaseOrder(orderId, headers) {
  await fetch(process.env.SUPABASE_URL + '/rest/v1/store_orders?id=eq.' + orderId, {
    method: 'PATCH', headers, body: JSON.stringify({ status: 'canceled' }),
  });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, STRIPE_PUBLISHABLE_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return res.status(500).json({ error: 'Missing SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY env vars.' });
  if (!STRIPE_PUBLISHABLE_KEY) return res.status(500).json({ error: 'Missing STRIPE_PUBLISHABLE_KEY env var.' });

  const body = req.body || {};
  const quantity = Number(body.quantity);
  if (!body.item_id || !Number.isInteger(quantity) || quantity < 1) return res.status(400).json({ error: 'Choose an item and a quantity.' });

  const member = await optionalMember(req);
  const name = member ? member.name : String(body.name || '').trim();
  const email = member ? member.email : String(body.email || '').trim().toLowerCase();
  if (!name) return res.status(400).json({ error: 'Enter your name.' });
  if (!isValidEmail(email)) return res.status(400).json({ error: 'Enter a valid email address.' });

  const headers = serviceHeaders();

  const reserveRes = await fetch(SUPABASE_URL + '/rest/v1/rpc/store_reserve_order', {
    method: 'POST',
    headers,
    body: JSON.stringify({ p_item: body.item_id, p_qty: quantity, p_member: member ? member.id : null, p_name: name, p_email: email }),
  });
  const reserved = await reserveRes.json();
  // The function's own messages ("Sold out.", "Only 3 left.") are meant for the buyer.
  if (!reserveRes.ok) return res.status(409).json({ error: reserved.message || 'Could not start checkout.' });

  try {
    const lineItem = {
      quantity,
      price_data: {
        currency: 'usd',
        unit_amount: reserved.unit_cents,
        product_data: {
          name: reserved.name + (reserved.discount_pct ? ' (member price)' : ''),
          ...(reserved.description ? { description: reserved.description } : {}),
        },
      },
    };
    if (reserved.taxable) lineItem.tax_rates = [await taxRateId(headers)];

    const session = await stripeFetch('POST', '/v1/checkout/sessions', {
      mode: 'payment',
      ui_mode: 'embedded',
      redirect_on_completion: 'never',
      // A member keeps their Stripe customer so receipts and the portal line up.
      ...(member && member.stripe_customer_id ? { customer: member.stripe_customer_id } : { customer_email: email }),
      client_reference_id: reserved.order_id,
      line_items: [lineItem],
      expires_at: Math.floor(Date.now() / 1000) + 31 * 60,
      metadata: { order_id: reserved.order_id },
      payment_intent_data: { metadata: { order_id: reserved.order_id } },
    });

    await fetch(SUPABASE_URL + '/rest/v1/store_orders?id=eq.' + reserved.order_id, {
      method: 'PATCH', headers, body: JSON.stringify({ stripe_session_id: session.id }),
    });
    return res.status(200).json({ clientSecret: session.client_secret, publishableKey: STRIPE_PUBLISHABLE_KEY, orderId: reserved.order_id });
  } catch (err) {
    await releaseOrder(reserved.order_id, headers);
    return res.status(err.status || 500).json({ error: err.message });
  }
}
