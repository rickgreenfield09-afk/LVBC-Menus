// scripts/stripe-sync-plans.mjs
// Creates a Stripe price for every membership_plans row that doesn't
// have one yet, and saves the price id on the row. Run it after adding
// or repricing a plan (a changed price needs a new Stripe price: clear
// the row's stripe_price_id first). Works against whichever Stripe
// account the key belongs to — sandbox with sk_test_..., live with
// sk_live_....
//
//   STRIPE_SECRET_KEY=sk_test_... SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
//     node scripts/stripe-sync-plans.mjs
import { stripeFetch } from '../api/_lib/stripe.js';

const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.');
  process.exit(1);
}
const headers = { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: 'Bearer ' + SUPABASE_SERVICE_ROLE_KEY, 'Content-Type': 'application/json' };

const res = await fetch(SUPABASE_URL + '/rest/v1/membership_plans?select=id,billing_interval,price_cents,tiers(name)&stripe_price_id=is.null', { headers });
const plans = await res.json();
if (!res.ok) { console.error(plans); process.exit(1); }
if (!plans.length) { console.log('Every plan already has a Stripe price.'); process.exit(0); }

for (const plan of plans) {
  const label = plan.tiers.name + ' (' + (plan.billing_interval === 'year' ? 'annual' : 'monthly') + ')';
  const price = await stripeFetch('POST', '/v1/prices', {
    currency: 'usd',
    unit_amount: plan.price_cents,
    recurring: { interval: plan.billing_interval },
    product_data: { name: 'LVBC ' + label },
    metadata: { plan_id: plan.id },
  });
  const save = await fetch(SUPABASE_URL + '/rest/v1/membership_plans?id=eq.' + plan.id, {
    method: 'PATCH', headers, body: JSON.stringify({ stripe_price_id: price.id }),
  });
  if (!save.ok) { console.error('Created ' + price.id + ' but could not save it:', await save.text()); process.exit(1); }
  console.log('✓ ' + label + ' -> ' + price.id);
}
