// api/unsubscribe.js
// Vercel serverless function (Node runtime, no dependencies).
// Public GET endpoint linked from every campaign email's footer —
// no login involved, so (like api/subscribe.js) this uses the
// service role key rather than a forwarded user token.
// Requires SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY as Vercel env vars.

function page(res, message) {
  res.setHeader('Content-Type', 'text/html');
  return res.status(200).send(
    '<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Unsubscribed</title>'
    + '<style>body{font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Arial,sans-serif;max-width:480px;margin:80px auto;text-align:center;color:#222;padding:0 20px;}</style>'
    + '</head><body><h2>' + message + '</h2></body></html>'
  );
}

export default async function handler(req, res) {
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
  const id = req.query.id;

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return page(res, 'Something went wrong. Please contact the brewery directly.');
  if (!id) return page(res, 'Invalid unsubscribe link.');

  await fetch(
    SUPABASE_URL + '/rest/v1/email_subscribers?id=eq.' + encodeURIComponent(id) + '&unsubscribed_at=is.null',
    {
      method: 'PATCH',
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: 'Bearer ' + SUPABASE_SERVICE_ROLE_KEY,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify({ unsubscribed_at: new Date().toISOString() }),
    }
  );

  // Idempotent on purpose — an already-unsubscribed id (or an invalid
  // one someone is poking at) still gets this same reassuring message
  // rather than an error a real subscriber could hit on a second click.
  return page(res, "You've been unsubscribed. You will no longer receive marketing emails from us.");
}
