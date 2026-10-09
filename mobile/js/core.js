// core.js (mobile)
// Loaded once, before any screen script. The mobile counterpart of
// js/app-core.js — same Supabase project, same staff_profiles login,
// so RLS applies exactly as it does on the desktop panel. Provides:
//   - window.supabase          (Supabase JS client)
//   - window.currentStaff      (signed-in staff_profiles row, or null)
//   - showTab(id)              (page router, driven by the header menu)
//   - openMenu(), closeMenu()  (the slide-in page menu)
//   - toast(msg, isError), escHtml(s), mInitials(name), toDateStr(d), fmtTime(t)

(function () {
  const { SUPABASE_URL, SUPABASE_ANON_KEY } = window.LVBC_CONFIG;
  window.supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/mobile/sw.js', { scope: '/mobile/' }).catch(() => { /* app still works online without it */ });
  }
})();

window.currentStaff = null;
const M_PROFILE_KEY = 'lvbc-mobile-profile';
const M_TAB_TITLES = { schedule: 'Schedule', tasks: 'Tasks', inventory: 'Inventory', members: 'Check-In', leaderboard: 'Leaderboard' };
const M_TAB_LOADERS = {
  schedule: () => loadSchedule(), tasks: () => loadTasks(), inventory: () => loadInventoryCount(),
  members: () => loadMemberCheckin(), leaderboard: () => loadLeaderboard(),
};

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
  const staff = window.currentStaff;
  // The header shows the photo set on the desktop panel's profile, or initials.
  const avatar = staff.photo_url
    ? '<img src="' + escHtml(staff.photo_url) + '" alt="">'
    : escHtml(mInitials(staff.name));
  document.getElementById('m-avatar').innerHTML = avatar;
  document.getElementById('m-menu-avatar').innerHTML = avatar;
  document.getElementById('m-menu-name').textContent = staff.name;
  document.getElementById('m-menu-role').textContent = staff.position || '';
  updateOfflineBar();
  loadSchedule();
}

function renderLoggedOut(msg) {
  closeMenu();
  document.getElementById('app-shell').style.display = 'none';
  document.getElementById('login-screen').style.display = 'flex';
  document.getElementById('login-error').textContent = msg || '';
}

// ── PAGE ROUTER + MENU ───────────────────────────────────
function showTab(id) {
  closeMenu();
  document.querySelectorAll('.screen').forEach((s) => s.classList.remove('active'));
  document.getElementById('screen-' + id).classList.add('active');
  document.querySelectorAll('.m-menu-item').forEach((b) => b.classList.toggle('active', b.dataset.tab === id));
  document.getElementById('m-screen-title').textContent = M_TAB_TITLES[id];
  window.scrollTo(0, 0);
  M_TAB_LOADERS[id]();
}

function openMenu() {
  document.getElementById('m-menu').classList.add('open');
  document.getElementById('m-menu').setAttribute('aria-hidden', 'false');
  document.getElementById('m-menu-scrim').classList.add('open');
}

function closeMenu() {
  document.getElementById('m-menu').classList.remove('open');
  document.getElementById('m-menu').setAttribute('aria-hidden', 'true');
  document.getElementById('m-menu-scrim').classList.remove('open');
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

function mInitials(name) {
  return (name || '?').split(' ').map((p) => p[0]).join('').slice(0, 2).toUpperCase();
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
