// membership.js (member app)
// Page: #tab-membership — buy a paid membership, or see and manage the
// one the member has.
//
// Plans come from membership_plans (public read; only plans that are
// active and have a Stripe price are visible). Payment is Stripe's
// Embedded Checkout, mounted right on this page: /api/membership-checkout
// creates the session, the card form is Stripe's, and card details never
// touch our code. Changing the card, switching plans or turning off
// auto-renew goes to Stripe's Customer Portal (/api/membership-portal).
//
// Paying doesn't change the tier by itself: Stripe calls
// api/stripe-webhook.js, which sets members.tier_id a moment later. So
// after Checkout completes this page re-reads the member until the tier
// shows up.
// Depends on: window.supabase, window.currentMember, refreshMember(),
// toast(), escHtml(), money(), fmtDate(), isPaidMember(), tierName() (core.js)

const STRIPE_JS_URL = 'https://js.stripe.com/v3/';
const ENTITLED = ['active', 'trialing', 'past_due'];
let membershipPlans = [];
let planInterval = 'year';
let embeddedCheckout = null;

function membershipEl() { return document.getElementById('membership-content'); }

async function apiPost(path, body) {
  const { data: { session } } = await window.supabase.auth.getSession();
  const r = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (session ? session.access_token : '') },
    body: JSON.stringify(body || {}),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || 'Something went wrong. Try again.');
  return data;
}

function loadStripeJs() {
  if (window.Stripe) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = STRIPE_JS_URL;
    s.onload = resolve;
    s.onerror = () => reject(new Error('Could not load the payment form. Check your connection.'));
    document.head.appendChild(s);
  });
}

async function loadMembership() {
  destroyCheckout();
  membershipEl().innerHTML = '<div class="empty">Loading...</div>';
  const m = window.currentMember;
  const [subs, plans] = await Promise.all([
    window.supabase.from('member_subscriptions').select('*, membership_plans(billing_interval, price_cents, tiers(name))')
      .eq('member_id', m.id).in('status', ENTITLED).order('current_period_end', { ascending: false }),
    window.supabase.from('membership_plans').select('*, tiers(name, rank)').order('sort_order'),
  ]);
  if (subs.error || plans.error) {
    membershipEl().innerHTML = '<div class="empty">Could not load memberships. Try again.</div>';
    return;
  }
  membershipPlans = plans.data;
  if (subs.data.length) renderCurrentMembership(subs.data[0]);
  else renderPlans();
}

// ── HAS A MEMBERSHIP ─────────────────────────────────────
function renderCurrentMembership(sub) {
  const plan = sub.membership_plans;
  const name = plan ? plan.tiers.name : tierName(window.currentMember);
  const cycle = plan ? (plan.billing_interval === 'year' ? 'per year' : 'per month') : '';
  const when = sub.current_period_end ? fmtDate(sub.current_period_end, { month: 'long', day: 'numeric', year: 'numeric' }) : '';
  const status = sub.status === 'past_due'
    ? '<div class="alert alert-error visible">Your last payment didn\'t go through. Update your card to keep your membership.</div>'
    : '';
  const renewal = sub.cancel_at_period_end
    ? 'Auto-renew is off. Your membership ends on <strong>' + escHtml(when) + '</strong>.'
    : 'Renews automatically on <strong>' + escHtml(when) + '</strong>.';

  membershipEl().innerHTML =
    '<div class="plan-card plan-current">' +
      '<div class="plan-name">' + escHtml(name) + '</div>' +
      (plan ? '<div class="plan-price">' + money(plan.price_cents / 100) + '<small> ' + cycle + '</small></div>' : '') +
      status +
      '<p class="plan-note">' + (when ? renewal : '') + '</p>' +
      '<button class="btn btn-primary" id="portal-btn" onclick="openPortal()">Manage Membership</button>' +
      '<p class="plan-note">Update your card, switch plans, view receipts, or turn auto-renew on or off.</p>' +
    '</div>';
}

