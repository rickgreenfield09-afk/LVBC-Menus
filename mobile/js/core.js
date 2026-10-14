// core.js (mobile)
// Loaded once, before any screen script. The mobile counterpart of
// js/app-core.js — same Supabase project, same staff_profiles login,
// so RLS applies exactly as it does on the desktop panel. Provides:
//   - window.supabase          (Supabase JS client)
//   - window.currentStaff      (signed-in staff_profiles row, or null)
//   - showTab(id, navBtn)      (bottom tab router)
//   - toast(msg, isError), escHtml(s), toDateStr(d), fmtTime(t)
//
// Sign-in is email + an 8-digit PIN — the same login as the desktop
// staff panel (js/app-core.js), and the same session: both apps share
// one origin and Supabase's default storage. Anyone still on an older
// password signs in with it once and must then choose a PIN.
//
// A reset or invite link signs the person in with a temporary session
// so they can choose a PIN. Until it's saved, that session must not
// open the app, even after a reload: STAFF_PIN_REQUIRED_KEY (shared
// with the desktop panel) holds the mark and checkSession() honours it.

const STAFF_PIN_RE = /^\d{8}$/;
const STAFF_PIN_REQUIRED_KEY = 'lvbc-staff-pin-required';
let mSettingPin = false;
function markPinRequired(userId) { try { localStorage.setItem(STAFF_PIN_REQUIRED_KEY, userId); } catch (e) { /* storage blocked — mSettingPin still holds this page */ } }
function clearPinRequired() { try { localStorage.removeItem(STAFF_PIN_REQUIRED_KEY); } catch (e) { /* nothing to clear */ } }
function pinRequiredFor(userId) { try { return localStorage.getItem(STAFF_PIN_REQUIRED_KEY) === userId; } catch (e) { return false; } }

(function () {
  const { SUPABASE_URL, SUPABASE_ANON_KEY } = window.LVBC_CONFIG;
  window.supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

  // Reset links fire PASSWORD_RECOVERY; invite links fire SIGNED_IN with
  // needs_password set (see js/app-core.js). Either way: choose a PIN first.
  window.supabase.auth.onAuthStateChange((event, session) => {
    if (event === 'PASSWORD_RECOVERY' || (event === 'SIGNED_IN' && session?.user?.user_metadata?.needs_password)) {
      markPinRequired(session.user.id);
      renderSetPin(event === 'PASSWORD_RECOVERY' ? 'Choose a new 8-digit PIN to finish resetting your sign-in.' : 'Choose an 8-digit PIN to finish setting up your account.');
    }
  });

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/mobile/sw.js', { scope: '/mobile/' }).catch(() => { /* app still works online without it */ });
  }
})();

window.currentStaff = null;
const M_PROFILE_KEY = 'lvbc-mobile-profile';
// "tasks" is the My Shift page; its id predates the rename.
const M_TAB_TITLES = { tasks: 'My Shift', schedule: 'Schedule', inventory: 'Inventory', team: 'Team' };
const M_TAB_LOADERS = { tasks: () => loadTasks(), schedule: () => loadSchedule(), inventory: () => loadInventoryCount(), team: () => loadTeam() };

