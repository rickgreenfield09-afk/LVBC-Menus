// core.js (member app)
// Loaded once, before any page script. The member app is the
// customer's side of the membership program — a member sees their own
// card, activity, badges and profile, plus the menus, events and the
// leaderboard. It shares the Supabase project with the staff apps but
// not their login: a member is a Supabase Auth user linked to one
// members row (migration_042), and RLS shows them only that row's data.
// Provides:
//   - window.supabase          (Supabase JS client)
//   - window.currentMember     (the signed-in member's row, with tiers)
//   - showTab(id)              (page router, driven by the header menu)
//   - openMenu(), closeMenu()
//   - refreshMember()          (re-read the member row and redraw)
//   - toast(msg, isError), escHtml(s), initials(name), avatarHtml(m),
//     tierName(m), isPaidMember(m), fmtDate(d, opts), fmtTime(t)
//
// The PIN is the account's Supabase Auth password — 8 digits, checked
// here only for shape. It is never read from or written to a table.
// PINs used to be 6 digits: an older PIN still signs in once, and the
// member is then made to choose an 8-digit one before getting in.
//
// A reset link signs the member in with a temporary session so they
// can choose a PIN. Until it's saved that session must not open the
// app, even after a reload — MEMBER_PIN_REQUIRED_KEY holds the mark and
// checkSession() honours it.

const PIN_RE = /^\d{8}$/;
const MEMBER_PIN_REQUIRED_KEY = 'lvbc-member-pin-required';
function markPinRequired(userId) { try { localStorage.setItem(MEMBER_PIN_REQUIRED_KEY, userId); } catch (e) { /* storage blocked — settingNewPin still holds this page */ } }
function clearPinRequired() { try { localStorage.removeItem(MEMBER_PIN_REQUIRED_KEY); } catch (e) { /* nothing to clear */ } }
function pinRequiredFor(userId) { try { return localStorage.getItem(MEMBER_PIN_REQUIRED_KEY) === userId; } catch (e) { return false; } }
const MEMBER_SELECT = '*, tiers(name, rank)';
const TAB_TITLES = { card: 'LVBC', activity: 'Activity', badges: 'My Badges', membership: 'Membership', rewards: 'Rewards', leaderboard: 'Leaderboard', tap: 'On Tap', events: 'Events', profile: 'My Profile' };
const TAB_LOADERS = {
  card: () => renderCard(), activity: () => loadActivity(), badges: () => loadBadgesPage(), membership: () => loadMembership(), rewards: () => renderRewards(),
  leaderboard: () => loadLeaderboard(), tap: () => loadTapList(), events: () => loadEvents(), profile: () => populateProfile(),
};

window.currentMember = null;
let currentTab = 'card';
let settingNewPin = false;
let realtimeChannel = null;

(function () {
  const { SUPABASE_URL, SUPABASE_ANON_KEY } = window.LVBC_CONFIG;
  // Its own storage key, so signing in here never touches a staff
  // session open in the same browser (and the reverse).
  window.supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { storageKey: 'lvbc-member-auth' } });

  const logo = SUPABASE_URL + '/storage/v1/object/public/assets/lvbc-logo.png';
  document.getElementById('login-logo').src = logo;
  document.getElementById('header-logo').src = logo;

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/member/sw.js', { scope: '/member/' }).catch(() => { /* app still works online without it */ });
  }

  // The reset-PIN email link lands here with a temporary session.
  window.supabase.auth.onAuthStateChange((event, session) => {
    if (event === 'PASSWORD_RECOVERY') {
      markPinRequired(session.user.id);
      settingNewPin = true;
      renderSignedOut();
      showAuthCard('newpin');
    }
  });
})();

// ── AUTH ─────────────────────────────────────────────────
async function checkSession() {
  if (settingNewPin) return;
  const { data: { session } } = await window.supabase.auth.getSession();
  if (!session) { renderSignedOut(); return; }
  if (pinRequiredFor(session.user.id)) { requireNewPin(); return; }
  await enterApp(session);
}

// Shows the choose-a-PIN card and keeps the app shut until it's saved.
function requireNewPin(note) {
  settingNewPin = true;
  renderSignedOut();
  showAuthCard('newpin');
  if (note) authAlert('newpin', note, true);
}

// Links the account to its member row (creating one for a brand-new
// sign-up), loads it, and opens the app.
async function enterApp(session) {
  const { error: claimErr } = await window.supabase.rpc('member_claim_account', { p_name: session.user.user_metadata?.name || null });
  if (claimErr) {
    renderSignedOut();
    showAuthCard('signin');
    authAlert('signin', claimErr.message.includes('fetch') ? 'Could not reach the server. Check your connection and try again.' : claimErr.message);
    return;
  }
  if (!(await refreshMember(true))) {
    renderSignedOut();
    authAlert('signin', 'Could not load your membership. Try again.');
    return;
  }
  document.getElementById('login-screen').style.display = 'none';
  document.getElementById('app-shell').classList.add('visible');
  showTab('card');
  subscribeCheckins();
}

