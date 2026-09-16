// marketing.js
// Screen: #screen-marketing — admin-only email marketing overview,
// campaign list, audience/topics management, and connection status.
// Nav button hidden unless window.currentStaff.role === 'admin' (see
// app-core.js renderLoggedIn()). RLS additionally restricts writes on
// email_topics/email_campaigns to is_staff() (see migration_016) —
// tighten to an admin-only policy if non-admin staff ever get portal
// access without being trusted to edit marketing data.
// Depends on: window.supabase, toast(), escHtml() (js/menu.js)

let marketingTopics = [], marketingSubscribers = [];

function loadMarketing() {
  setMarketingTab('dashboard', document.getElementById('marketingtab-btn-dashboard'));
}

function setMarketingTab(tab, btn) {
  document.querySelectorAll('#screen-marketing > .sub-tabs .sub-tab').forEach((b) => b.classList.remove('active'));
  document.querySelectorAll('#screen-marketing > .sub-sec').forEach((s) => s.classList.remove('active'));
  if (btn) btn.classList.add('active');
  document.getElementById('marketingtab-' + tab).classList.add('active');
  if (tab === 'dashboard') loadMarketingDashboard();
  if (tab === 'campaigns') loadMarketingCampaigns();
  if (tab === 'audience') loadMarketingAudience();
  if (tab === 'settings') loadMarketingSettings();
}

function pct(numerator, denominator) {
  return denominator ? Math.round((numerator / denominator) * 100) + '%' : '—';
}

function campaignStatusBadge(status) {
  if (status === 'sent') return '<span class="badge badge-teal">Sent</span>';
  if (status === 'scheduled') return '<span class="badge badge-amber">Scheduled</span>';
  return '<span class="badge badge-muted">Draft</span>';
}

// ── DASHBOARD ────────────────────────────────────
async function loadMarketingDashboard() {
  const [{ data: subs }, { data: topics }, { data: campaigns }, { data: events }, { data: prefs }] = await Promise.all([
    window.supabase.from('email_subscribers').select('id,unsubscribed_at'),
    window.supabase.from('email_topics').select('id,name'),
    window.supabase.from('email_campaigns').select('*').order('created_at', { ascending: false }),
    window.supabase.from('email_events').select('event_type,campaign_id'),
    window.supabase.from('subscriber_topic_preferences').select('topic_id,subscribed'),
  ]);

  const activeSubs = (subs || []).filter((s) => !s.unsubscribed_at);
  document.getElementById('mkt-kpi-subscribers').textContent = activeSubs.length;
  document.getElementById('mkt-kpi-subscribers-sub').textContent = ((subs || []).length - activeSubs.length) + ' unsubscribed';
  document.getElementById('mkt-kpi-sent').textContent = (campaigns || []).filter((c) => c.status === 'sent').length;

  const delivered = (events || []).filter((e) => e.event_type === 'delivered').length;
  const opened = (events || []).filter((e) => e.event_type === 'opened').length;
  const clicked = (events || []).filter((e) => e.event_type === 'clicked').length;
  document.getElementById('mkt-kpi-open').textContent = pct(opened, delivered);
  document.getElementById('mkt-kpi-click').textContent = pct(clicked, delivered);

  const topicEl = document.getElementById('mkt-topic-breakdown');
  if (!(topics || []).length) {
    topicEl.innerHTML = '<div class="loading">No topics yet — add one under Audience.</div>';
  } else {
    topicEl.innerHTML = topics.map((t) => {
      const count = (prefs || []).filter((p) => p.topic_id === t.id && p.subscribed).length;
      return '<div class="card"><div class="card-title">' + escHtml(t.name) + '</div><div class="card-value">' + count + '</div><div class="card-sub">subscribed</div></div>';
    }).join('');
  }

  const recentEl = document.getElementById('mkt-recent-campaigns');
  if (!(campaigns || []).length) {
    recentEl.innerHTML = '<div class="loading">No campaigns yet — head to the Campaigns tab to create one.</div>';
    return;
  }
  const rows = campaigns.slice(0, 8).map((c) => {
    const campaignEvents = (events || []).filter((e) => e.campaign_id === c.id);
    const cDelivered = campaignEvents.filter((e) => e.event_type === 'delivered').length;
    const cOpened = campaignEvents.filter((e) => e.event_type === 'opened').length;
    const cClicked = campaignEvents.filter((e) => e.event_type === 'clicked').length;
    return '<tr><td style="font-weight:500">' + escHtml(c.subject) + '</td><td>' + campaignStatusBadge(c.status) + '</td>'
      + '<td style="font-size:12px;color:var(--sub)">' + (c.sent_at ? new Date(c.sent_at).toLocaleDateString() : '—') + '</td>'
      + '<td style="font-size:12px;color:var(--sub)">' + pct(cOpened, cDelivered) + '</td>'
      + '<td style="font-size:12px;color:var(--sub)">' + pct(cClicked, cDelivered) + '</td></tr>';
  }).join('');
  recentEl.innerHTML = '<div class="table-wrap"><table><thead><tr><th>Subject</th><th>Status</th><th>Sent</th><th>Opens</th><th>Clicks</th></tr></thead><tbody>' + rows + '</tbody></table></div>';
}

