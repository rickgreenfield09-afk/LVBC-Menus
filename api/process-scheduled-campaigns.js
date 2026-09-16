// api/process-scheduled-campaigns.js
// Vercel serverless function (Node runtime, no dependencies).
// Sends every campaign whose status='scheduled' and scheduled_for has
// passed. Meant to be called on a schedule (see
// .github/workflows/process-scheduled-campaigns.yml) — Vercel's free
// plan only allows daily Cron Jobs, too coarse for a "send at 2pm"
// schedule, so a GitHub Actions cron hits this endpoint every few
// minutes instead.
//
// No user session calls this (it's an external cron), so it's guarded
// by a shared secret (CRON_SECRET) instead of a forwarded token, and
// uses the service role key like api/subscribe.js and
// api/resend-webhook.js do for the same reason.
// Requires SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, RESEND_API_KEY,
// CRON_SECRET as Vercel project environment variables.

import crypto from 'crypto';
import { resolveRecipients, sendCampaignToRecipients } from './_lib/campaign-send.js';

function isValidSecret(provided, expected) {
  if (!provided || !expected || provided.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
}

export default async function handler(req, res) {
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, RESEND_API_KEY, CRON_SECRET } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return res.status(500).json({ error: 'Missing SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY env vars.' });
  if (!RESEND_API_KEY) return res.status(500).json({ error: 'Missing RESEND_API_KEY env var.' });
  if (!CRON_SECRET) return res.status(500).json({ error: 'Missing CRON_SECRET env var.' });

  const provided = (req.headers['x-cron-secret'] || '');
  if (!isValidSecret(provided, CRON_SECRET)) return res.status(401).json({ error: 'Invalid or missing cron secret' });

  const headers = {
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: 'Bearer ' + SUPABASE_SERVICE_ROLE_KEY,
    'Content-Type': 'application/json',
  };

  const dueRes = await fetch(
    SUPABASE_URL + '/rest/v1/email_campaigns?select=*&status=eq.scheduled&scheduled_for=lte.' + encodeURIComponent(new Date().toISOString()),
    { headers }
  );
  if (!dueRes.ok) return res.status(500).json({ error: 'Could not load scheduled campaigns' });
  const dueCampaigns = await dueRes.json();

  const results = [];
  for (const campaign of dueCampaigns) {
    try {
      const recipients = await resolveRecipients(SUPABASE_URL, headers, campaign);
      if (!recipients.length) {
        results.push({ id: campaign.id, subject: campaign.subject, skipped: 'no matching subscribers' });
        continue;
      }
      const result = await sendCampaignToRecipients(SUPABASE_URL, headers, RESEND_API_KEY, campaign, recipients);
      results.push({ id: campaign.id, subject: campaign.subject, sent: result.sent, warning: result.warning });
    } catch (e) {
      // Left as status='scheduled' on failure (nothing here marks it
      // otherwise), so the next cron run just retries it.
      results.push({ id: campaign.id, subject: campaign.subject, error: e.message });
    }
  }

  return res.status(200).json({ ok: true, processed: results.length, results });
}
