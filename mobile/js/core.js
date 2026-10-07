// core.js (mobile)
// Loaded once, before any screen script. The mobile counterpart of
// js/app-core.js — same Supabase project, same staff_profiles login,
// so RLS applies exactly as it does on the desktop panel. Provides:
//   - window.supabase          (Supabase JS client)
//   - window.currentStaff      (signed-in staff_profiles row, or null)
//   - showTab(id, navBtn)      (bottom tab router)
//   - toast(msg, isError), escHtml(s), toDateStr(d), fmtTime(t)

(function () {
  const { SUPABASE_URL, SUPABASE_ANON_KEY } = window.LVBC_CONFIG;
  window.supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/mobile/sw.js', { scope: '/mobile/' }).catch(() => { /* app still works online without it */ });
  }
})();

window.currentStaff = null;
const M_PROFILE_KEY = 'lvbc-mobile-profile';
const M_TAB_TITLES = { schedule: 'Schedule', inventory: 'Inventory', timeoff: 'Time Off' };
const M_TAB_LOADERS = { schedule: () => loadSchedule(), inventory: () => loadInventoryCount(), timeoff: () => loadTimeOff() };

// ── AUTH ─────────────────────────────────────────────────
async function checkSession() {
  const { data: { session } } = await window.supabase.auth.getSession();
  if (!session) { renderLoggedOut(); return; }

  if (session.user?.user_metadata?.needs_password) {
    // Invited but never set a password — that flow lives on the desktop panel.
    await window.supabase.auth.signOut();
    renderLoggedOut('Finish setting up your account from the invite email first.');
    return;
  }

  const { data: profile, error } = await window.supabase
    .from('staff_profiles').select('*').eq('id', session.user.id).maybeSingle();

  let staff = profile;
  if (error) {
    // No signal (walk-in, cellar): fall back to the profile saved at the
    // last successful sign-in so the count screen still opens offline.
    const cached = readJson(M_PROFILE_KEY);
    if (cached && cached.id === session.user.id) staff = cached;
    else { renderLoggedOut('Could not reach the server. Check your connection and try again.'); return; }
  } else if (!profile) {
    await window.supabase.auth.signOut();
    renderLoggedOut('Signed in, but no staff profile exists for this account. Ask an admin to add one.');
    return;
  }

  window.currentStaff = Object.assign({}, staff, { email: session.user.email });
  writeJson(M_PROFILE_KEY, window.currentStaff);
  renderLoggedIn();
}

async function handleLogin(e) {
  e.preventDefault();
  const email = document.getElementById('login-email').value.trim();
  const password = document.getElementById('login-password').value;
  const errEl = document.getElementById('login-error');
  errEl.textContent = '';

  const { error } = await window.supabase.auth.signInWithPassword({ email, password });
  if (error) { errEl.textContent = error.message; return; }
  await checkSession();
}

async function handleLogout() {
  await window.supabase.auth.signOut();
  window.currentStaff = null;
  localStorage.removeItem(M_PROFILE_KEY);
  renderLoggedOut();
}

function renderLoggedIn() {
  document.getElementById('login-screen').style.display = 'none';
  document.getElementById('app-shell').style.display = 'flex';
  document.getElementById('staff-name-badge').textContent = window.currentStaff.name;
  updateOfflineBar();
  loadSchedule();
}

function renderLoggedOut(msg) {
  document.getElementById('app-shell').style.display = 'none';
  document.getElementById('login-screen').style.display = 'flex';
  document.getElementById('login-error').textContent = msg || '';
}

// ── TAB ROUTER ───────────────────────────────────────────
function showTab(id, btn) {
  document.querySelectorAll('.screen').forEach((s) => s.classList.remove('active'));
  document.getElementById('screen-' + id).classList.add('active');
  document.querySelectorAll('.m-tabbar .nav-btn').forEach((b) => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  document.getElementById('m-screen-title').textContent = M_TAB_TITLES[id];
  window.scrollTo(0, 0);
  M_TAB_LOADERS[id]();
}

function updateOfflineBar() {
  document.getElementById('m-offline-bar').style.display = navigator.onLine ? 'none' : 'block';
}
window.addEventListener('online', updateOfflineBar);
window.addEventListener('offline', updateOfflineBar);

// ── SHARED HELPERS ───────────────────────────────────────
function toast(msg, isError) {
  const el = document.createElement('div');
  el.className = 'toast' + (isError ? ' error' : '');
  el.textContent = msg;
  document.body.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 300);
  }, 3000);
}

function escHtml(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function toDateStr(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function fmtTime(t) {
  if (!t) return '';
  const [h, m] = t.split(':');
  const hr = ((+h + 11) % 12) + 1;
  return hr + (m === '00' ? '' : ':' + m) + (+h < 12 ? 'am' : 'pm');
}

function readJson(key) {
  try { return JSON.parse(localStorage.getItem(key)); } catch (e) { return null; }
}
function writeJson(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* storage full or blocked — non-fatal */ }
}

document.addEventListener('DOMContentLoaded', checkSession);
