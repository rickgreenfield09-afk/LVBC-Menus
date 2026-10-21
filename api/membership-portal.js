// api/membership-portal.js
// Vercel serverless function (Node runtime, no dependencies).
// Opens Stripe's Customer Portal for the signed-in member — where they
// update their card, see invoices, switch plans, or turn off auto-renew.
// Whatever they change there reaches us through api/stripe-webhook.js.
//
// POST -> { url }
//
// Requires STRIPE_SECRET_KEY (plus the Supabase env vars). The portal
// must be configured once in the Stripe dashboard (Settings > Billing >
// Customer portal) before this works.
import { stripeFetch, requestOrigin } from './_lib/stripe.js';
import { requireMember } from './_lib/member-auth.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const member = await requireMember(req, res);
  if (!member) return;
  if (!member.stripe_customer_id) return res.status(404).json({ error: 'You don\'t have a billing profile yet.' });

  try {
    const session = await stripeFetch('POST', '/v1/billing_portal/sessions', {
      customer: member.stripe_customer_id,
      return_url: requestOrigin(req) + '/member/',
    });
    return res.status(200).json({ url: session.url });
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message });
  }
}
