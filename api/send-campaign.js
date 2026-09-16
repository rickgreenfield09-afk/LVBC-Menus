// api/send-campaign.js
// Vercel serverless function (Node runtime, no dependencies).
// Sends a saved campaign to its audience RIGHT NOW (a specific
// topic's opted-in subscribers, or everyone if no topic is set) and
// marks it sent. Scheduling a campaign for later just writes
// status='scheduled'/scheduled_for from the client (see
// js/marketing.js's scheduleCampaignSend) — the actual future send
// is handled by api/process-scheduled-campaigns.js on a cron, which
// shares the send logic in api/_lib/campaign-send.js with this file.
//
// Auth: same caller-is-admin check as api/invite-staff.js, then reads
// with the caller's own forwarded token — RLS already lets any staff
// read subscribers/preferences/campaigns, so no service role key is
// needed here.
// Requires SUPABASE_URL, SUPABASE_ANON_KEY, RESEND_API_KEY.

import { resolveRecipients, sendCampaignToRecipients } from './_lib/campaign-send.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Missing auth token' });

  const { SUPABASE_URL, SUPABASE_ANON_KEY, RESEND_API_KEY } = process.env;
  if (!RESEND_API_KEY) return res.status(500).json({ error: 'Email is not configured yet (missing RESEND_API_KEY in Vercel env vars).' });
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return res.status(500).json({ error: 'Missing SUPABASE_URL/SUPABASE_ANON_KEY env vars.' });

  const { campaignId } = req.body || {};
  if (!campaignId) return res.status(400).json({ error: 'Missing campaignId' });

  const authHeaders = { apikey: SUPABASE_ANON_KEY, Authorization: 'Bearer ' + token };

  const callerRes = await fetch(SUPABASE_URL + '/auth/v1/user', { headers: authHeaders });
  const caller = await callerRes.json();
  if (!callerRes.ok || !caller || !caller.id) return res.status(401).json({ error: 'Could not verify session' });

  const callerProfileRes = await fetch(SUPABASE_URL + '/rest/v1/staff_profiles?select=role&id=eq.' + caller.id, { headers: authHeaders });
  const callerProfile = await callerProfileRes.json();
  if (!callerProfileRes.ok || !callerProfile || !callerProfile.length || callerProfile[0].role !== 'admin') {
    return res.status(403).json({ error: 'Only admins can send campaigns.' });
  }

  const campRes = await fetch(SUPABASE_URL + '/rest/v1/email_campaigns?id=eq.' + campaignId + '&select=*', { headers: authHeaders });
  const campRows = await campRes.json();
  if (!campRes.ok || !campRows || !campRows.length) return res.status(404).json({ error: 'Campaign not found' });
  const campaign = campRows[0];
  if (campaign.status === 'sent') return res.status(409).json({ error: 'This campaign has already been sent.' });

  let recipients;
  try {
    recipients = await resolveRecipients(SUPABASE_URL, authHeaders, campaign);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
  if (!recipients.length) return res.status(400).json({ error: 'No subscribers match this campaign\'s audience.' });

  try {
    const result = await sendCampaignToRecipients(SUPABASE_URL, authHeaders, RESEND_API_KEY, campaign, recipients);
    return res.status(200).json({ ok: true, sent: result.sent, warning: result.warning });
  } catch (e) {
    return res.status(502).json({ error: e.message });
  }
}