function renderSignedOut() {
  closeMenu();
  document.getElementById('app-shell').classList.remove('visible');
  document.getElementById('login-screen').style.display = 'flex';
}

function showAuthCard(which, e) {
  if (e) e.preventDefault();
  ['signin', 'signup', 'forgot', 'newpin', 'message'].forEach((c) => {
    document.getElementById('auth-' + c).style.display = c === which ? 'block' : 'none';
  });
  document.querySelectorAll('#login-screen .alert').forEach((a) => { a.className = 'alert'; });
}

function showAuthMessage(title, body) {
  showAuthCard('message');
  document.getElementById('auth-message-title').textContent = title;
  document.getElementById('auth-message-body').textContent = body;
}

function authAlert(card, msg, ok) {
  const el = document.getElementById(card + '-alert');
  el.textContent = msg;
  el.className = 'alert visible ' + (ok ? 'alert-success' : 'alert-error');
}

function setBusy(btnId, busyText) {
  const btn = document.getElementById(btnId);
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = busyText;
  return () => { btn.disabled = false; btn.textContent = label; };
}

async function handleSignIn(e) {
  e.preventDefault();
  const email = document.getElementById('signin-email').value.trim().toLowerCase();
  const pin = document.getElementById('signin-pin').value.trim();
  if (!pin) { authAlert('signin', 'Enter your PIN.'); return; }
  const done = setBusy('signin-btn', 'Signing in...');
  const { data, error } = await window.supabase.auth.signInWithPassword({ email, password: pin });
  done();
  if (error) {
    authAlert('signin', error.message === 'Invalid login credentials' ? 'That email and PIN don\'t match.'
      : /not confirmed/i.test(error.message) ? 'Confirm your email first — check your inbox for the link.' : error.message);
    return;
  }
  document.getElementById('signin-pin').value = '';
  // An older 6-digit PIN: right credentials, but choose an 8-digit one first.
  if (!PIN_RE.test(pin)) {
    markPinRequired(data.user.id);
    requireNewPin('PINs are now 8 digits. Choose your new PIN to continue.');
    return;
  }
  await enterApp(data.session);
}

async function handleSignUp(e) {
  e.preventDefault();
  const name = document.getElementById('signup-name').value.trim();
  const email = document.getElementById('signup-email').value.trim().toLowerCase();
  const pin = document.getElementById('signup-pin').value.trim();
  if (!name) { authAlert('signup', 'Enter your name.'); return; }
  if (!PIN_RE.test(pin)) { authAlert('signup', 'Choose a PIN of exactly 8 digits.'); return; }
  if (pin !== document.getElementById('signup-pin2').value.trim()) { authAlert('signup', 'The two PINs don\'t match.'); return; }

  const done = setBusy('signup-btn', 'Creating account...');
  const { data, error } = await window.supabase.auth.signUp({
    email, password: pin,
    options: { data: { name }, emailRedirectTo: window.location.origin + '/member/' },
  });
  done();
  if (error) { authAlert('signup', error.message); return; }
  ['signup-pin', 'signup-pin2'].forEach((id) => { document.getElementById(id).value = ''; });

  // With email confirmation on there is no session until the link in
  // the email is opened. (Supabase answers the same way for an address
  // that already has an account, so the message covers both.)
  if (!data.session) {
    showAuthMessage('Check Your Email', 'We sent a link to ' + email + '. Open it to confirm your address, then sign in with your PIN. Already have an account? Just sign in.');
    return;
  }
  await enterApp(data.session);
}

async function handleForgotPin(e) {
  e.preventDefault();
  const email = document.getElementById('forgot-email').value.trim().toLowerCase();
  const done = setBusy('forgot-btn', 'Sending...');
  const { error } = await window.supabase.auth.resetPasswordForEmail(email, { redirectTo: window.location.origin + '/member/' });
  done();
  if (error) { authAlert('forgot', error.message); return; }
  showAuthMessage('Check Your Email', 'If ' + email + ' has an account, a link to choose a new PIN is on its way.');
}

async function handleNewPin(e) {
  e.preventDefault();
  const pin = document.getElementById('newpin-1').value.trim();
  if (!PIN_RE.test(pin)) { authAlert('newpin', 'Choose a PIN of exactly 8 digits.'); return; }
  if (pin !== document.getElementById('newpin-2').value.trim()) { authAlert('newpin', 'The two PINs don\'t match.'); return; }
  const done = setBusy('newpin-btn', 'Saving...');
  const { error } = await window.supabase.auth.updateUser({ password: pin });
  done();
  if (error) {
    // Stay on this card: the session is only good for choosing a PIN.
    authAlert('newpin', error.code === 'same_password' || /different from the old/i.test(error.message) ? 'That\'s already your PIN. Choose a different one.'
      : error.code === 'weak_password' || /weak|pwned|leaked/i.test(error.message) ? 'That PIN is too easy to guess. Choose a less common one.'
        : /session/i.test(error.message) ? 'This link has expired. Request a new reset email and try again.' : error.message);
    return;
  }
  clearPinRequired();
  ['newpin-1', 'newpin-2'].forEach((id) => { document.getElementById(id).value = ''; });
  settingNewPin = false;
  showAuthCard('signin');
  await checkSession();
  toast('PIN updated');
}

