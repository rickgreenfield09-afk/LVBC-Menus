// marketing.js
// Screen: #screen-marketing — admin-only email marketing overview,
// campaign list, audience/topics management, and connection status.
// Nav button hidden unless window.currentStaff.role === 'admin' (see
// app-core.js renderLoggedIn()). RLS additionally restricts writes on
// email_topics/email_campaigns to is_staff() (see migration_016) —
// tighten to an admin-only policy if non-admin staff ever get portal
// access without being trusted to edit marketing data.
// Depends on: window.supabase, toast(), escHtml() (js/menu.js)

let marketingTopics = [], marketingSubscribers = [], marketingStaffNames = {};
let campaignList = [], campaignEditId = null, campaignQuill = null;
let topicModalId = null;
let directAddTopicIds = new Set();

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
    return '<tr style="cursor:pointer;" onclick="openCampaignDetailModal(\'' + c.id + '\')"><td style="font-weight:500">' + escHtml(c.subject) + '</td><td>' + campaignStatusBadge(c.status) + '</td>'
      + '<td style="font-size:12px;color:var(--sub)">' + (c.sent_at ? new Date(c.sent_at).toLocaleDateString() : '—') + '</td>'
      + '<td style="font-size:12px;color:var(--sub)">' + pct(cOpened, cDelivered) + '</td>'
      + '<td style="font-size:12px;color:var(--sub)">' + pct(cClicked, cDelivered) + '</td></tr>';
  }).join('');
  recentEl.innerHTML = '<div class="table-wrap"><table><thead><tr><th>Subject</th><th>Status</th><th>Sent</th><th>Opens</th><th>Clicks</th></tr></thead><tbody>' + rows + '</tbody></table></div>';
}

// ── CAMPAIGNS ────────────────────────────────────
// Quill's default image button embeds the file as a base64 data: URI
// inline in the HTML — most email clients (Gmail included) strip or
// block data: images entirely, and it bloats the HTML besides. This
// uploads to the same Supabase 'assets' bucket beer/wine photos use
// (js/menu.js's uploadBeerImage) and inserts a real hosted URL.
async function quillImageHandler() {
  const input = document.createElement('input');
  input.setAttribute('type', 'file');
  input.setAttribute('accept', 'image/*');
  input.click();
  input.onchange = async () => {
    const file = input.files[0];
    if (!file) return;
    const range = campaignQuill.getSelection(true) || { index: campaignQuill.getLength() };
    campaignQuill.insertText(range.index, 'Uploading image…');
    try {
      const ext = (file.name.split('.').pop() || 'jpg').toLowerCase();
      const path = 'campaigns/' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.' + ext;
      const { error } = await window.supabase.storage.from('assets').upload(path, file);
      if (error) throw error;
      const url = window.supabase.storage.from('assets').getPublicUrl(path).data.publicUrl;
      campaignQuill.deleteText(range.index, 'Uploading image…'.length);
      campaignQuill.insertEmbed(range.index, 'image', url, 'user');
      campaignQuill.setSelection(range.index + 1);
    } catch (e) {
      campaignQuill.deleteText(range.index, 'Uploading image…'.length);
      toast('Image upload failed: ' + e.message, true);
    }
  };
}

function initCampaignEditorIfNeeded() {
  if (campaignQuill) return;
  campaignQuill = new Quill('#mkt-camp-editor', {
    theme: 'snow',
    modules: {
      // Kept deliberately narrow to email-safe formatting — a
      // freeform WYSIWYG editor can produce CSS/layout that Outlook
      // and other email clients render inconsistently.
      toolbar: {
        container: [
          [{ header: [2, 3, false] }],
          ['bold', 'italic', 'underline'],
          ['link', 'image'],
          [{ list: 'ordered' }, { list: 'bullet' }],
          ['clean'],
        ],
        handlers: { image: quillImageHandler },
      },
    },
  });
}

