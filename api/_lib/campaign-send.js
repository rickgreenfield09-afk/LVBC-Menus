// api/_lib/campaign-send.js
// Shared by api/send-campaign.js (immediate, admin-triggered) and
// api/process-scheduled-campaigns.js (cron-triggered, no user session).
// Not a route itself — Vercel skips any api/ path with an "_"-prefixed
// segment.
//
// Callers pass their own `headers` for the Supabase REST calls, since
// one uses a forwarded user token (RLS-scoped) and the other uses the
// service role key (no session to forward).

export function unsubscribeFooter(subscriberId, baseUrl) {
  return '<hr style="margin-top:24px;border:none;border-top:1px solid #ddd;">'
    + '<p style="font-size:11px;color:#999;margin-top:8px;">You\'re receiving this because you subscribed to Lago Vista Brewing Company emails. '
    + '<a href="' + baseUrl + '/api/unsubscribe?id=' + subscriberId + '" style="color:#999;">Unsubscribe</a></p>';
}

// Hardcoded rather than derived from a request's Host header: the
// unsubscribe link specifically needs to live under the same root
// domain mail is sent from (app.axiomfwd.com) for deliverability —
// Resend's Insights flagged a mismatched link domain as a spam signal.
export const CAMPAIGN_BASE_URL = 'https://app.axiomfwd.com';
export const CAMPAIGN_FROM = 'Lago Vista Brewing Company <ricky.greenfield@axiomfwd.com>';

export async function resolveRecipients(supabaseUrl, headers, campaign) {
  if (campaign.topic_id) {
    const prefRes = await fetch(
      supabaseUrl + '/rest/v1/subscriber_topic_preferences?select=subscriber:subscriber_id(id,email,unsubscribed_at)&topic_id=eq.' + campaign.topic_id + '&subscribed=eq.true',
      { headers }
    );
    if (!prefRes.ok) throw new Error('Could not load this topic\'s subscribers');
    const prefRows = await prefRes.json();
    return (prefRows || []).map((r) => r.subscriber).filter((s) => s && !s.unsubscribed_at);
  }
  const subRes = await fetch(supabaseUrl + '/rest/v1/email_subscribers?select=id,email&unsubscribed_at=is.null', { headers });
  if (!subRes.ok) throw new Error('Could not load subscribers');
  return subRes.json();
}

// Sends the batch via Resend, then marks the campaign sent. Throws
// only if the Resend send itself fails (nothing went out, caller
// should not treat the campaign as sent). If the emails went out but
// the status update fails, that's a partial success — returns a
// warning instead of throwing, since the campaign really was sent.
export async function sendCampaignToRecipients(supabaseUrl, headers, resendApiKey, campaign, recipients) {
  const messages = recipients.map((r) => ({
    from: CAMPAIGN_FROM,
    to: [r.email],
    subject: campaign.subject,
    html: campaign.html_body + unsubscribeFooter(r.id, CAMPAIGN_BASE_URL),
    tags: [{ name: 'campaign_id', value: campaign.id }],
  }));

  for (let i = 0; i < messages.length; i += 100) {
    const chunk = messages.slice(i, i + 100);
    const batchRes = await fetch('https://api.resend.com/emails/batch', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + resendApiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(chunk),
    });
    if (!batchRes.ok) {
      const err = await batchRes.text();
      throw new Error('Resend error (sent ' + i + ' of ' + messages.length + ' before failing): ' + err);
    }
  }

  const updateRes = await fetch(supabaseUrl + '/rest/v1/email_campaigns?id=eq.' + campaign.id, {
    method: 'PATCH',
    headers: { ...headers, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify({ status: 'sent', sent_at: new Date().toISOString() }),
  });
  if (!updateRes.ok) return { sent: recipients.length, warning: 'Emails were sent, but the campaign status could not be updated — refresh to check.' };

  return { sent: recipients.length, warning: null };
}