async function openPortal() {
  const btn = document.getElementById('portal-btn');
  btn.disabled = true;
  btn.textContent = 'Opening...';
  try {
    const { url } = await apiPost('/api/membership-portal');
    window.location.href = url;
  } catch (err) {
    btn.disabled = false;
    btn.textContent = 'Manage Membership';
    toast(err.message, true);
  }
}

// ── CHOOSE A PLAN ────────────────────────────────────────
function renderPlans() {
  const intervals = [...new Set(membershipPlans.map((p) => p.billing_interval))];
  if (!intervals.length) {
    membershipEl().innerHTML = '<div class="empty">Paid memberships are coming soon.</div>';
    return;
  }
  if (!intervals.includes(planInterval)) planInterval = intervals[0];

  const toggle = intervals.length > 1
    ? '<div class="lb-toggle">' +
        ['year', 'month'].filter((i) => intervals.includes(i)).map((i) =>
          '<button class="lb-toggle-btn' + (i === planInterval ? ' active' : '') + '" onclick="setPlanInterval(\'' + i + '\')">' + (i === 'year' ? 'Annual' : 'Monthly') + '</button>').join('') +
      '</div>'
    : '';

  const cards = membershipPlans.filter((p) => p.billing_interval === planInterval).map((p) =>
    '<div class="plan-card">' +
      '<div class="plan-name">' + escHtml(p.tiers.name) + '</div>' +
      '<div class="plan-price">' + money(p.price_cents / 100) + '<small> per ' + (p.billing_interval === 'year' ? 'year' : 'month') + '</small></div>' +
      '<ul class="plan-perks">' + p.perks.map((perk) => '<li>' + escHtml(perk) + '</li>').join('') + '</ul>' +
      '<button class="btn btn-primary" onclick="startCheckout(\'' + p.id + '\')">Join ' + escHtml(p.tiers.name) + '</button>' +
      '<p class="plan-note">Renews automatically each ' + p.billing_interval + '. Cancel any time to stop future renewals; payments already made are non-refundable.</p>' +
    '</div>').join('');

  membershipEl().innerHTML = '<p class="plan-intro">You\'re on the free plan. Upgrade for member perks.</p>' + toggle + cards;
}

function setPlanInterval(interval) {
  planInterval = interval;
  renderPlans();
}

// ── CHECKOUT ─────────────────────────────────────────────
function destroyCheckout() {
  if (embeddedCheckout) { embeddedCheckout.destroy(); embeddedCheckout = null; }
}

async function startCheckout(planId) {
  membershipEl().innerHTML = '<div class="empty">Preparing checkout...</div>';
  try {
    await loadStripeJs();
    const { clientSecret, publishableKey } = await apiPost('/api/membership-checkout', { plan_id: planId });
    membershipEl().innerHTML =
      '<button class="btn-ghost" onclick="loadMembership()">&larr; Back to plans</button>' +
      '<div id="checkout-mount" class="checkout-mount"></div>';
    const stripe = window.Stripe(publishableKey);
    embeddedCheckout = await stripe.initEmbeddedCheckout({
      fetchClientSecret: async () => clientSecret,
      onComplete: waitForMembership,
    });
    embeddedCheckout.mount('#checkout-mount');
  } catch (err) {
    toast(err.message, true);
    loadMembership();
  }
}

// The payment is done; the webhook sets the tier a moment later.
async function waitForMembership() {
  destroyCheckout();
  membershipEl().innerHTML = '<div class="empty">Payment received. Setting up your membership...</div>';
  for (let i = 0; i < 20; i++) {
    await refreshMember(true);
    if (isPaidMember(window.currentMember)) {
      toast('Welcome to ' + tierName(window.currentMember) + '!');
      loadMembership();
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  membershipEl().innerHTML = '<div class="empty">Your payment went through. Your membership will show up here shortly. Check back in a minute.</div>';
}
