// members.js (mobile)
// Screens: #screen-members (Member Check-In) and #screen-leaderboard —
// the bar-side half of the membership program (migration_040). The
// catalog, member records and reports stay on the desktop panel
// (js/members.js).
//
// Find a member by name, email, member # or by scanning their QR
// code; their card opens as a sheet: check in (or DD mode), give the
// free pour on a new release, log a beer to their journal, redeem a
// reward. A scan checks the member in on its own.
//
// Like the desktop screen, nothing here writes a balance — every
// action is one of the member_* database functions, which decide the
// points, enforce reward limits and award badges.
// Needs a connection: there is no offline queue for points.
// Depends on: window.supabase, toast(), escHtml(), mInitials()
// (core.js), mOpenSheet() / mCloseSheet() (inventory.js)

const M_MEM_SELECT = '*, tiers(name, rank)';
const M_MEM_LEVELS = { 1: 'Treasure Box', 2: 'Social Currency', 3: 'Real Merch', 4: 'Insider Access', 5: 'Legacy' };

let mMemCurrent = null;
let mMemBeers = [];
let mMemRewards = [];
let mMemSearchTimer = null;
let mMemScanner = null;
let mMemScanBusy = false;
let mLbPeriod = 'month';

function mMemTier(m) { return (m && m.tiers && m.tiers.name) || 'Free'; }
function mMemTierPill(m) {
  const t = mMemTier(m).toLowerCase();
  const cls = t.includes('mug') ? 'tier-mug' : t.includes('coffee') ? 'tier-coffee' : t.includes('full') ? 'tier-full' : 'tier-free';
  return '<span class="tier ' + cls + '">' + escHtml(mMemTier(m)) + '</span>';
}
function mMemAvatar(m) {
  return '<div class="m-avatar">' + (m && m.profile_photo_url ? '<img src="' + escHtml(m.profile_photo_url) + '" alt="">' : escHtml(mInitials(m && m.name))) + '</div>';
}
function mMemDayStart() { const d = new Date(); d.setHours(0, 0, 0, 0); return d.toISOString(); }

async function mMemRpc(fn, args) {
  const { data, error } = await window.supabase.rpc(fn, args);
  if (error) { toast(navigator.onLine ? error.message : 'No connection — points need a signal', true); return null; }
  (data.new_badges || []).forEach((name, i) => setTimeout(() => toast('🏅 New badge: ' + name), 3200 * (i + 1)));
  return data;
}

// ── CHECK-IN PAGE ────────────────────────────────────────
async function loadMemberCheckin() {
  mMemLoadToday();
  const [beers, rewards] = await Promise.all([
    window.supabase.from('beers').select('id, name, style, badges').eq('status', 'active').order('name'),
    window.supabase.from('rewards').select('*').eq('is_active', true).order('level').order('points_cost').order('reward_name'),
  ]);
  const isNew = (b) => ((b.badges || []).includes('new_release') ? 1 : 0);
  mMemBeers = (beers.data || []).sort((a, b) => isNew(b) - isNew(a));
  mMemRewards = rewards.data || [];
}

async function mMemLoadToday() {
  const { data, error } = await window.supabase.from('check_ins')
    .select('member_id, kind, points_awarded, checked_in_at, free_pour_beer, members(name, tiers(name))')
    .gte('checked_in_at', mMemDayStart()).order('checked_in_at', { ascending: false });
  const el = document.getElementById('m-mem-today');
  if (error) { el.innerHTML = '<div class="loading">Could not load — check your connection</div>'; return; }
  document.getElementById('m-mem-today-count').textContent = data.length ? '· ' + data.length : '';
  el.innerHTML = data.length ? data.map((c) =>
    '<div class="checkin-row" onclick="mMemOpen(\'' + c.member_id + '\')"><div>'
    + '<div class="checkin-name">' + escHtml((c.members && c.members.name) || 'Unknown') + '</div>'
    + '<div class="checkin-time">' + new Date(c.checked_in_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) + (c.kind === 'dd' ? ' · DD' : '') + '</div>'
    + (c.free_pour_beer ? '<div class="checkin-pour">Free pour: ' + escHtml(c.free_pour_beer) + '</div>' : '')
    + '</div><div class="checkin-pts">+' + c.points_awarded + '</div></div>').join('')
    : '<div class="loading">No check-ins today yet</div>';
}

