// api/membership-checkout.js
// Vercel serverless function (Node runtime, no dependencies).
// Starts a Stripe Embedded Checkout session for one membership plan and
// hands the member app the client secret it mounts the payment form
// with. The member app sends its Supabase access token; the plan, price
// and customer are all decided here, never trusted from the browser.
//
// POST { plan_id } -> { clientSecret, publishableKey }
//
// Requires STRIPE_SECRET_KEY and STRIPE_PUBLISHABLE_KEY (plus the
// Supabase env vars) as Vercel env vars. Becoming a member is finished
// by api/stripe-webhook.js, not here.
import { stripeFetch } from './_lib/stripe.js';
import { requireMember } from './_lib/member-auth.js';
import { serviceHeaders } from './_lib/staff-auth.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!process.env.STRIPE_PUBLISHABLE_KEY) return res.status(500).json({ error: 'Missing STRIPE_PUBLISHABLE_KEY env var.' });

  const member = await requireMember(req, res);
  if (!member) return;

  const planId = req.body && req.body.plan_id;
  if (!planId) return res.status(400).json({ error: 'Choose a plan.' });

  const { SUPABASE_URL } = process.env;
  const headers = serviceHeaders();

  try {
    const planRes = await fetch(
      SUPABASE_URL + '/rest/v1/membership_plans?select=id,stripe_price_id&is_active=eq.true&id=eq.' + encodeURIComponent(planId),
      { headers }
    );
    const plans = await planRes.json();
    if (!planRes.ok || !plans.length || !plans[0].stripe_price_id) return res.status(404).json({ error: 'That plan isn\'t available.' });
    const plan = plans[0];

    // One membership at a time — changing or ending it is the portal's job.
    const subRes = await fetch(
      SUPABASE_URL + '/rest/v1/member_subscriptions?select=id&status=in.(active,trialing,past_due)&member_id=eq.' + member.id,
      { headers }
    );
    const subs = await subRes.json();
    if (subRes.ok && subs.length) return res.status(409).json({ error: 'You already have a membership. Use Manage Membership to change it.' });

    let customerId = member.stripe_customer_id;
    if (!customerId) {
      const customer = await stripeFetch('POST', '/v1/customers', {
        email: member.email,
        name: member.name,
        metadata: { member_id: member.id },
      });
      customerId = customer.id;
      const saveRes = await fetch(SUPABASE_URL + '/rest/v1/members?id=eq.' + member.id, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ stripe_customer_id: customerId }),
      });
      if (!saveRes.ok) return res.status(500).json({ error: 'Could not save your billing profile.' });
    }

    // The member id rides on the subscription so the webhook can find
    // them again; redirect_on_completion 'never' keeps the member inside
    // the app, which learns of success from Checkout's onComplete.
    const session = await stripeFetch('POST', '/v1/checkout/sessions', {
      mode: 'subscription',
      ui_mode: 'embedded',
      redirect_on_completion: 'never',
      customer: customerId,
      client_reference_id: member.id,
      line_items: [{ price: plan.stripe_price_id, quantity: 1 }],
      subscription_data: { metadata: { member_id: member.id } },
      metadata: { member_id: member.id },
    });

    return res.status(200).json({ clientSecret: session.client_secret, publishableKey: process.env.STRIPE_PUBLISHABLE_KEY });
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message });
  }
}