// ── CAMPAIGNS ────────────────────────────────────
async function loadMarketingCampaigns() {
  const el = document.getElementById('mkt-campaigns-list');
  el.innerHTML = '<div class="loading">Loading...</div>';
  const { data, error } = await window.supabase.from('email_campaigns').select('*').order('created_at', { ascending: false });
  if (error) { el.innerHTML = '<div class="loading">Error: ' + escHtml(error.message) + '</div>'; return; }
  if (!data.length) { el.innerHTML = '<div class="loading">No campaigns yet — click "New Campaign" to start one.</div>'; return; }
  const rows = data.map((c) => (
    '<tr><td style="font-weight:500">' + escHtml(c.subject) + '</td><td>' + campaignStatusBadge(c.status) + '</td>'
    + '<td style="font-size:12px;color:var(--sub)">' + new Date(c.created_at).toLocaleDateString() + '</td></tr>'
  )).join('');
  el.innerHTML = '<div class="table-wrap"><table><thead><tr><th>Subject</th><th>Status</th><th>Created</th></tr></thead><tbody>' + rows + '</tbody></table></div>';
}

function newCampaignStub() {
  toast('The campaign composer is coming in a future update.');
}

// ── AUDIENCE ─────────────────────────────────────
function loadMarketingAudience() {
  loadMarketingTopics();
  loadMarketingSubscribers();
}

async function loadMarketingTopics() {
  const el = document.getElementById('mkt-topics-list');
  el.innerHTML = '<div class="loading">Loading...</div>';
  const { data, error } = await window.supabase.from('email_topics').select('*').order('name');
  if (error) { el.innerHTML = '<div class="loading">Error: ' + escHtml(error.message) + '</div>'; return; }
  marketingTopics = data || [];
  if (!marketingTopics.length) { el.innerHTML = '<div class="loading">No topics yet.</div>'; return; }
  const rows = marketingTopics.map((t) => (
    '<tr><td style="font-weight:500">' + escHtml(t.name) + '</td>'
    + '<td style="font-size:12px;color:var(--sub)">' + escHtml(t.description || '') + '</td>'
    + '<td><button class="btn btn-sm btn-danger" onclick="removeMarketingTopic(\'' + t.id + '\',\'' + escHtml(t.name).replace(/'/g, "\\'") + '\')">Remove</button></td></tr>'
  )).join('');
  el.innerHTML = '<div class="table-wrap"><table><thead><tr><th>Name</th><th>Description</th><th></th></tr></thead><tbody>' + rows + '</tbody></table></div>';
}

async function addMarketingTopic() {
  const input = document.getElementById('mkt-new-topic-name');
  const name = input.value.trim();
  if (!name) { toast('Enter a topic name', true); return; }
  const { error } = await window.supabase.from('email_topics').insert({ name });
  if (error) { toast('Error: ' + error.message, true); return; }
  input.value = '';
  toast('Topic added');
  loadMarketingTopics();
}

async function removeMarketingTopic(id, name) {
  if (!confirm('Remove topic "' + name + '"? Subscribers currently opted into it will lose that preference.')) return;
  const { error } = await window.supabase.from('email_topics').delete().eq('id', id);
  if (error) { toast('Error: ' + error.message, true); return; }
  toast('Removed ' + name);
  loadMarketingTopics();
}

async function loadMarketingSubscribers() {
  const el = document.getElementById('mkt-subscribers-list');
  el.innerHTML = '<div class="loading">Loading...</div>';
  const { data, error } = await window.supabase.from('email_subscribers').select('*').order('subscribed_at', { ascending: false });
  if (error) { el.innerHTML = '<div class="loading">Error: ' + escHtml(error.message) + '</div>'; return; }
  marketingSubscribers = data || [];
  if (!marketingSubscribers.length) { el.innerHTML = '<div class="loading">No subscribers yet.</div>'; return; }
  const rows = marketingSubscribers.map((s) => (
    '<tr><td style="font-weight:500">' + escHtml(s.name || '') + '</td>'
    + '<td style="font-size:12px;color:var(--sub)">' + escHtml(s.email) + '</td>'
    + '<td>' + (s.unsubscribed_at ? '<span class="badge badge-muted">Unsubscribed</span>' : '<span class="badge badge-teal">Subscribed</span>') + '</td>'
    + '<td style="font-size:12px;color:var(--sub)">' + new Date(s.subscribed_at).toLocaleDateString() + '</td></tr>'
  )).join('');
  el.innerHTML = '<div class="table-wrap"><table><thead><tr><th>Name</th><th>Email</th><th>Status</th><th>Joined</th></tr></thead><tbody>' + rows + '</tbody></table></div>';
}

// ── SETTINGS ─────────────────────────────────────
async function loadMarketingSettings() {
  const el = document.getElementById('mkt-settings-status');
  el.innerHTML = '<div class="loading">Checking...</div>';
  const { data: { session } } = await window.supabase.auth.getSession();
  if (!session) { el.innerHTML = '<div class="loading">Session expired — please sign in again.</div>'; return; }
  try {
    const res = await fetch('/api/marketing-status', { headers: { Authorization: 'Bearer ' + session.access_token } });
    const data = await res.json();
    if (!res.ok) { el.innerHTML = '<div class="loading">Error: ' + escHtml(data.error || 'Could not check status') + '</div>'; return; }
    const row = (label, ok) => (
      '<div class="badge-admin-row"><span class="badge-color-dot" style="background:' + (ok ? 'var(--teal)' : 'var(--red)') + '"></span>' + escHtml(label)
      + '<span class="badge ' + (ok ? 'badge-teal' : 'badge-red') + '" style="margin-left:auto;">' + (ok ? 'Configured' : 'Missing') + '</span></div>'
    );
    el.innerHTML = row('Resend API Key', data.resendConfigured) + row('Webhook Signing Secret', data.webhookConfigured);
  } catch (e) {
    el.innerHTML = '<div class="loading">Network error checking status.</div>';
  }
}