function mMemSearchInput(val) {
  clearTimeout(mMemSearchTimer);
  mMemSearchTimer = setTimeout(async () => {
    const el = document.getElementById('m-mem-results');
    const clean = val.replace(/[,()%*\\]/g, ' ').trim();
    const isNum = /^\d+$/.test(clean);
    if (clean.length < 2 && !isNum) { el.innerHTML = ''; return; }
    let q = window.supabase.from('members').select(M_MEM_SELECT).order('name').limit(20);
    q = isNum ? q.eq('member_number', +clean) : q.or('name.ilike.%' + clean + '%,email.ilike.%' + clean + '%');
    const { data, error } = await q;
    if (error) { el.innerHTML = '<div class="loading">Could not search — check your connection</div>'; return; }
    el.innerHTML = data.length ? data.map((m) =>
      '<div class="m-item m-mem-row" onclick="mMemOpen(\'' + m.id + '\')">' + mMemAvatar(m)
      + '<div class="m-rec-body"><div class="m-item-name">' + escHtml(m.name) + '</div>'
      + '<div class="m-item-sub">#' + m.member_number + ' · ' + mMemTierPill(m) + (m.is_active ? '' : ' · inactive') + '</div></div>'
      + '<div class="m-mem-pts">' + m.points_balance + '<small>PTS</small></div></div>').join('')
      : '<div class="loading">No members found</div>';
  }, 300);
}

// ── MEMBER CARD (sheet) ──────────────────────────────────
async function mMemOpen(id, flash) {
  const [mRes, checkins, today, journal, pours, badges] = await Promise.all([
    window.supabase.from('members').select(M_MEM_SELECT).eq('id', id).maybeSingle(),
    window.supabase.from('check_ins').select('id', { count: 'exact', head: true }).eq('member_id', id),
    window.supabase.from('check_ins').select('kind, points_awarded').eq('member_id', id).gte('checked_in_at', mMemDayStart()).limit(1),
    window.supabase.from('member_beers').select('beer_name').eq('member_id', id),
    window.supabase.from('free_pours').select('beer_id').eq('member_id', id),
    window.supabase.from('member_badges').select('badges(name, border_color)').eq('member_id', id).order('earned_at', { ascending: false }),
  ]);
  const m = mRes.data;
  if (!m) { toast(mRes.error ? 'Could not load — check your connection' : 'Member not found', true); return; }
  mMemCurrent = m;

  const checkedIn = (today.data || [])[0];
  const tried = new Set((journal.data || []).map((j) => j.beer_name.toLowerCase()));
  const poured = new Set((pours.data || []).map((p) => p.beer_id));
  const paid = !!(m.tiers && m.tiers.rank > 0);
  const off = m.is_active ? '' : ' disabled';

  const beerHtml = mMemBeers.map((b) => {
    const isNew = (b.badges || []).includes('new_release'); const hadPour = poured.has(b.id); const hasTried = tried.has(b.name.toLowerCase());
    let btn;
    if (isNew && !hadPour) btn = '<button class="btn btn-sm btn-scan"' + off + ' onclick="mMemFreePour(\'' + b.id + '\')">Free Pour</button>';
    else if (hasTried) btn = '<span class="m-rec-done">✓ tried</span>';
    else btn = '<button class="btn btn-sm btn-secondary"' + off + ' onclick="mMemLogBeer(\'' + b.id + '\')">Log</button>';
    return '<div class="m-mem-line"><div class="m-mem-line-body"><div class="m-task-target-name">' + escHtml(b.name) + '</div>'
      + '<div class="m-item-sub">' + escHtml(b.style || '') + (isNew ? ' · <span style="color:var(--amber);">' + (hadPour ? 'free pour used' : 'new release') + '</span>' : '') + '</div></div>' + btn + '</div>';
  }).join('') || '<div class="loading">No active beers on the tap list</div>';

  const rewardHtml = mMemRewards.map((r) => {
    const why = !m.is_active ? 'inactive' : r.paid_only && !paid ? 'paid members' : m.points_balance < r.points_cost ? (r.points_cost - m.points_balance) + ' more' : '';
    return '<div class="m-mem-line' + (why ? ' locked' : '') + '"><div class="m-mem-line-body"><div class="m-task-target-name">' + escHtml(r.reward_name) + '</div>'
      + '<div class="m-item-sub">L' + r.level + ' ' + M_MEM_LEVELS[r.level] + ' · ' + r.points_cost + ' pts' + (why ? ' · ' + why : '') + '</div></div>'
      + (why ? '' : '<button class="btn btn-sm btn-primary" onclick="mMemRedeem(\'' + r.id + '\')">Redeem</button>') + '</div>';
  }).join('') || '<div class="loading">No rewards set up yet</div>';

  mOpenSheet('<div class="m-sheet-body">'
    + '<div class="m-mem-head">' + mMemAvatar(m)
    + '<div class="m-rec-body"><div class="m-sheet-title">' + escHtml(m.name) + '</div>'
    + '<div class="m-item-sub" style="margin-top:4px;">' + mMemTierPill(m) + (m.is_active ? '' : ' <span class="badge badge-red">Inactive</span>') + '</div></div>'
    + '<div class="m-mem-pts" style="font-size:30px;color:var(--text);">' + m.member_number + '<small>TABLE #</small></div></div>'
    + (flash ? '<div class="m-mem-done" style="margin-top:14px;">' + escHtml(flash) + '</div>' : '')
    + '<div class="m-mem-stats">'
    + '<div class="stat-box"><div class="stat-label">Balance</div><div class="stat-val" style="color:var(--teal);">' + m.points_balance + '</div></div>'
    + '<div class="stat-box"><div class="stat-label">Lifetime</div><div class="stat-val">' + m.points_earned_lifetime + '</div></div>'
    + '<div class="stat-box"><div class="stat-label">Check-Ins</div><div class="stat-val">' + (checkins.count || 0) + '</div></div>'
    + '</div><div class="m-mem-actions">'
    + (checkedIn
      ? (flash ? '' : '<div class="m-mem-done">✓ Checked in today' + (checkedIn.kind === 'dd' ? ' · DD' : '') + ' · +' + checkedIn.points_awarded + ' pts</div>')
      : '<button class="btn btn-primary"' + off + ' onclick="mMemCheckIn(\'standard\')">Check In</button><button class="btn btn-dd"' + off + ' onclick="mMemCheckIn(\'dd\')">DD Mode</button>')
    + '</div>'
    + '<label class="admin-label m-sheet-label">Badges</label><div class="m-mem-badges">'
    + ((badges.data || []).map((b) => '<span class="m-mem-badge" style="border-color:' + escHtml(b.badges.border_color || 'var(--border)') + ';">' + escHtml(b.badges.name) + '</span>').join('')
      || '<span class="m-item-sub">No badges yet</span>') + '</div>'
    + '<label class="admin-label m-sheet-label">On Tap · ' + tried.size + ' in journal</label><div class="card">' + beerHtml + '</div>'
    + '<label class="admin-label m-sheet-label">Rewards</label><div class="card">' + rewardHtml + '</div>'
    + '</div><div class="m-sheet-actions" style="grid-template-columns:1fr;"><button class="btn btn-secondary" onclick="mMemClose()">Done</button></div>');
}