// ── AUTH ─────────────────────────────────────────────────
async function checkSession() {
  if (mSettingPin) return;
  const { data: { session } } = await window.supabase.auth.getSession();
  if (!session) { renderLoggedOut(); return; }

  if (session.user?.user_metadata?.needs_password || pinRequiredFor(session.user.id)) {
    // Mid-invite or mid-reset: authenticated, but not a real login until a PIN is saved.
    renderSetPin();
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
  // Everyone has to have a number on file for the Team page. (Skipped
  // when the profile came from the offline cache — it can't be saved then.)
  if (!error && !window.currentStaff.phone) { renderPhoneGate(); return; }
  renderLoggedIn();
}

// ── PHONE NUMBER (required; see team.js) ─────────────────
// "(512) 555-0123", "512.555.0123", "+1 512 555 0123" -> "+15125550123"; null if it isn't a US number.
function normalizePhone(raw) {
  let digits = String(raw || '').replace(/\D/g, '');
  if (digits.length === 11 && digits[0] === '1') digits = digits.slice(1);
  return digits.length === 10 ? '+1' + digits : null;
}

function formatPhone(phone) {
  const d = String(phone || '').replace(/\D/g, '').slice(-10);
  return d.length === 10 ? '(' + d.slice(0, 3) + ') ' + d.slice(3, 6) + '-' + d.slice(6) : phone || '';
}

// Saves the signed-in staffer's own number. Returns an error message, or null when saved.
async function saveMyPhone(raw) {
  const phone = normalizePhone(raw);
  if (!phone) return 'Enter a 10-digit US phone number.';
  const { data, error } = await window.supabase.from('staff_profiles').update({ phone }).eq('id', window.currentStaff.id).select('phone');
  if (error) return navigator.onLine ? error.message : 'You\'re offline — try again once you have signal.';
  if (!data.length) return 'Could not save your number. Sign out and back in, then try again.';
  window.currentStaff.phone = phone;
  writeJson(M_PROFILE_KEY, window.currentStaff);
  return null;
}

function renderPhoneGate() {
  document.getElementById('login-screen').style.display = 'none';
  document.getElementById('app-shell').style.display = 'none';
  document.getElementById('phone-error').textContent = '';
  document.getElementById('phone-screen').style.display = 'flex';
}

async function handlePhoneGate(e) {
  e.preventDefault();
  const err = await saveMyPhone(document.getElementById('phone-input').value);
  if (err) { document.getElementById('phone-error').textContent = err; return; }
  document.getElementById('phone-screen').style.display = 'none';
  toast('Number saved');
  renderLoggedIn();
}

async function handleLogin(e) {
  e.preventDefault();
  const email = document.getElementById('login-email').value.trim();
  const password = document.getElementById('login-password').value;
  const errEl = document.getElementById('login-error');
  errEl.textContent = '';

  const { data, error } = await window.supabase.auth.signInWithPassword({ email, password });
  if (error) { errEl.textContent = error.message === 'Invalid login credentials' ? 'That email and PIN don\'t match.' : error.message; return; }
  document.getElementById('login-password').value = '';
  // Still on an old-style password: right credentials, but choose a PIN before going in.
  if (!STAFF_PIN_RE.test(password)) {
    markPinRequired(data.user.id);
    renderSetPin('Sign-in now uses an 8-digit PIN. Choose yours to continue — you\'ll use it here and on the staff panel.');
    return;
  }
  await checkSession();
}

function showLoginCard(which, e) {
  if (e) e.preventDefault();
  ['login-form', 'forgot-form'].forEach((id) => { document.getElementById(id).style.display = id === which ? 'block' : 'none'; });
  document.getElementById('forgot-msg').textContent = '';
}

async function handleForgotPin(e) {
  e.preventDefault();
  const email = document.getElementById('forgot-email').value.trim();
  const msgEl = document.getElementById('forgot-msg');
  msgEl.className = 'm-login-error';
  msgEl.textContent = '';
  // The link comes back to this app, which asks for the new PIN.
  const { error } = await window.supabase.auth.resetPasswordForEmail(email, { redirectTo: window.location.origin + '/mobile/' });
  if (error) { msgEl.textContent = error.message; return; }
  msgEl.className = 'm-login-error ok';
  msgEl.textContent = 'Check your email for a link to choose a new PIN.';
}

function renderSetPin(note) {
  mSettingPin = true;
  if (note) document.getElementById('setpin-note').textContent = note;
  document.getElementById('setpin-error').textContent = '';
  document.getElementById('app-shell').style.display = 'none';
  document.getElementById('login-screen').style.display = 'none';
  document.getElementById('setpin-screen').style.display = 'flex';
}

async function handleSetPin(e) {
  e.preventDefault();
  const pin = document.getElementById('setpin-1').value.trim();
  const errEl = document.getElementById('setpin-error');
  if (!STAFF_PIN_RE.test(pin)) { errEl.textContent = 'Your PIN must be exactly 8 digits.'; return; }
  if (pin !== document.getElementById('setpin-2').value.trim()) { errEl.textContent = 'The two PINs don\'t match.'; return; }
  const { error } = await window.supabase.auth.updateUser({ password: pin, data: { needs_password: false } });
  if (error) {
    // Stay here: the session is only good for choosing a PIN.
    errEl.textContent = error.code === 'same_password' || /different from the old/i.test(error.message) ? 'That\'s already your PIN. Choose a different one.'
      : error.code === 'weak_password' || /weak|pwned|leaked/i.test(error.message) ? 'That PIN is too easy to guess. Choose a less common one.'
        : /session/i.test(error.message) ? 'This link has expired. Request a new reset email and try again.' : error.message;
    return;
  }
  clearPinRequired();
  mSettingPin = false;
  document.getElementById('setpin-1').value = '';
  document.getElementById('setpin-2').value = '';
  document.getElementById('setpin-screen').style.display = 'none';
  toast('PIN saved');
  await checkSession();
}

async function handleLogout() {
  clearPinRequired();
  mSettingPin = false;
  document.getElementById('setpin-screen').style.display = 'none';
  document.getElementById('phone-screen').style.display = 'none';
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
  // Land on today's shift.
  showTab('tasks', document.querySelector('.m-tabbar .nav-btn'));
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