async function populateCampaignTopicSelect() {
  const { data, error } = await window.supabase.from('email_topics').select('*').order('name');
  if (!error) marketingTopics = data || [];
  const sel = document.getElementById('mkt-camp-topic');
  const prev = sel.value;
  sel.innerHTML = '<option value="">All Subscribers</option>' + marketingTopics.map((t) => '<option value="' + t.id + '">' + escHtml(t.name) + '</option>').join('');
  if (marketingTopics.some((t) => t.id === prev)) sel.value = prev;
}

async function loadMarketingCampaigns() {
  initCampaignEditorIfNeeded();
  await populateCampaignTopicSelect();

  const el = document.getElementById('mkt-campaigns-list');
  el.innerHTML = '<div class="loading">Loading...</div>';
  const { data, error } = await window.supabase.from('email_campaigns').select('*').order('created_at', { ascending: false });
  if (error) { el.innerHTML = '<div class="loading">Error: ' + escHtml(error.message) + '</div>'; return; }
  campaignList = data || [];
  if (!campaignList.length) { el.innerHTML = '<div class="loading">No campaigns yet.</div>'; return; }
  const rows = campaignList.map((c) => {
    const editable = c.status === 'draft';
    const runs = c.starts_at ? (c.starts_at + (c.ends_at ? ' – ' + c.ends_at : '')) : '—';
    const onClick = editable ? 'loadCampaignIntoEditor(\'' + c.id + '\')' : 'openCampaignDetailModal(\'' + c.id + '\')';
    return '<tr style="cursor:pointer;" onclick="' + onClick + '">'
      + '<td style="font-weight:500">' + escHtml(c.subject) + '</td><td>' + campaignStatusBadge(c.status) + '</td>'
      + '<td style="font-size:12px;color:var(--sub)">' + runs + '</td>'
      + '<td style="font-size:12px;color:var(--sub)">' + new Date(c.created_at).toLocaleDateString() + '</td></tr>';
  }).join('');
  el.innerHTML = '<div class="table-wrap"><table><thead><tr><th>Subject</th><th>Status</th><th>Runs</th><th>Created</th></tr></thead><tbody>' + rows + '</tbody></table></div>'
    + '<div style="font-size:11px;color:var(--muted);margin-top:8px;">Click a draft to edit it, or a sent/scheduled campaign to view its details.</div>';
}

function loadCampaignIntoEditor(id) {
  const c = campaignList.find((x) => x.id === id);
  if (!c || c.status !== 'draft') return;
  campaignEditId = c.id;
  document.getElementById('mkt-composer-label').textContent = 'Edit Draft';
  document.getElementById('mkt-composer-cancel').style.visibility = 'visible';
  document.getElementById('mkt-camp-subject').value = c.subject || '';
  document.getElementById('mkt-camp-topic').value = c.topic_id || '';
  document.getElementById('mkt-camp-starts').value = c.starts_at || '';
  document.getElementById('mkt-camp-ends').value = c.ends_at || '';
  campaignQuill.setContents([]);
  campaignQuill.clipboard.dangerouslyPasteHTML(c.html_body || '');
  clearCampaignAlert();
}

function cancelCampaignEdit() {
  campaignEditId = null;
  document.getElementById('mkt-composer-label').textContent = 'New Campaign';
  document.getElementById('mkt-composer-cancel').style.visibility = 'hidden';
  document.getElementById('mkt-camp-subject').value = '';
  document.getElementById('mkt-camp-topic').value = '';
  document.getElementById('mkt-camp-starts').value = '';
  document.getElementById('mkt-camp-ends').value = '';
  if (campaignQuill) campaignQuill.setContents([]);
  clearCampaignAlert();
}

function clearCampaignAlert() {
  const el = document.getElementById('mkt-composer-alert');
  el.style.display = 'none';
  el.textContent = '';
}

function campaignAlert(msg, isError) {
  const el = document.getElementById('mkt-composer-alert');
  el.style.display = 'block';
  el.style.background = isError ? 'rgba(220,53,69,0.1)' : 'rgba(42,184,166,0.1)';
  el.style.color = isError ? 'var(--red)' : 'var(--teal)';
  el.textContent = msg;
}