function mMemClose() {
  mMemCurrent = null;
  mCloseSheet();
  mMemLoadToday();
}

async function mMemCheckIn(kind) {
  if (!mMemCurrent) return;
  const res = await mMemRpc('member_check_in', { p_member: mMemCurrent.id, p_kind: kind });
  if (!res) return;
  mMemOpen(mMemCurrent.id, res.already ? 'Already checked in today' : '✓ ' + (kind === 'dd' ? 'DD check-in' : 'Checked in') + ' · ' + res.label + ' · +' + res.points + ' pts');
}

async function mMemFreePour(beerId) {
  if (!mMemCurrent) return;
  const res = await mMemRpc('member_free_pour', { p_member: mMemCurrent.id, p_beer: beerId });
  if (!res) return;
  const pts = (res.checkin.points || 0) + (res.journal.points || 0);
  mMemOpen(mMemCurrent.id, 'Free pour — ' + res.beer + (res.checkin.already ? '' : ' · checked in') + (pts ? ' · +' + pts + ' pts' : ''));
}

async function mMemLogBeer(beerId) {
  if (!mMemCurrent) return;
  const res = await mMemRpc('member_log_beer', { p_member: mMemCurrent.id, p_beer: beerId });
  if (!res) return;
  toast(res.already ? 'Already in their journal' : 'Added to journal' + (res.points ? ' · +' + res.points + ' pts' : ''));
  mMemOpen(mMemCurrent.id);
}

async function mMemRedeem(rewardId) {
  const r = mMemRewards.find((x) => x.id === rewardId);
  if (!mMemCurrent || !r) return;
  if (!confirm('Redeem "' + r.reward_name + '" for ' + mMemCurrent.name + '?\n\n' + r.points_cost + ' points will come off their balance.')) return;
  const res = await mMemRpc('member_redeem', { p_member: mMemCurrent.id, p_reward: rewardId, p_notes: null });
  if (!res) return;
  mMemOpen(mMemCurrent.id, '✓ Redeemed ' + res.reward + ' · ' + res.balance + ' pts left');
}

// ── QR SCANNER ───────────────────────────────────────────
// ZXing is only fetched the first time someone scans.
function mMemLoadZxing() {
  if (window.ZXing) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://unpkg.com/@zxing/library@0.21.3/umd/index.min.js';
    s.onload = resolve; s.onerror = reject;
    document.head.appendChild(s);
  });
}

