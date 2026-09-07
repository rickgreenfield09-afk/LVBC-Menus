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
  window.supabase = supabaseJs.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
})();

window.currentStaff = null;

// ── AUTH ─────────────────────────────────────────────────
async function checkSession() {
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

  window.currentStaff = profile;
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

function renderLoggedIn() {
  document.getElementById('login-screen').style.display = 'none';
  document.getElementById('app-shell').style.display = 'flex';
  document.getElementById('staff-name-badge').textContent = window.currentStaff.name;
  if (typeof loadDashboard === 'function') loadDashboard();
}

function renderLoggedOut() {
  document.getElementById('app-shell').style.display = 'none';
  document.getElementById('login-screen').style.display = 'flex';
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