// Returns true on success (including "nothing to save yet" being
// impossible since validation failed) so sendCampaignNow() can save
// first and bail out cleanly if validation fails.
async function saveCampaignDraft(silent) {
  const subject = document.getElementById('mkt-camp-subject').value.trim();
  const topicId = document.getElementById('mkt-camp-topic').value || null;
  const startsAt = document.getElementById('mkt-camp-starts').value || null;
  const endsAt = document.getElementById('mkt-camp-ends').value || null;
  const html = campaignQuill.root.innerHTML;
  clearCampaignAlert();

  if (!subject) { campaignAlert('Subject is required.', true); return false; }
  if (!campaignQuill.getText().trim()) { campaignAlert('Message body is empty.', true); return false; }
  if (startsAt && endsAt && endsAt < startsAt) { campaignAlert('Campaign end date is before the start date.', true); return false; }

  const payload = { subject, topic_id: topicId, html_body: html, starts_at: startsAt, ends_at: endsAt };

  if (campaignEditId) {
    const { error } = await window.supabase.from('email_campaigns').update(payload).eq('id', campaignEditId);
    if (error) { campaignAlert(error.message, true); return false; }
    if (!silent) toast('Draft updated');
  } else {
    const { data: { session } } = await window.supabase.auth.getSession();
    const { data, error } = await window.supabase.from('email_campaigns')
      .insert({ ...payload, status: 'draft', created_by: session ? session.user.id : null }).select().single();
    if (error) { campaignAlert(error.message, true); return false; }
    campaignEditId = data.id;
    document.getElementById('mkt-composer-label').textContent = 'Edit Draft';
    document.getElementById('mkt-composer-cancel').style.visibility = 'visible';
    if (!silent) toast('Draft saved');
  }
  loadMarketingCampaigns();
  return true;
}

async function sendCampaignTest() {
  const subject = document.getElementById('mkt-camp-subject').value.trim();
  const html = campaignQuill.root.innerHTML;
  clearCampaignAlert();
  if (!subject) { campaignAlert('Subject is required.', true); return; }
  if (!campaignQuill.getText().trim()) { campaignAlert('Message body is empty.', true); return; }

  const { data: { session } } = await window.supabase.auth.getSession();
  if (!session) { campaignAlert('Your session expired — please sign in again.', true); return; }

  try {
    const res = await fetch('/api/send-campaign-test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + session.access_token },
      body: JSON.stringify({ subject, html }),
    });
    const data = await res.json();
    if (!res.ok) { campaignAlert(data.error || 'Could not send test.', true); return; }
    campaignAlert('Test sent to ' + data.sentTo);
  } catch (e) {
    campaignAlert('Network error sending test.', true);
  }
}

async function sendCampaignNow() {
  clearCampaignAlert();
  const saved = await saveCampaignDraft(true);
  if (!saved) return;

  const topicSel = document.getElementById('mkt-camp-topic');
  const audienceLabel = topicSel.value ? topicSel.options[topicSel.selectedIndex].text : 'All Subscribers';
  if (!confirm('Send this campaign now to: ' + audienceLabel + '? This cannot be undone.')) return;

  const { data: { session } } = await window.supabase.auth.getSession();
  if (!session) { campaignAlert('Your session expired — please sign in again.', true); return; }

  try {
    const res = await fetch('/api/send-campaign', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + session.access_token },
      body: JSON.stringify({ campaignId: campaignEditId }),
    });
    const data = await res.json();
    if (!res.ok) { campaignAlert(data.error || 'Could not send campaign.', true); return; }
    toast('Sent to ' + data.sent + ' subscriber(s)' + (data.warning ? ' — ' + data.warning : ''));
    cancelCampaignEdit();
    loadMarketingCampaigns();
    loadMarketingDashboard();
  } catch (e) {
    campaignAlert('Network error sending campaign.', true);
  }
}

// ── CAMPAIGN DETAIL MODAL ─────────────────────────
function closeCampaignDetailModal() {
  document.getElementById('campaign-detail-modal').style.display = 'none';
}

