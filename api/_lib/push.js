// api/_lib/push.js
// Shared by api/send-push.js. Not a route itself — Vercel skips any
// api/ path with an "_"-prefixed segment.
//
// Requires VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY (generate once with
// `npx web-push generate-vapid-keys`) and optionally VAPID_SUBJECT
// (a mailto: or https: contact).

import webpush from 'web-push';

export function pushConfigured() {
  return !!(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
}

// Sends one payload to each subscription row. Returns { sent, failed,
// gone } where gone lists the ids of subscriptions the push service says
// no longer exist (404/410) so the caller can delete them.
export async function sendToSubscriptions(subs, payload) {
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT || 'mailto:info@lvbrewingco.com',
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );
  const body = JSON.stringify(payload);
  let sent = 0, failed = 0;
  const gone = [];
  await Promise.all(subs.map(async (s) => {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, body, { TTL: 86400 });
      sent++;
    } catch (e) {
      failed++;
      if (e.statusCode === 404 || e.statusCode === 410) gone.push(s.id);
    }
  }));
  return { sent, failed, gone };
}
