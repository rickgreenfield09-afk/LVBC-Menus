// push.js
// Screen: Marketing > Push — compose a push notification and send it to
// members, staff, or both. Admin-only (the Marketing nav is hidden for
// everyone else, and api/send-push.js re-checks the role).
//
// Delivery goes through api/send-push.js (web push, VAPID keys in Vercel
// env vars); the app-side opt-in is push-client.js. Members who turned
// off their "All Notifications" toggle are skipped. History comes from
// push_notifications (migration_048).
// Depends on: window.supabase, toast(), escHtml() (js/menu.js)

const PUSH_AUDIENCE_LABEL = { members: 'Members', staff: 'Staff', both: 'Members + Staff' };
let pushCounts = null;

async function pushAuthHeaders() {
  const { data: { session } } = await window.supabase.auth.getSession();
  return session ? { 'Content-Type': 'application/json', Authorization: 'Bearer ' + session.access_token } : null;
}

function loadPush() {
  document.getElementById('push-preview-icon').src = window.LVBC_CONFIG.SUPABASE_URL + '/storage/v1/object/public/assets/lvbc-logo.png';
  loadPushStatus();
  loadPushHistory();
  updatePushPreview();
}

async function loadPushStatus() {
  const el = document.getElementById('push-status');
  const headers = await pushAuthHeaders();
  if (!headers) { el.innerHTML = '<div class="loading">Session expired — please sign in again.</div>'; return; }
  try {
    const res = await fetch('/api/send-push', { headers });
    const data = await res.json();
    if (!res.ok) { el.innerHTML = '<div class="loading">Error: ' + escHtml(data.error || 'Could not check push status') + '</div>'; return; }
    pushCounts = data;
    if (!data.configured) {
      el.innerHTML = '<div class="card"><div class="card-title">Not set up yet</div><div class="card-sub">Add VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY to the Vercel environment variables (generate them with <code>npx web-push generate-vapid-keys</code>), then redeploy.</div></div>';
      return;
    }
    el.innerHTML = '<div class="grid-2" style="grid-template-columns:repeat(2,1fr);gap:16px;">'
      + '<div class="card"><div class="card-title">Member Devices</div><div class="card-value teal">' + data.members + '</div><div class="card-sub">Opted in to notifications</div></div>'
      + '<div class="card"><div class="card-title">Staff Devices</div><div class="card-value teal">' + data.staff + '</div><div class="card-sub">Turned on in the staff app (Team tab)</div></div>'
      + '</div>';
  } catch (e) {
    el.innerHTML = '<div class="loading">Error: ' + escHtml(e.message) + '</div>';
  }
}

async function loadPushHistory() {
  const el = document.getElementById('push-history');
  const { data, error } = await window.supabase.from('push_notifications').select('*').order('created_at', { ascending: false }).limit(25);
  if (error) { el.innerHTML = '<div class="loading">Error: ' + escHtml(error.message) + '</div>'; return; }
  if (!data.length) { el.innerHTML = '<div class="loading">Nothing sent yet.</div>'; return; }
  el.innerHTML = '<table><thead><tr><th>Sent</th><th>Title</th><th>Message</th><th>To</th><th>Delivered</th></tr></thead><tbody>'
    + data.map((n) => '<tr><td>' + new Date(n.created_at).toLocaleString() + '</td>'
      + '<td>' + escHtml(n.title) + '</td><td>' + escHtml(n.body) + '</td>'
      + '<td>' + PUSH_AUDIENCE_LABEL[n.audience] + '</td>'
      + '<td>' + n.sent_count + (n.failed_count ? ' <span class="badge badge-red">' + n.failed_count + ' failed</span>' : '') + '</td></tr>').join('')
    + '</tbody></table>';
}

function updatePushPreview() {
  const title = document.getElementById('push-title').value.trim();
  const body = document.getElementById('push-body').value.trim();
  document.getElementById('push-preview-title').textContent = title || 'Title';
  document.getElementById('push-preview-body').textContent = body || 'Your message shows up here.';
  document.getElementById('push-title-count').textContent = title.length + '/65';
  document.getElementById('push-body-count').textContent = body.length + '/240';
}

function pushAlert(msg, isError) {
  const el = document.getElementById('push-alert');
  el.textContent = msg || '';
  el.style.color = isError ? 'var(--red)' : 'var(--teal)';
}

// Sends right away through api/send-push.js. Returns { sent, failed } or
// { error } — never throws. Also used by bingo.js when a game is printed.
async function sendPushNow({ title, body, url = '', audience }) {
  const headers = await pushAuthHeaders();
  if (!headers) return { error: 'Your session expired — please sign in again.' };
  try {
    const res = await fetch('/api/send-push', { method: 'POST', headers, body: JSON.stringify({ title, body, url, audience }) });
    const data = await res.json();
    return res.ok ? data : { error: data.error || 'Could not send.' };
  } catch (e) {
    return { error: e.message };
  }
}

async function sendPush() {
  const title = document.getElementById('push-title').value.trim();
  const body = document.getElementById('push-body').value.trim();
  const url = document.getElementById('push-url').value;
  const audience = document.getElementById('push-audience').value;
  if (!title || !body) { pushAlert('Add a title and a message.', true); return; }

  let count = '';
  if (pushCounts && pushCounts.configured) {
    const n = (audience !== 'staff' ? pushCounts.members : 0) + (audience !== 'members' ? pushCounts.staff : 0);
    count = ' (about ' + n + ' device' + (n === 1 ? '' : 's') + ')';
  }
  if (!confirm('Send this notification to ' + PUSH_AUDIENCE_LABEL[audience] + count + '? It goes out immediately and cannot be recalled.')) return;

  const headers = await pushAuthHeaders();
  if (!headers) { pushAlert('Your session expired — please sign in again.', true); return; }
  const btn = document.getElementById('push-send-btn');
  btn.disabled = true; btn.textContent = 'Sending...';
  try {
    const res = await fetch('/api/send-push', { method: 'POST', headers, body: JSON.stringify({ title, body, url, audience }) });
    const data = await res.json();
    if (!res.ok) { pushAlert(data.error || 'Could not send.', true); return; }
    pushAlert('');
    toast('Sent to ' + data.sent + ' device(s)' + (data.failed ? ' — ' + data.failed + ' failed' : ''));
    document.getElementById('push-title').value = '';
    document.getElementById('push-body').value = '';
    document.getElementById('push-url').value = '';
    loadPush();
  } catch (e) {
    pushAlert(e.message, true);
  } finally {
    btn.disabled = false; btn.textContent = 'Send Notification';
  }
}
