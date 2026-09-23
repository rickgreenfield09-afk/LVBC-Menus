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
  // Recovery links fire PASSWORD_RECOVERY. Invite links (api/invite-staff.js)
  // fire SIGNED_IN instead, with a valid session already attached before
  // any password has ever been set — needs_password (set as user_metadata
  // at invite time) is what tells them apart.
  client.auth.onAuthStateChange((event, session) => {
    if (event === 'PASSWORD_RECOVERY' || (event === 'SIGNED_IN' && session?.user?.user_metadata?.needs_password)) {
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
  if (session.user?.user_metadata?.needs_password) {
    // Reloaded mid-invite-flow before a password was ever set — this
    // session is authenticated but shouldn't be treated as a real login.
    awaitingPasswordSet = true;
    renderSetPassword();
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

function showForgotPassword(e) {
  e.preventDefault();
  document.getElementById('login-form').style.display = 'none';
  document.getElementById('forgot-password-error').textContent = '';
  document.getElementById('forgot-password-success').textContent = '';
  document.getElementById('forgot-password-form').style.display = 'block';
}

function showLogin(e) {
  e.preventDefault();
  document.getElementById('forgot-password-form').style.display = 'none';
  document.getElementById('login-form').style.display = 'block';
}

async function handleForgotPassword(e) {
  e.preventDefault();
  const email = document.getElementById('forgot-password-email').value.trim();
  const errEl = document.getElementById('forgot-password-error');
  const successEl = document.getElementById('forgot-password-success');
  errEl.textContent = '';
  successEl.textContent = '';

  const { error } = await window.supabase.auth.resetPasswordForEmail(email, {
    redirectTo: window.location.origin,
  });
  if (error) {
    errEl.textContent = error.message;
    return;
  }
  successEl.textContent = 'Check your email for a reset link.';
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

  const { error } = await window.supabase.auth.updateUser({ password: pw1, data: { needs_password: false } });
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
  const adminNavBtn = document.getElementById('nav-btn-admin');
  if (adminNavBtn) adminNavBtn.style.display = window.currentStaff.role === 'admin' ? '' : 'none';
  const marketingNavBtn = document.getElementById('nav-btn-marketing');
  if (marketingNavBtn) marketingNavBtn.style.display = window.currentStaff.role === 'admin' ? '' : 'none';
  if (typeof loadDashboard === 'function') loadDashboard();
  if (typeof loadMenu === 'function') loadMenu();
  if (typeof refreshBingoNavBadge === 'function') refreshBingoNavBadge();
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

// ── PROFILE (self-service name + photo) ──────────────────
// Writes are protected server-side by migration_019 — RLS lets a
// staffer update only their OWN row, and a trigger silently reverts
// any column here besides name/photo_url even if this code tried to
// send one, so this stays safe regardless of what the UI sends.
let pendingProfilePhotoFile = null;

function openProfileModal() {
  pendingProfilePhotoFile = null;
  document.getElementById('profile-name-input').value = window.currentStaff.name || '';
  document.getElementById('profile-photo-preview').src = window.currentStaff.photo_url || 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96"%3E%3Crect width="96" height="96" fill="%23ccc"/%3E%3C/svg%3E';
  document.getElementById('profile-alert').style.display = 'none';
  document.getElementById('profile-modal').style.display = 'flex';
}

function closeProfileModal() {
  document.getElementById('profile-modal').style.display = 'none';
}

function handleProfilePhotoChosen(event) {
  const file = event.target.files[0];
  if (!file) return;
  pendingProfilePhotoFile = file;
  document.getElementById('profile-photo-preview').src = URL.createObjectURL(file);
}

function profileAlert(msg, isError) {
  const el = document.getElementById('profile-alert');
  el.style.display = 'block';
  el.style.background = isError ? 'rgba(220,53,69,0.1)' : 'rgba(42,184,166,0.1)';
  el.style.color = isError ? 'var(--red)' : 'var(--teal)';
  el.textContent = msg;
}

async function saveProfile() {
  const name = document.getElementById('profile-name-input').value.trim();
  if (!name) { profileAlert('Name is required.', true); return; }

  const uid = window.currentStaff.id;
  const updates = { name };

  if (pendingProfilePhotoFile) {
    const ext = (pendingProfilePhotoFile.name.split('.').pop() || 'jpg').toLowerCase();
    const path = 'staff/' + uid + '/photo.' + ext;
    const { error: upErr } = await window.supabase.storage.from('assets').upload(path, pendingProfilePhotoFile, { upsert: true });
    if (upErr) { profileAlert('Photo upload failed: ' + upErr.message, true); return; }
    updates.photo_url = window.supabase.storage.from('assets').getPublicUrl(path).data.publicUrl;
  }

  const { error } = await window.supabase.from('staff_profiles').update(updates).eq('id', uid);
  if (error) { profileAlert(error.message, true); return; }

  window.currentStaff = Object.assign({}, window.currentStaff, updates);
  document.getElementById('staff-name-badge').textContent = window.currentStaff.name;
  toast('Profile updated');
  closeProfileModal();
}

document.addEventListener('DOMContentLoaded', checkSession);