async function handleSignOut() {
  clearPinRequired();
  settingNewPin = false;
  if (realtimeChannel) { window.supabase.removeChannel(realtimeChannel); realtimeChannel = null; }
  await window.supabase.auth.signOut();
  window.currentMember = null;
  showAuthCard('signin');
  renderSignedOut();
}

// ── MEMBER ───────────────────────────────────────────────
// RLS already limits a member to their own rows. The explicit filters
// here and in the page scripts are for the one account RLS shows more
// to: a staff login that is also a member.
async function refreshMember(quiet) {
  const { data: { session } } = await window.supabase.auth.getSession();
  if (!session) return false;
  const { data, error } = await window.supabase.from('members').select(MEMBER_SELECT).eq('auth_user_id', session.user.id).maybeSingle();
  if (error || !data) return false;
  window.currentMember = data;
  renderChrome();
  if (!quiet && TAB_LOADERS[currentTab]) TAB_LOADERS[currentTab]();
  return true;
}

// The bits of the member that sit outside any one page.
function renderChrome() {
  const m = window.currentMember;
  document.getElementById('header-avatar-btn').innerHTML = avatarHtml(m);
  document.getElementById('menu-avatar').innerHTML = avatarHtml(m);
  document.getElementById('menu-name').textContent = m.name;
  document.getElementById('menu-tier').textContent = tierName(m) + ' · Member #' + m.member_number;
}

// Staff scanning the member's code inserts a check_ins row; Realtime
// delivers it here (only their own — RLS applies) and the card page
// greets them. Coming back to the app re-reads the balance too, in
// case the phone was asleep when it happened.
function subscribeCheckins() {
  if (realtimeChannel) window.supabase.removeChannel(realtimeChannel);
  realtimeChannel = window.supabase.channel('member-checkins-' + window.currentMember.id)
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'check_ins', filter: 'member_id=eq.' + window.currentMember.id },
      async (payload) => {
        await refreshMember(true);
        showTab('card');
        showCheckinFlash(payload.new);
      })
    .subscribe();
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && window.currentMember) refreshMember();
});

// ── PAGE ROUTER + MENU ───────────────────────────────────
function showTab(id) {
  closeMenu();
  currentTab = id;
  document.querySelectorAll('.tab-screen').forEach((s) => s.classList.remove('active'));
  document.getElementById('tab-' + id).classList.add('active');
  document.querySelectorAll('.menu-item').forEach((b) => b.classList.toggle('active', b.dataset.tab === id));
  document.getElementById('app-header-title').textContent = TAB_TITLES[id];
  window.scrollTo(0, 0);
  TAB_LOADERS[id]();
}

function openMenu() {
  document.getElementById('app-menu').classList.add('open');
  document.getElementById('app-menu').setAttribute('aria-hidden', 'false');
  document.getElementById('menu-scrim').classList.add('open');
}

function closeMenu() {
  document.getElementById('app-menu').classList.remove('open');
  document.getElementById('app-menu').setAttribute('aria-hidden', 'true');
  document.getElementById('menu-scrim').classList.remove('open');
}

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
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function initials(name) {
  return (name || '?').split(' ').filter(Boolean).map((p) => p[0]).join('').slice(0, 2).toUpperCase();
}

function avatarHtml(m) {
  return m && m.profile_photo_url ? '<img src="' + escHtml(m.profile_photo_url) + '" alt="">' : escHtml(initials(m && m.name));
}

function tierName(m) { return (m && m.tiers && m.tiers.name) || 'Free'; }
function isPaidMember(m) { return !!(m && m.tiers && m.tiers.rank > 0); }

function tierClass(name) {
  const t = (name || '').toLowerCase();
  return t.includes('mug') ? 'tier-mug' : t.includes('coffee') ? 'tier-coffee' : t.includes('full') ? 'tier-fullpour' : 'tier-free';
}

function fmtDate(d, opts) {
  return new Date(d).toLocaleDateString('en-US', opts || { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

// '18:30:00' -> '6:30 PM'
function fmtTime(t) {
  if (!t) return '';
  const [h, m] = t.split(':');
  const hr = +h;
  return (hr % 12 || 12) + ':' + m + ' ' + (hr >= 12 ? 'PM' : 'AM');
}

function money(n) { return '$' + Number(n).toFixed(2).replace(/\.00$/, ''); }

document.addEventListener('DOMContentLoaded', checkSession);