async function mMemOpenScanner() {
  let overlay = document.getElementById('m-mem-scanner');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'm-mem-scanner';
    overlay.className = 'scanner-overlay';
    overlay.innerHTML = '<div class="scanner-box"><video id="m-mem-scanner-video" autoplay playsinline muted></video>'
      + '<div class="scanner-corner tl"></div><div class="scanner-corner tr"></div><div class="scanner-corner bl"></div><div class="scanner-corner br"></div><div class="scanner-line"></div></div>'
      + '<div class="scanner-label">POINT AT MEMBER QR CODE</div><div class="scanner-status" id="m-mem-scanner-status"></div>'
      + '<div class="scanner-btn-row"><button class="btn-cancel" onclick="mMemCloseScanner()">Cancel</button></div>';
    document.body.appendChild(overlay);
  }
  overlay.classList.add('active');
  const status = document.getElementById('m-mem-scanner-status');
  status.textContent = 'Starting camera...';
  try {
    await mMemLoadZxing();
    mMemScanner = new ZXing.BrowserQRCodeReader();
    status.textContent = 'Ready — point at QR code';
    mMemScanner.decodeFromVideoDevice(null, 'm-mem-scanner-video', (result) => { if (result) mMemScanned(result.getText()); });
  } catch (e) {
    status.textContent = 'Could not start the camera';
  }
}

async function mMemScanned(token) {
  if (mMemScanBusy) return;
  mMemScanBusy = true;
  const status = document.getElementById('m-mem-scanner-status');
  status.textContent = 'Looking up member...';
  const { data } = await window.supabase.from('qr_tokens').select('member_id, members(is_active)').eq('token', token.trim()).maybeSingle();
  mMemScanBusy = false;
  if (!data) { status.textContent = 'Code not recognized — try again'; return; }
  mMemCloseScanner();
  // a scan is a check-in: the member is standing at the bar
  mMemCurrent = { id: data.member_id };
  if (data.members && data.members.is_active) mMemCheckIn('standard');
  else mMemOpen(data.member_id);
}

function mMemCloseScanner() {
  if (mMemScanner) { try { mMemScanner.reset(); } catch (e) { /* camera already released */ } mMemScanner = null; }
  const overlay = document.getElementById('m-mem-scanner');
  if (overlay) overlay.classList.remove('active');
}

// ── LEADERBOARD PAGE ─────────────────────────────────────
function setLbPeriod(p) { mLbPeriod = p; loadLeaderboard(); }

async function loadLeaderboard() {
  document.getElementById('m-lb-chips').innerHTML = [['month', 'This Month'], ['all', 'All Time']].map((p) =>
    '<div class="badge-pill' + (mLbPeriod === p[0] ? ' selected' : '') + '" onclick="setLbPeriod(\'' + p[0] + '\')">' + p[1] + '</div>').join('');
  const el = document.getElementById('m-lb-list');
  let q = window.supabase.from('check_ins').select('member_id, members(name, profile_photo_url, tiers(name, rank))').limit(10000);
  if (mLbPeriod === 'month') { const n = new Date(); q = q.gte('checked_in_at', new Date(n.getFullYear(), n.getMonth(), 1).toISOString()); }
  const { data, error } = await q;
  if (error) { el.innerHTML = '<div class="loading" style="padding:16px;">Could not load — check your connection</div>'; return; }
  const counts = {}; const info = {};
  data.forEach((r) => { counts[r.member_id] = (counts[r.member_id] || 0) + 1; if (r.members) info[r.member_id] = r.members; });
  const top = Object.keys(counts).sort((a, b) => counts[b] - counts[a]).slice(0, 20);
  el.innerHTML = top.length ? top.map((id, i) => {
    const m = info[id] || { name: 'Unknown' };
    return '<div class="lb-row" onclick="showTab(\'members\');mMemOpen(\'' + id + '\')">'
      + '<div class="lb-rank' + (i < 3 ? ' top' : '') + '">' + (i + 1) + '</div>' + mMemAvatar(m)
      + '<div style="flex:1;min-width:0;"><div style="font-size:14px;font-weight:500;">' + escHtml(m.name) + '</div><div>' + mMemTierPill(m) + '</div></div>'
      + '<div style="text-align:right;"><div class="lb-count">' + counts[id] + '</div><div class="lb-count-label">visits</div></div></div>';
  }).join('') : '<div class="loading" style="padding:16px;">No check-ins ' + (mLbPeriod === 'month' ? 'this month ' : '') + 'yet</div>';
}