async function openCampaignDetailModal(id) {
  document.getElementById('campaign-detail-modal').style.display = 'flex';
  document.getElementById('campaign-detail-title').textContent = 'Loading…';
  document.getElementById('campaign-detail-info').innerHTML = '<div class="loading">Loading...</div>';
  document.getElementById('campaign-detail-stats').innerHTML = '';
  document.getElementById('campaign-detail-preview').srcdoc = '';

  const [{ data: c, error }, { data: eventsData }] = await Promise.all([
    window.supabase.from('email_campaigns').select('*').eq('id', id).single(),
    window.supabase.from('email_events').select('event_type').eq('campaign_id', id),
  ]);
  if (error || !c) {
    document.getElementById('campaign-detail-info').innerHTML = '<div class="loading">Could not load campaign.</div>';
    return;
  }

  let topicName = 'All Subscribers';
  if (c.topic_id) {
    const t = marketingTopics.find((x) => x.id === c.topic_id);
    if (t) topicName = t.name;
    else {
      const { data: topicRow } = await window.supabase.from('email_topics').select('name').eq('id', c.topic_id).single();
      if (topicRow) topicName = topicRow.name;
    }
  }

  let creatorName = marketingStaffNames[c.created_by];
  if (!creatorName && c.created_by) {
    const { data: staffRow } = await window.supabase.from('staff_profiles').select('name').eq('id', c.created_by).single();
    creatorName = staffRow ? staffRow.name : null;
  }

  document.getElementById('campaign-detail-title').textContent = c.subject;

  const infoRow = (label, value) => '<div style="margin-bottom:12px;"><div class="form-label">' + escHtml(label) + '</div><div style="font-weight:500;">' + value + '</div></div>';
  document.getElementById('campaign-detail-info').innerHTML =
    infoRow('Status', campaignStatusBadge(c.status))
    + infoRow('Audience', escHtml(topicName))
    + infoRow('Campaign Runs', c.starts_at ? escHtml(c.starts_at + (c.ends_at ? ' – ' + c.ends_at : '')) : '—')
    + infoRow('Created By', escHtml(creatorName || '—'))
    + infoRow('Created', new Date(c.created_at).toLocaleString())
    + infoRow('Sent', c.sent_at ? new Date(c.sent_at).toLocaleString() : '—');

  const events = eventsData || [];
  const countOf = (type) => events.filter((e) => e.event_type === type).length;
  const delivered = countOf('delivered'), opened = countOf('opened'), clicked = countOf('clicked'), bounced = countOf('bounced'), complained = countOf('complained');
  const statBox = (label, val, sub) => '<div class="stat-box" style="margin-bottom:8px;"><div class="stat-label">' + escHtml(label) + '</div><div class="stat-val">' + val + '</div>' + (sub ? '<div class="card-sub">' + sub + '</div>' : '') + '</div>';
  document.getElementById('campaign-detail-stats').innerHTML =
    statBox('Delivered', delivered)
    + statBox('Opened', opened, pct(opened, delivered) + ' of delivered')
    + statBox('Clicked', clicked, pct(clicked, delivered) + ' of delivered')
    + statBox('Bounced', bounced)
    + statBox('Complained', complained);

  document.getElementById('campaign-detail-preview').srcdoc = c.html_body || '<p style="font-family:sans-serif;color:#999;">No content.</p>';
}

// ── AUDIENCE ─────────────────────────────────────
async function loadMarketingAudience() {
  await loadMarketingStaffNames();
  loadMarketingTopics();
  loadMarketingSubscribers();
}

async function loadMarketingStaffNames() {
  const { data } = await window.supabase.from('staff_profiles').select('id,name');
  marketingStaffNames = {};
  (data || []).forEach((s) => { marketingStaffNames[s.id] = s.name; });
}

