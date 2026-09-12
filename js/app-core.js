// app-core.js
// Loaded once, before any page script. Provides:
//   - window.supabase          (Supabase JS client)
//   - window.currentStaff      (signed-in staff_profiles row, or null)
//   - showScreen(id, navBtn)   (screen router)
//   - toast(msg, isError)
//   - tierClass(tierName)      (css class for tier pills)
//   - getInitials(name)

(function () {
  const { SUPABASE_URL, SUPABASE_ANON_KEY } = window.LVBC_CONFIG;
  const client = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  window.supabase = client;

  const logo = document.getElementById('header-logo');
  if (logo) logo.src = SUPABASE_URL + '/storage/v1/object/public/assets/lvbc-logo.png';

  // Fires when someone lands here via an invite / password-recovery email
  // link; Supabase parses the token from the URL and hands us a temporary
  // session before checkSession() would otherwise run.
  client.auth.onAuthStateChange((event) => {
    if (event === 'PASSWORD_RECOVERY') {
      awaitingPasswordSet = true;
      renderSetPassword();
    }
  });
})();

window.currentStaff = null;
let awaitingPasswordSet = false;

// ── AUTH ─────────────────────────────────────────────────
async function checkSession() {
  if (awaitingPasswordSet) return;
  const { data: { session } } = await window.supabase.auth.getSession();
  if (!session) {
    renderLoggedOut();
    return;
  }
  const { data: profile, error } = await window.supabase
    .from('staff_profiles')
    .select('*')
    .eq('id', session.user.id)
    .single();

  if (error || !profile) {
    // Authenticated with Supabase, but no staff_profiles row yet.
    document.getElementById('login-error').textContent =
      'Signed in, but no staff profile exists for this account. Ask an admin to add one.';
    await window.supabase.auth.signOut();
    renderLoggedOut();
    return;
  }

  // Always trust the session's own email over whatever is cached on
  // the profile row — used to resolve "my shifts" against any
  // duplicate/placeholder profile sharing that email (migration_014).
  window.currentStaff = Object.assign({}, profile, { email: session.user.email });
  renderLoggedIn();
}

async function handleLogin(e) {
  e.preventDefault();
  const email = document.getElementById('login-email').value.trim();
  const password = document.getElementById('login-password').value;
  const errEl = document.getElementById('login-error');
  errEl.textContent = '';

  const { error } = await window.supabase.auth.signInWithPassword({ email, password });
  if (error) {
    errEl.textContent = error.message;
    return;
  }
  await checkSession();
}

async function handleLogout() {
  await window.supabase.auth.signOut();
  window.currentStaff = null;
  renderLoggedOut();
}

async function handleSetPassword(e) {
  e.preventDefault();
  const pw1 = document.getElementById('set-password-1').value;
  const pw2 = document.getElementById('set-password-2').value;
  const errEl = document.getElementById('set-password-error');
  errEl.textContent = '';

  if (pw1 !== pw2) {
    errEl.textContent = 'Passwords do not match.';
    return;
  }

  const { error } = await window.supabase.auth.updateUser({ password: pw1 });
  if (error) {
    errEl.textContent = error.message;
    return;
  }

  awaitingPasswordSet = false;
  await checkSession();
}

function renderLoggedIn() {
  document.getElementById('set-password-screen').style.display = 'none';
  document.getElementById('login-screen').style.display = 'none';
  document.getElementById('app-shell').style.display = 'flex';
  document.getElementById('staff-name-badge').textContent = window.currentStaff.name;
  if (typeof loadDashboard === 'function') loadDashboard();
  if (typeof loadMenu === 'function') loadMenu();
}

function renderLoggedOut() {
  document.getElementById('set-password-screen').style.display = 'none';
  document.getElementById('app-shell').style.display = 'none';
  document.getElementById('login-screen').style.display = 'flex';
}

function renderSetPassword() {
  document.getElementById('login-screen').style.display = 'none';
  document.getElementById('app-shell').style.display = 'none';
  document.getElementById('set-password-screen').style.display = 'flex';
}

// ── NAV ROUTER ───────────────────────────────────────────
function showScreen(id, btn) {
  document.querySelectorAll('.screen').forEach((s) => s.classList.remove('active'));
  document.getElementById('screen-' + id).classList.add('active');
  document.querySelectorAll('.nav-btn').forEach((b) => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
}

// ── SHARED UI HELPERS ────────────────────────────────────
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

function showToast(msg, isError) {
  toast(msg, isError);
}

function tierClass(tierName) {
  if (!tierName) return 'tier-free';
  const t = tierName.toLowerCase();
  if (t.includes('mug')) return 'tier-mug';
  if (t.includes('coffee')) return 'tier-coffee';
  if (t.includes('full')) return 'tier-full';
  return 'tier-free';
}

function getInitials(name) {
  if (!name) return '?';
  return name
    .split(' ')
    .map((p) => p[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();
}

document.addEventListener('DOMContentLoaded', checkSession);
