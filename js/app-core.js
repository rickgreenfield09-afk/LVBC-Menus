// app-core.js
// Loaded once, before any page script. Provides:
//   - window.supabase          (Supabase JS client)
//   - window.currentStaff      (signed-in staff_profiles row, or null)
//   - showScreen(id, navBtn)   (screen router)
//   - toast(msg, isError)
//   - tierClass(tierName)      (css class for tier pills)
//   - getInitials(name)
//
// Sign-in is email + an 8-digit PIN (the PIN is the Supabase Auth
// password; the staff mobile app and the member app use the same one).
// Anyone still on an older password can sign in with it once and is
// then made to choose a PIN before getting in.
//
// A reset or invite link signs the person in with a temporary session
// so they can choose a PIN. Until that PIN is saved, the session must
// not open the app — not even after a reload — so the "PIN required"
// mark is kept in localStorage (STAFF_PIN_REQUIRED_KEY, shared with the
// staff mobile app on the same origin) and checkSession() honours it.

const STAFF_PIN_RE = /^\d{8}$/;
const STAFF_PIN_REQUIRED_KEY = 'lvbc-staff-pin-required';
function markPinRequired(userId) { try { localStorage.setItem(STAFF_PIN_REQUIRED_KEY, userId); } catch (e) { /* storage blocked — the in-memory flag still holds this page */ } }
function clearPinRequired() { try { localStorage.removeItem(STAFF_PIN_REQUIRED_KEY); } catch (e) { /* nothing to clear */ } }
function pinRequiredFor(userId) { try { return localStorage.getItem(STAFF_PIN_REQUIRED_KEY) === userId; } catch (e) { return false; } }

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
      markPinRequired(session.user.id);
      awaitingPasswordSet = true;
      renderSetPassword(event === 'PASSWORD_RECOVERY' ? 'Choose a new 8-digit PIN to finish resetting your sign-in.' : 'Choose an 8-digit PIN to finish setting up your account.');
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
  if (session.user?.user_metadata?.needs_password || pinRequiredFor(session.user.id)) {
    // Reloaded mid-invite or mid-reset before a PIN was saved — this
    // session is authenticated but must not be treated as a real login.
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

  const { data, error } = await window.supabase.auth.signInWithPassword({ email, password });
  if (error) {
    errEl.textContent = error.message === 'Invalid login credentials' ? 'That email and PIN don\'t match.' : error.message;
    return;
  }
  document.getElementById('login-password').value = '';
  // Still on an old-style password: right credentials, but choose a PIN before going in.
  if (!STAFF_PIN_RE.test(password)) {
    markPinRequired(data.user.id);
    awaitingPasswordSet = true;
    renderSetPassword('Sign-in now uses an 8-digit PIN. Choose yours to continue — you\'ll use it on the staff panel and the staff phone app.');
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
  clearPinRequired();
  awaitingPasswordSet = false;
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

  if (!STAFF_PIN_RE.test(pw1)) {
    errEl.textContent = 'Your PIN must be exactly 8 digits.';
    return;
  }
  if (pw1 !== pw2) {
    errEl.textContent = 'The two PINs don\'t match.';
    return;
  }

  const { error } = await window.supabase.auth.updateUser({ password: pw1, data: { needs_password: false } });
  if (error) {
    // Stay on this screen: the session is only good for choosing a PIN.
    errEl.textContent = pinErrorMessage(error);
    return;
  }

  clearPinRequired();
  document.getElementById('set-password-1').value = '';
  document.getElementById('set-password-2').value = '';
  awaitingPasswordSet = false;
  await checkSession();
}

// Supabase's wording for the refusals people actually hit.
function pinErrorMessage(error) {
  if (error.code === 'same_password' || /different from the old/i.test(error.message)) return 'That\'s already your PIN. Choose a different one.';
  if (error.code === 'weak_password' || /weak|pwned|leaked/i.test(error.message)) return 'That PIN is too easy to guess. Choose a less common one.';
  if (/session/i.test(error.message)) return 'This link has expired. Request a new reset email and try again.';
  return error.message;
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
  // Assignments is managed by whoever builds the schedule — same rule as canSchedule() in schedule.js.
  const assignmentsNavBtn = document.getElementById('nav-btn-assignments');
  if (assignmentsNavBtn) assignmentsNavBtn.style.display = (window.currentStaff.role === 'admin' || window.currentStaff.can_schedule) ? '' : 'none';
  if (typeof loadDashboard === 'function') loadDashboard();
  if (typeof loadMenu === 'function') loadMenu();
  if (typeof refreshBingoNavBadge === 'function') refreshBingoNavBadge();
  // Every staffer needs a number on file for the staff phone app's Team page.
  if (!window.currentStaff.phone) openProfileModal(true);
}

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

function renderLoggedOut() {
  document.getElementById('set-password-screen').style.display = 'none';
  document.getElementById('app-shell').style.display = 'none';
  document.getElementById('login-screen').style.display = 'flex';
}

function renderSetPassword(note) {
  if (note) document.getElementById('set-password-note').textContent = note;
  document.getElementById('set-password-error').textContent = '';
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
let profilePhoneRequired = false;

// required: opened at sign-in because there's no phone number yet —
// it can't be closed until one is saved.
function openProfileModal(required) {
  pendingProfilePhotoFile = null;
  profilePhoneRequired = required === true;
  document.getElementById('profile-close-btn').style.display = profilePhoneRequired ? 'none' : '';
  document.getElementById('profile-name-input').value = window.currentStaff.name || '';
  document.getElementById('profile-phone-input').value = window.currentStaff.phone ? formatPhone(window.currentStaff.phone) : '';
  document.getElementById('profile-photo-preview').src = window.currentStaff.photo_url || 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96"%3E%3Crect width="96" height="96" fill="%23ccc"/%3E%3C/svg%3E';
  document.getElementById('profile-alert').style.display = 'none';
  if (profilePhoneRequired) profileAlert('Add your mobile number to continue — the team uses it to text and call you from the staff phone app.', false);
  document.getElementById('profile-modal').style.display = 'flex';
}

function closeProfileModal() {
  if (profilePhoneRequired) return;
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
  const phone = normalizePhone(document.getElementById('profile-phone-input').value);
  if (!phone) { profileAlert('Enter a 10-digit US mobile number.', true); return; }

  const uid = window.currentStaff.id;
  const updates = { name, phone };

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
  profilePhoneRequired = false;
  closeProfileModal();
}

document.addEventListener('DOMContentLoaded', checkSession);