async function loadMarketingTopics() {
  const el = document.getElementById('mkt-topics-list');
  el.innerHTML = '<div class="loading">Loading...</div>';
  const { data, error } = await window.supabase.from('email_topics').select('*').order('name');
  if (error) { el.innerHTML = '<div class="loading">Error: ' + escHtml(error.message) + '</div>'; return; }
  marketingTopics = data || [];
  if (!marketingTopics.length) { el.innerHTML = '<div class="loading">No topics yet.</div>'; return; }
  const rows = marketingTopics.map((t) => (
    '<tr style="cursor:pointer;" onclick="openTopicSubscribersModal(\'' + t.id + '\')">'
    + '<td style="font-weight:500">' + escHtml(t.name) + '</td>'
    + '<td style="font-size:12px;color:var(--sub)">' + escHtml(t.description || '') + '</td>'
    + '<td style="font-size:12px;color:var(--sub)">' + escHtml(marketingStaffNames[t.created_by] || '—') + '</td>'
    + '<td><button class="btn btn-sm btn-danger" onclick="event.stopPropagation();removeMarketingTopic(\'' + t.id + '\',\'' + escHtml(t.name).replace(/'/g, "\\'") + '\')">Remove</button></td></tr>'
  )).join('');
  el.innerHTML = '<div class="table-wrap"><table><thead><tr><th>Name</th><th>Description</th><th>Added By</th><th></th></tr></thead><tbody>' + rows + '</tbody></table></div>'
    + '<div style="font-size:11px;color:var(--muted);margin-top:8px;">Click a topic to view or add subscribers.</div>';
  renderDirectAddTopicPicker();
}

function renderDirectAddTopicPicker() {
  const el = document.getElementById('mkt-sub-topic-picker');
  if (!el) return;
  if (!marketingTopics.length) { el.innerHTML = '<span style="font-size:12px;color:var(--muted);">No topics yet</span>'; return; }
  el.innerHTML = marketingTopics.map((t) => (
    '<div class="badge-pill' + (directAddTopicIds.has(t.id) ? ' selected' : '') + '" onclick="toggleDirectAddTopic(\'' + t.id + '\')">' + escHtml(t.name) + '</div>'
  )).join('');
}

function toggleDirectAddTopic(id) {
  if (directAddTopicIds.has(id)) directAddTopicIds.delete(id); else directAddTopicIds.add(id);
  renderDirectAddTopicPicker();
}

async function addMarketingTopic() {
  const input = document.getElementById('mkt-new-topic-name');
  const name = input.value.trim();
  if (!name) { toast('Enter a topic name', true); return; }
  const { data: { session } } = await window.supabase.auth.getSession();
  const { error } = await window.supabase.from('email_topics').insert({ name, created_by: session ? session.user.id : null });
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

// ── TOPIC SUBSCRIBERS MODAL (view + manually add) ─────────
function topicModalAlert(msg, isError) {
  const el = document.getElementById('topic-modal-alert');
  el.style.display = 'block';
  el.style.background = isError ? 'rgba(220,53,69,0.1)' : 'rgba(42,184,166,0.1)';
  el.style.color = isError ? 'var(--red)' : 'var(--teal)';
  el.textContent = msg;
}

function openTopicSubscribersModal(topicId) {
  const t = marketingTopics.find((x) => x.id === topicId);
  if (!t) return;
  topicModalId = topicId;
  document.getElementById('topic-modal-title').textContent = t.name;
  document.getElementById('topic-modal-emails').value = '';
  document.getElementById('topic-modal-alert').style.display = 'none';
  document.getElementById('topic-subscribers-modal').style.display = 'flex';
  loadTopicModalSubscribers();
}

function closeTopicSubscribersModal() {
  document.getElementById('topic-subscribers-modal').style.display = 'none';
  topicModalId = null;
}

async function loadTopicModalSubscribers() {
  const el = document.getElementById('topic-modal-subscribers-list');
  el.innerHTML = '<div class="loading">Loading...</div>';
  const { data, error } = await window.supabase
    .from('subscriber_topic_preferences')
    .select('subscriber:subscriber_id(id,email,name,unsubscribed_at)')
    .eq('topic_id', topicModalId)
    .eq('subscribed', true);
  if (error) { el.innerHTML = '<div class="loading">Error: ' + escHtml(error.message) + '</div>'; return; }
  const list = (data || []).filter((r) => r.subscriber);
  document.getElementById('topic-modal-count').textContent = list.length;
  if (!list.length) { el.innerHTML = '<div class="loading">No subscribers yet.</div>'; return; }
  el.innerHTML = '<div class="table-wrap"><table><tbody>' + list.map((r) => (
    '<tr><td style="font-weight:500">' + escHtml(r.subscriber.name || '') + '</td>'
    + '<td style="font-size:12px;color:var(--sub)">' + escHtml(r.subscriber.email) + '</td>'
    + '<td>' + (r.subscriber.unsubscribed_at ? '<span class="badge badge-muted">Unsubscribed</span>' : '') + '</td></tr>'
  )).join('') + '</tbody></table></div>';
}

// Splits pasted text one entry per line: "email" or "email, Name".
function parseBulkEmailLines(text) {
  return text.split('\n').map((line) => line.trim()).filter(Boolean).map((line) => {
    const commaIdx = line.indexOf(',');
    if (commaIdx === -1) return { email: line, name: null };
    return { email: line.slice(0, commaIdx).trim(), name: line.slice(commaIdx + 1).trim() || null };
  });
}

async function addSubscribersToTopic() {
  const raw = document.getElementById('topic-modal-emails').value;
  const entries = parseBulkEmailLines(raw);
  document.getElementById('topic-modal-alert').style.display = 'none';

  if (!entries.length) { topicModalAlert('Enter at least one email.', true); return; }
  const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const invalid = entries.find((e) => !emailRe.test(e.email));
  if (invalid) { topicModalAlert('Invalid email: ' + invalid.email, true); return; }

  const emails = entries.map((e) => e.email.toLowerCase());

  // Insert only genuinely new subscribers (ON CONFLICT DO NOTHING) —
  // re-adding an existing subscriber here must never overwrite their
  // stored name, and must never silently clear an unsubscribed_at
  // they set themselves.
  const newRows = entries.map((e) => ({ email: e.email.toLowerCase(), name: e.name, source: 'manual' }));
  const { error: insErr } = await window.supabase.from('email_subscribers').upsert(newRows, { onConflict: 'email', ignoreDuplicates: true });
  if (insErr) { topicModalAlert(insErr.message, true); return; }

  const { data: subRows, error: fetchErr } = await window.supabase.from('email_subscribers').select('id,email').in('email', emails);
  if (fetchErr) { topicModalAlert(fetchErr.message, true); return; }

  const prefRows = subRows.map((s) => ({ subscriber_id: s.id, topic_id: topicModalId, subscribed: true }));
  const { error: prefErr } = await window.supabase.from('subscriber_topic_preferences').upsert(prefRows, { onConflict: 'subscriber_id,topic_id' });
  if (prefErr) { topicModalAlert(prefErr.message, true); return; }

  topicModalAlert('Added ' + subRows.length + ' subscriber(s) to this audience.');
  document.getElementById('topic-modal-emails').value = '';
  loadTopicModalSubscribers();
  loadMarketingSubscribers();
}

async function loadMarketingSubscribers() {
  const el = document.getElementById('mkt-subscribers-list');
  el.innerHTML = '<div class="loading">Loading...</div>';
  const { data, error } = await window.supabase.from('email_subscribers').select('*').order('subscribed_at', { ascending: false });
  if (error) { el.innerHTML = '<div class="loading">Error: ' + escHtml(error.message) + '</div>'; return; }
  marketingSubscribers = data || [];
  if (!marketingSubscribers.length) { el.innerHTML = '<div class="loading">No subscribers yet.</div>'; return; }
  const rows = marketingSubscribers.map((s) => {
    const nameForJs = escHtml(s.name || s.email).replace(/'/g, "\\'");
    const actionBtn = s.unsubscribed_at
      ? '<button class="btn btn-sm btn-secondary" onclick="resubscribeSubscriber(\'' + s.id + '\',\'' + nameForJs + '\')">Resubscribe</button>'
      : '';
    return '<tr><td style="font-weight:500">' + escHtml(s.name || '') + '</td>'
      + '<td style="font-size:12px;color:var(--sub)">' + escHtml(s.email) + '</td>'
      + '<td>' + (s.unsubscribed_at ? '<span class="badge badge-muted">Unsubscribed</span>' : '<span class="badge badge-teal">Subscribed</span>') + '</td>'
      + '<td style="font-size:12px;color:var(--sub)">' + new Date(s.subscribed_at).toLocaleDateString() + '</td>'
      + '<td style="display:flex;gap:6px;">' + actionBtn
      + '<button class="btn btn-sm btn-danger" onclick="removeSubscriber(\'' + s.id + '\',\'' + nameForJs + '\')">Remove</button></td></tr>';
  }).join('');
  el.innerHTML = '<div class="table-wrap"><table><thead><tr><th>Name</th><th>Email</th><th>Status</th><th>Joined</th><th></th></tr></thead><tbody>' + rows + '</tbody></table></div>';
}

async function resubscribeSubscriber(id, name) {
  const { error } = await window.supabase.from('email_subscribers').update({ unsubscribed_at: null }).eq('id', id);
  if (error) { toast('Error: ' + error.message, true); return; }
  toast('Resubscribed ' + name);
  loadMarketingSubscribers();
}

async function removeSubscriber(id, name) {
  if (!confirm('Permanently remove ' + name + ' from the subscriber list? This also removes their topic preferences and can\'t be undone.')) return;
  const { error } = await window.supabase.from('email_subscribers').delete().eq('id', id);
  if (error) { toast('Error: ' + error.message, true); return; }
  toast('Removed ' + name);
  loadMarketingSubscribers();
}

function subAlert(msg, isError) {
  const el = document.getElementById('mkt-sub-alert');
  el.style.display = 'block';
  el.style.background = isError ? 'rgba(220,53,69,0.1)' : 'rgba(42,184,166,0.1)';
  el.style.color = isError ? 'var(--red)' : 'var(--teal)';
  el.textContent = msg;
}

// General-purpose subscriber add, independent of any topic — the
// topic-scoped modal (openTopicSubscribersModal) covers "add people
// to this specific audience"; this covers "add people at all,"
// needed even when no topics exist yet.
async function addSubscribersDirect() {
  const raw = document.getElementById('mkt-sub-emails').value;
  const entries = parseBulkEmailLines(raw);
  document.getElementById('mkt-sub-alert').style.display = 'none';

  if (!entries.length) { subAlert('Enter at least one email.', true); return; }
  const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const invalid = entries.find((e) => !emailRe.test(e.email));
  if (invalid) { subAlert('Invalid email: ' + invalid.email, true); return; }

  const emails = entries.map((e) => e.email.toLowerCase());
  const newRows = entries.map((e) => ({ email: e.email.toLowerCase(), name: e.name, source: 'manual' }));
  const { error: insErr } = await window.supabase.from('email_subscribers').upsert(newRows, { onConflict: 'email', ignoreDuplicates: true });
  if (insErr) { subAlert(insErr.message, true); return; }

  if (directAddTopicIds.size) {
    const { data: subRows, error: fetchErr } = await window.supabase.from('email_subscribers').select('id,email').in('email', emails);
    if (fetchErr) { subAlert(fetchErr.message, true); return; }
    const prefRows = [];
    (subRows || []).forEach((s) => { directAddTopicIds.forEach((topicId) => prefRows.push({ subscriber_id: s.id, topic_id: topicId, subscribed: true })); });
    if (prefRows.length) {
      const { error: prefErr } = await window.supabase.from('subscriber_topic_preferences').upsert(prefRows, { onConflict: 'subscriber_id,topic_id' });
      if (prefErr) { subAlert(prefErr.message, true); return; }
    }
  }

  subAlert('Added ' + entries.length + ' subscriber(s).');
  document.getElementById('mkt-sub-emails').value = '';
  loadMarketingSubscribers();
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
