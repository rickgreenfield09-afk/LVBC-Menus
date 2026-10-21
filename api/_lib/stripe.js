// api/_lib/stripe.js
// Shared by the membership-* and stripe-webhook functions. Not a route
// itself — Vercel skips any api/ path with an "_"-prefixed segment.
// Raw fetch against the Stripe REST API, like the Supabase calls
// elsewhere in api/, so there is no SDK dependency.
//
// Requires STRIPE_SECRET_KEY as a Vercel env var (sk_test_... while on
// the Stripe sandbox, sk_live_... when it goes live).

// Pinned so response shapes (e.g. subscription.current_period_end) and
// Embedded Checkout's ui_mode don't change under us when Stripe ships a
// new default version. Move it on deliberately.
export const STRIPE_API_VERSION = '2024-06-20';

// Stripe takes form-encoded bodies with bracketed keys for nesting:
// { line_items: [{ price: 'p' }] } -> line_items[0][price]=p
function encode(value, prefix, out) {
  if (value === undefined || value === null) return;
  if (Array.isArray(value)) {
    value.forEach((v, i) => encode(v, prefix + '[' + i + ']', out));
  } else if (typeof value === 'object') {
    Object.keys(value).forEach((k) => encode(value[k], prefix ? prefix + '[' + k + ']' : k, out));
  } else {
    out.push(encodeURIComponent(prefix) + '=' + encodeURIComponent(String(value)));
  }
}

// Returns the parsed JSON. Throws an Error (with .status and .stripe)
// when Stripe answers with an error.
export async function stripeFetch(method, path, params) {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw Object.assign(new Error('Missing STRIPE_SECRET_KEY env var.'), { status: 500 });

  const body = [];
  encode(params, '', body);
  const isGet = method === 'GET';
  const r = await fetch('https://api.stripe.com' + path + (isGet && body.length ? '?' + body.join('&') : ''), {
    method,
    headers: {
      Authorization: 'Bearer ' + key,
      'Stripe-Version': STRIPE_API_VERSION,
      ...(isGet ? {} : { 'Content-Type': 'application/x-www-form-urlencoded' }),
    },
    body: isGet || !body.length ? undefined : body.join('&'),
  });
  const data = await r.json();
  if (!r.ok) {
    const err = new Error((data.error && data.error.message) || 'Stripe request failed');
    err.status = r.status;
    err.stripe = data.error;
    throw err;
  }
  return data;
}

// The URL the browser is on, for Stripe to send people back to.
export function requestOrigin(req) {
  if (req.headers.origin) return req.headers.origin;
  const proto = req.headers['x-forwarded-proto'] || 'https';
  return proto + '://' + req.headers.host;
}
