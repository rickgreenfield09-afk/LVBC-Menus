// members.js
// Screen: #screen-members — the membership program (migration_040).
// Ported from the first staff panel (lvbc-staff-panel), minus its
// On Tap, Events and LVBC U There tools.
//
//   Check-In   find a member by name, email, member # or QR code;
//              check them in, give a free pour, log a beer, see badges
//   Rewards    spend points on a reward
//   Members    add / edit / deactivate, adjust or award points, history
//   Catalog    rewards, scoring rules and badges
//   Reports    check-ins, ledger, top earners, redemptions, new members
//
// Nothing here writes a balance. Check-ins, awards, redemptions, free
// pours and beer logs all go through the member_* database functions,
// which take point values from point_rules, enforce reward limits and
// award badges. This file just calls them and redraws.
//
// The tap list is the Menus beers table: active beers only, and a beer
// with the 'new_release' badge is the one members get a free pour of.
// Depends on: window.supabase, toast(), tierClass(), getInitials()
// (app-core.js), escHtml() (menu.js), toDateStr() (schedule.js)

const MEM_VIEWS = ['checkin', 'rewards', 'members', 'catalog', 'reports'];
const MEM_LEVELS = { 1: 'Treasure Box', 2: 'Social Currency', 3: 'Real Merch', 4: 'Insider Access', 5: 'Legacy' };
const MEM_BADGE_CATEGORIES = ['Explorer', 'Coffee Pioneer', 'Event Regular', 'Competitive', 'Milestone', 'Seasonal', 'Retired Recipe', 'Social', 'Membership', 'Secret'];
const MEM_RULE_TYPES = {
  first_checkin: 'First check-in',
  checkin_count: 'Total check-ins',
  checkins_in_season: 'Check-ins within a season',
  unique_beers: 'Unique beers tried',
  lifetime_points: 'Lifetime points',
  anniversary: 'Membership anniversary',
  tier: 'On a membership tier',
  all_of: 'Holds other badges',
};
// which inputs each rule type needs on the Add Badge form
const MEM_RULE_FIELDS = {
  first_checkin: [], checkin_count: ['count'], checkins_in_season: ['months', 'count'], unique_beers: ['count', 'patterns'],
  lifetime_points: ['points'], anniversary: ['years'], tier: ['tier'], all_of: ['badges'],
};
const MEM_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MEM_REPORTS = { checkins: 'Check-Ins', points: 'Points Ledger', topearners: 'Top Earners', redemptions: 'Redemptions', newmembers: 'New Members' };
const MEM_SELECT = '*, tiers(name, rank)';

let memView = 'checkin';
let memMember = null;        // the member open on Check-In; Rewards starts from them too
let memAdminMember = null;   // the member open on the Members page
let memTiers = [];
let memRewards = [];
let memRules = [];
let memBeers = [];
let memLbPeriod = 'month';
let memReport = 'checkins';
let memReportData = null;
let memSearchTimer = null;
let memScanner = null;

// ── SHARED ───────────────────────────────────────────────
function memTierName(m) { return (m && m.tiers && m.tiers.name) || 'Free'; }
function memIsPaid(m) { return !!(m && m.tiers && m.tiers.rank > 0); }
function memTierPill(m) { return '<span class="tier ' + tierClass(memTierName(m)) + '">' + escHtml(memTierName(m)) + '</span>'; }
function memDate(d, opts) { return d ? new Date(d).toLocaleDateString('en-US', opts || { month: 'short', day: 'numeric', year: 'numeric' }) : '—'; }
function memTime(d) { return new Date(d).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); }
function memDayStart() { const d = new Date(); d.setHours(0, 0, 0, 0); return d.toISOString(); }
function memRuleLabel(type) {
  if (type === 'redemption') return 'Redemption';
  const r = memRules.find((x) => x.transaction_type === type);
  return r ? r.label : type;
}
function memAvatar(m, size) {
  const s = 'width:' + size + 'px;height:' + size + 'px;';
  if (m && m.profile_photo_url) return '<img class="profile-photo" style="' + s + '" src="' + escHtml(m.profile_photo_url) + '" alt="">';
  return '<div class="profile-photo-initials" style="' + s + 'font-size:' + Math.round(size * 0.4) + 'px;">' + escHtml(getInitials(m && m.name)) + '</div>';
}

// Runs one of the member_* functions. Returns its result, or null
// after showing the database's own message ("Not enough points: ...").
async function memRpc(fn, args) {
  const { data, error } = await window.supabase.rpc(fn, args);
  if (error) { toast(error.message, true); return null; }
  (data.new_badges || []).forEach((name, i) => setTimeout(() => toast('🏅 New badge: ' + name), 600 * (i + 1)));
  return data;
}

async function memLoadCatalog(force) {
  if (memTiers.length && !force) return;
  const [tiers, rewards, rules, beers] = await Promise.all([
    window.supabase.from('tiers').select('*').order('rank'),
    window.supabase.from('rewards').select('*').order('level').order('points_cost').order('reward_name'),
    window.supabase.from('point_rules').select('*').order('id'),
    window.supabase.from('beers').select('id, name, style, abv, category, badges').eq('status', 'active').order('name'),
  ]);
  memTiers = tiers.data || [];
  memRewards = rewards.data || [];
  memRules = rules.data || [];
  // new releases first — they're the ones with a free pour attached
  memBeers = (beers.data || []).sort((a, b) => memIsNewRelease(b) - memIsNewRelease(a));
}
function memIsNewRelease(b) { return (b.badges || []).includes('new_release') ? 1 : 0; }

async function memFindMembers(term) {
  const clean = term.replace(/[,()%*\\]/g, ' ').trim();
  if (clean.length < 2 && !/^\d+$/.test(clean)) return [];
  let q = window.supabase.from('members').select(MEM_SELECT).order('name').limit(25);
  q = /^\d+$/.test(clean) ? q.eq('member_number', +clean) : q.or('name.ilike.%' + clean + '%,email.ilike.%' + clean + '%');
  const { data } = await q;
  return data || [];
}

async function memFetchMember(id) {
  const { data } = await window.supabase.from('members').select(MEM_SELECT).eq('id', id).maybeSingle();
  return data;
}

// ── ROUTER ───────────────────────────────────────────────
async function loadMembers() {
  await memLoadCatalog(true);
  setMembersView(memView);
}

function setMembersView(view) {
  memView = view;
  MEM_VIEWS.forEach((v) => document.getElementById('mem-view-' + v).classList.toggle('active', v === view));
  ({ checkin: memRenderCheckin, rewards: memRenderRewards, members: memRenderMembers, catalog: memRenderCatalog, reports: memRenderReports })[view]();
}

function memBody(html) { document.getElementById('mem-body').innerHTML = html; }

// ── CHECK-IN ─────────────────────────────────────────────
function memRenderCheckin() {
  memBody(
    '<div class="grid-4">'
    + '<div class="card"><div class="card-title">Members Today</div><div class="card-value teal" id="mem-stat-today">–</div><div class="card-sub">check-ins</div></div>'
    + '<div class="card"><div class="card-title">Total Members</div><div class="card-value" id="mem-stat-total">–</div><div class="card-sub">active accounts</div></div>'
    + '<div class="card"><div class="card-title">Points Awarded</div><div class="card-value amber" id="mem-stat-pts">–</div><div class="card-sub">today</div></div>'
    + '<div class="card"><div class="card-title">Free Pours</div><div class="card-value" id="mem-stat-pours">–</div><div class="card-sub">given today</div></div>'
    + '</div>'
    + '<div class="lookup-toolbar">'
    + '<input class="search-bar" type="text" id="mem-search" placeholder="Search by name, email or member #..." oninput="memSearchInput(this.value)">'
    + '<button class="btn btn-scan" onclick="memOpenScanner()">Scan QR</button>'
    + '<button class="btn btn-secondary" onclick="memClearMember()">Clear</button>'
    + '</div>'
    + '<div class="lookup-wrap"><div>'
    + '<div class="checkin-flash" id="mem-flash"></div>'
    + '<div id="mem-profile"></div>'
    + '<div class="table-wrap" id="mem-results"><div class="loading">Search or scan a member to begin</div></div>'
    + '</div><div>'
    + '<div class="leaderboard-card" style="margin-bottom:16px;">'
    + '<div class="leaderboard-header" style="display:flex;justify-content:space-between;align-items:center;">Top Check-Ins'
    + '<span><button class="sub-tab" style="padding:0 8px;" id="mem-lb-month" onclick="memSetLbPeriod(\'month\')">This Month</button>'
    + '<button class="sub-tab" style="padding:0 8px;" id="mem-lb-all" onclick="memSetLbPeriod(\'all\')">All Time</button></span></div>'
    + '<div id="mem-leaderboard"><div class="loading" style="padding:16px;">Loading...</div></div></div>'
    + '<div class="section-label" style="margin-top:0;">Today\'s Check-Ins</div>'
    + '<div class="card" id="mem-today"><div class="loading">Loading...</div></div>'
    + '</div></div>'
  );
  memLoadDaySummary();
  memLoadLeaderboard();
  if (memMember) memOpenMember(memMember.id);
}

async function memLoadDaySummary() {
  const since = memDayStart();
  const [total, checkins, pours, tx] = await Promise.all([
    window.supabase.from('members').select('id', { count: 'exact', head: true }).eq('is_active', true),
    window.supabase.from('check_ins').select('id, kind, points_awarded, checked_in_at, free_pour_beer, members(name, tiers(name))').gte('checked_in_at', since).order('checked_in_at', { ascending: false }),
    window.supabase.from('free_pours').select('id', { count: 'exact', head: true }).gte('poured_at', since),
    window.supabase.from('points_transactions').select('points').gte('created_at', since).gt('points', 0),
  ]);
  if (memView !== 'checkin') return;
  const rows = checkins.data || [];
  document.getElementById('mem-stat-total').textContent = total.count ?? '–';
  document.getElementById('mem-stat-today').textContent = rows.length;
  document.getElementById('mem-stat-pours').textContent = pours.count ?? '–';
  document.getElementById('mem-stat-pts').textContent = (tx.data || []).reduce((a, t) => a + t.points, 0);
  document.getElementById('mem-today').innerHTML = rows.length ? rows.slice(0, 12).map((c) =>
    '<div class="checkin-row"><div>'
    + '<div class="checkin-name">' + escHtml((c.members && c.members.name) || 'Unknown') + '</div>'
    + '<div class="checkin-time">' + memTime(c.checked_in_at) + ' · ' + memTierPill(c.members) + (c.kind === 'dd' ? ' <span class="badge badge-purple">DD</span>' : '') + '</div>'
    + (c.free_pour_beer ? '<div class="checkin-pour">Free pour: ' + escHtml(c.free_pour_beer) + '</div>' : '')
    + '</div><div class="checkin-pts">+' + c.points_awarded + '</div></div>').join('')
    : '<div class="loading">No check-ins today yet</div>';
}

function memSetLbPeriod(p) { memLbPeriod = p; memLoadLeaderboard(); }

async function memLoadLeaderboard() {
  const el = document.getElementById('mem-leaderboard');
  if (!el) return;
  document.getElementById('mem-lb-month').classList.toggle('active', memLbPeriod === 'month');
  document.getElementById('mem-lb-all').classList.toggle('active', memLbPeriod === 'all');
  let q = window.supabase.from('check_ins').select('member_id, members(id, name, profile_photo_url, tiers(name, rank))').limit(10000);
  if (memLbPeriod === 'month') { const n = new Date(); q = q.gte('checked_in_at', new Date(n.getFullYear(), n.getMonth(), 1).toISOString()); }
  const { data, error } = await q;
  if (error) { el.innerHTML = '<div class="loading" style="padding:16px;">Could not load</div>'; return; }
  const counts = {}; const info = {};
  (data || []).forEach((r) => { counts[r.member_id] = (counts[r.member_id] || 0) + 1; if (r.members) info[r.member_id] = r.members; });
  const top = Object.keys(counts).sort((a, b) => counts[b] - counts[a]).slice(0, 10);
  el.innerHTML = top.length ? top.map((id, i) => {
    const m = info[id] || { name: 'Unknown' };
    return '<div class="lb-row" onclick="memOpenMember(\'' + id + '\')">'
      + '<div class="lb-rank' + (i < 3 ? ' top' : '') + '">' + (i + 1) + '</div>' + memAvatar(m, 32)
      + '<div style="flex:1;min-width:0;"><div style="font-size:13px;font-weight:500;">' + escHtml(m.name) + '</div><div>' + memTierPill(m) + '</div></div>'
      + '<div style="text-align:right;"><div class="lb-count">' + counts[id] + '</div><div class="lb-count-label">visits</div></div></div>';
  }).join('') : '<div class="loading" style="padding:16px;">No check-ins ' + (memLbPeriod === 'month' ? 'this month ' : '') + 'yet</div>';
}

function memSearchInput(val) {
  clearTimeout(memSearchTimer);
  memSearchTimer = setTimeout(async () => {
    const results = document.getElementById('mem-results');
    document.getElementById('mem-profile').innerHTML = '';
    memMember = null;
    results.style.display = 'block';
    if (!val.trim()) { results.innerHTML = '<div class="loading">Search or scan a member to begin</div>'; return; }
    const found = await memFindMembers(val);
    if (!found.length) { results.innerHTML = '<div class="loading">No members found</div>'; return; }
    if (found.length === 1) { memOpenMember(found[0].id); return; }
    results.innerHTML = '<table><thead><tr><th>#</th><th>Name</th><th>Email</th><th>Tier</th><th>Balance</th></tr></thead><tbody>'
      + found.map((m) => '<tr style="cursor:pointer;" onclick="memOpenMember(\'' + m.id + '\')">'
        + '<td style="font-family:\'DM Mono\',monospace;">' + m.member_number + '</td><td>' + escHtml(m.name) + (m.is_active ? '' : ' <span class="badge badge-red">Inactive</span>') + '</td>'
        + '<td style="font-family:\'DM Mono\',monospace;font-size:12px;color:var(--sub);">' + escHtml(m.email) + '</td>'
        + '<td>' + memTierPill(m) + '</td><td style="font-family:\'DM Mono\',monospace;">' + m.points_balance + '</td></tr>').join('')
      + '</tbody></table>';
  }, 300);
}

function memClearMember() {
  memMember = null;
  if (memView !== 'checkin') return;
  document.getElementById('mem-search').value = '';
  document.getElementById('mem-profile').innerHTML = '';
  document.getElementById('mem-flash').classList.remove('visible');
  const results = document.getElementById('mem-results');
  results.style.display = 'block';
  results.innerHTML = '<div class="loading">Search or scan a member to begin</div>';
}

function memFlash(msg) {
  const el = document.getElementById('mem-flash');
  if (!el) return;
  el.textContent = msg;
  el.classList.add('visible');
}

// Opens a member on the Check-In page and draws their whole card.
async function memOpenMember(id) {
  if (memView !== 'checkin') { memMember = { id }; setMembersView('checkin'); return; }
  const since = memDayStart();
  const [m, checkins, today, journal, pours, badges, ledger] = await Promise.all([
    memFetchMember(id),
    window.supabase.from('check_ins').select('id', { count: 'exact', head: true }).eq('member_id', id),
    window.supabase.from('check_ins').select('id, kind, points_awarded').eq('member_id', id).gte('checked_in_at', since).limit(1),
    window.supabase.from('member_beers').select('beer_id, beer_name').eq('member_id', id),
    window.supabase.from('free_pours').select('beer_id').eq('member_id', id),
    window.supabase.from('member_badges').select('earned_at, badges(name, description, rarity, border_color)').eq('member_id', id).order('earned_at', { ascending: false }),
    window.supabase.from('points_transactions').select('transaction_type, points, notes, created_at').eq('member_id', id).order('created_at', { ascending: false }).limit(8),
  ]);
  if (!m) { toast('Member not found', true); return; }
  if (memView !== 'checkin') return;
  memMember = m;
  document.getElementById('mem-results').style.display = 'none';

  const checkedIn = (today.data || []).length > 0;
  const tried = new Set((journal.data || []).map((j) => j.beer_name.toLowerCase()));
  const poured = new Set((pours.data || []).map((p) => p.beer_id));
  const off = m.is_active ? '' : ' disabled style="opacity:0.4;"';

  const badgeHtml = (badges.data || []).length ? (badges.data || []).map((b) =>
    '<span class="badge" title="' + escHtml((b.badges.description || '') + ' · earned ' + memDate(b.earned_at)) + '" style="border:1px solid ' + escHtml(b.badges.border_color || 'var(--border)') + ';color:var(--text);padding:4px 10px;margin:0 6px 6px 0;">'
    + escHtml(b.badges.name) + '</span>').join('')
    : '<span style="font-size:12px;color:var(--muted);">No badges yet</span>';

  const beerHtml = memBeers.length ? memBeers.map((b) => {
    const isNew = !!memIsNewRelease(b); const hadPour = poured.has(b.id); const hasTried = tried.has(b.name.toLowerCase());
    const id2 = "'" + b.id + "'";
    return '<div class="beer-tile' + (isNew ? ' new-release' : '') + '">'
      + (isNew ? '<div class="pour-badge ' + (hadPour ? 'done">Free pour used' : 'new">New release · free pour') + '</div>' : '')
      + '<div class="beer-name">' + escHtml(b.name) + '</div><div class="beer-style">' + escHtml(b.style || '') + '</div>'
      + '<div class="beer-abv">' + (b.abv ? b.abv + '% ABV' : '') + '</div>'
      + (isNew && !hadPour ? '<button class="btn-pour"' + (m.is_active ? '' : ' disabled') + ' onclick="memFreePour(' + id2 + ')">Give Free Pour</button>' : '')
      + '<button class="btn-pour" style="background:var(--raised);color:' + (hasTried ? 'var(--muted)' : 'var(--teal)') + ';border:1px solid var(--border);"' + (hasTried || !m.is_active ? ' disabled' : '') + ' onclick="memLogBeer(' + id2 + ')">' + (hasTried ? '✓ In journal' : 'Log as tried') + '</button>'
      + '</div>';
  }).join('') : '<div class="loading" style="grid-column:1/-1;">No active beers on the tap list</div>';

  const ledgerHtml = (ledger.data || []).length ? (ledger.data || []).map((t) =>
    '<div class="rdm-row"><div><div class="rdm-name" style="font-size:13px;">' + escHtml(memRuleLabel(t.transaction_type)) + '</div>'
    + '<div class="rdm-meta">' + memDate(t.created_at, { month: 'short', day: 'numeric' }) + (t.notes ? ' · ' + escHtml(t.notes) : '') + '</div></div>'
    + '<div class="rdm-pts" style="font-size:17px;color:' + (t.points < 0 ? 'var(--amber)' : 'var(--teal)') + ';">' + (t.points > 0 ? '+' : '') + t.points + '</div></div>').join('')
    : '<div class="loading">No activity yet</div>';

  document.getElementById('mem-profile').innerHTML =
    '<div class="member-profile visible">'
    + '<div class="profile-header"><div class="profile-header-left">' + memAvatar(m, 56)
    + '<div><div class="profile-name">' + escHtml(m.name) + '</div><div class="profile-email">' + escHtml(m.email) + '</div>'
    + '<div style="margin-top:6px;">' + memTierPill(m) + (m.is_active ? '' : ' <span class="badge badge-red">Inactive</span>') + '</div></div></div>'
    + '<div style="background:var(--raised);border:2px solid var(--teal);border-radius:8px;padding:8px 14px;text-align:center;">'
    + '<div class="stat-label" style="margin-bottom:3px;">Member #</div>'
    + '<div style="font-family:\'Bebas Neue\',sans-serif;font-size:26px;color:var(--teal);letter-spacing:1px;line-height:1;">' + m.member_number + '</div>'
    + '<div style="font-size:10px;font-family:\'DM Mono\',monospace;color:var(--sub);margin-top:2px;">enter as table #</div></div></div>'
    + '<div class="profile-stats">'
    + '<div class="stat-box"><div class="stat-label">Balance</div><div class="stat-val" style="color:var(--teal);">' + m.points_balance + '</div></div>'
    + '<div class="stat-box"><div class="stat-label">Lifetime</div><div class="stat-val">' + m.points_earned_lifetime + '</div></div>'
    + '<div class="stat-box"><div class="stat-label">Member Since</div><div class="stat-val" style="font-size:16px;padding-top:4px;">' + memDate(m.joined_at, { month: 'short', year: 'numeric' }) + '</div></div>'
    + '<div class="stat-box"><div class="stat-label">Check-Ins</div><div class="stat-val">' + (checkins.count || 0) + '</div></div>'
    + '</div>'
    + '<div class="profile-actions">'
    + (checkedIn
      ? '<span class="badge badge-teal" style="padding:8px 14px;font-size:12px;">✓ Checked in today' + (today.data[0].kind === 'dd' ? ' · DD' : '') + ' · +' + today.data[0].points_awarded + '</span>'
      : '<button class="btn btn-primary"' + off + ' onclick="memCheckIn(\'standard\')">Check In</button>'
        + '<button class="btn btn-dd"' + off + ' onclick="memCheckIn(\'dd\')">DD Mode</button>')
    + '<button class="btn btn-secondary"' + off + ' onclick="setMembersView(\'rewards\')">Redeem Reward</button>'
    + '<button class="btn btn-secondary" onclick="memEditCurrent()">Edit</button>'
    + '</div>'
    + '<div class="tap-list-title" style="margin-top:24px;">Badges</div><div>' + badgeHtml + '</div>'
    + '<div class="tap-list-title" style="margin-top:20px;">On Tap — Free Pours &amp; Beer Journal (' + tried.size + ' tried)</div><div class="tap-grid">' + beerHtml + '</div>'
    + '<div class="tap-list-title" style="margin-top:24px;">Recent Activity</div><div>' + ledgerHtml + '</div>'
    + '</div>';
}

function memAfterChange() {
  memLoadDaySummary();
  memLoadLeaderboard();
  if (memMember) memOpenMember(memMember.id);
}

async function memCheckIn(kind) {
  if (!memMember) return;
  const res = await memRpc('member_check_in', { p_member: memMember.id, p_kind: kind });
  if (!res) return;
  if (res.already) { memFlash(memMember.name + ' is already checked in today'); toast('Already checked in today'); }
  else {
    memFlash('✓ ' + (kind === 'dd' ? 'DD check-in — thank you for driving' : 'Checked in') + ' · ' + res.label + ' · +' + res.points + ' pts · ' + memTime(new Date()));
    toast('✓ ' + memMember.name + ' checked in · +' + res.points + ' pts');
  }
  memAfterChange();
}

async function memFreePour(beerId) {
  if (!memMember) return;
  const res = await memRpc('member_free_pour', { p_member: memMember.id, p_beer: beerId });
  if (!res) return;
  const pts = (res.checkin.points || 0) + (res.journal.points || 0);
  memFlash('Free pour logged — ' + res.beer + (res.checkin.already ? '' : ' · checked in') + (pts ? ' · +' + pts + ' pts' : ''));
  toast('Free pour logged — ' + res.beer);
  memAfterChange();
}

async function memLogBeer(beerId) {
  if (!memMember) return;
  const res = await memRpc('member_log_beer', { p_member: memMember.id, p_beer: beerId });
  if (!res) return;
  toast(res.already ? 'Already in their journal' : 'Added to journal' + (res.points ? ' · +' + res.points + ' pts' : ''));
  memAfterChange();
}

function memEditCurrent() {
  memAdminMember = memMember;
  setMembersView('members');
}

// ── QR SCANNER ───────────────────────────────────────────
// ZXing is only fetched the first time someone scans.
function memLoadZxing() {
  if (window.ZXing) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://unpkg.com/@zxing/library@0.21.3/umd/index.min.js';
    s.onload = resolve; s.onerror = reject;
    document.head.appendChild(s);
  });
}

async function memOpenScanner() {
  let overlay = document.getElementById('mem-scanner');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'mem-scanner';
    overlay.className = 'scanner-overlay';
    overlay.innerHTML = '<div class="scanner-box"><video id="mem-scanner-video" autoplay playsinline muted></video>'
      + '<div class="scanner-corner tl"></div><div class="scanner-corner tr"></div><div class="scanner-corner bl"></div><div class="scanner-corner br"></div><div class="scanner-line"></div></div>'
      + '<div class="scanner-label">POINT AT MEMBER QR CODE</div><div class="scanner-status" id="mem-scanner-status"></div>'
      + '<div class="scanner-btn-row"><button class="btn-cancel" onclick="memCloseScanner()">Cancel</button></div>';
    document.body.appendChild(overlay);
  }
  overlay.classList.add('active');
  const status = document.getElementById('mem-scanner-status');
  status.textContent = 'Starting camera...';
  try {
    await memLoadZxing();
    memScanner = new ZXing.BrowserQRCodeReader();
    status.textContent = 'Ready — point at QR code';
    memScanner.decodeFromVideoDevice(null, 'mem-scanner-video', (result) => { if (result) memScanned(result.getText()); });
  } catch (e) {
    status.textContent = 'Could not start the camera';
  }
}

let memScanBusy = false;
async function memScanned(token) {
  if (memScanBusy) return;
  memScanBusy = true;
  const status = document.getElementById('mem-scanner-status');
  status.textContent = 'Looking up member...';
  const { data } = await window.supabase.from('qr_tokens').select('member_id').eq('token', token.trim()).maybeSingle();
  memScanBusy = false;
  if (!data) { status.textContent = 'Code not recognized — try again'; return; }
  memCloseScanner();
  // a scan is a check-in: the member is standing at the bar
  memMember = { id: data.member_id };
  if (memView !== 'checkin') setMembersView('checkin');
  await memOpenMember(data.member_id);
  if (memMember && memMember.is_active) memCheckIn('standard');
}

function memCloseScanner() {
  if (memScanner) { try { memScanner.reset(); } catch (e) { /* camera already released */ } memScanner = null; }
  const overlay = document.getElementById('mem-scanner');
  if (overlay) overlay.classList.remove('active');
}

// ── REWARDS ──────────────────────────────────────────────
function memLimitText(r) {
  const parts = [];
  if (r.limit_count) parts.push(r.limit_count + ' per ' + r.limit_period + (r.limit_scope === 'brewery' ? ', brewery-wide' : ''));
  if (!r.repeatable) parts.push('one time only');
  if (r.paid_only) parts.push('paid members');
  return parts.join(' · ');
}

async function memRenderRewards() {
  if (memMember && memMember.id) memMember = await memFetchMember(memMember.id);
  if (memView !== 'rewards') return;
  const m = memMember && memMember.name ? memMember : null;
  const active = memRewards.filter((r) => r.is_active);

  const rewardRows = active.length ? [1, 2, 3, 4, 5].map((lvl) => {
    const rows = active.filter((r) => r.level === lvl);
    if (!rows.length) return '';
    return '<div class="section-label">Level ' + lvl + ' — ' + MEM_LEVELS[lvl] + '</div><div class="table-wrap">' + rows.map((r) => {
      let why = '';
      if (!m) why = 'Pick a member';
      else if (!m.is_active) why = 'Inactive';
      else if (r.paid_only && !memIsPaid(m)) why = 'Paid members only';
      else if (m.points_balance < r.points_cost) why = 'Needs ' + (r.points_cost - m.points_balance) + ' more';
      return '<div class="reward-row" style="border-top:none;border-bottom:1px solid var(--border);gap:12px;">'
        + '<div style="flex:1;"><div class="reward-name">' + escHtml(r.reward_name) + '</div><div class="reward-tier-sub">' + escHtml(memLimitText(r) || 'No limit') + '</div></div>'
        + '<div class="reward-cost">' + r.points_cost + '</div>'
        + '<button class="btn btn-sm ' + (why ? 'btn-secondary' : 'btn-primary') + '" style="min-width:150px;"' + (why ? ' disabled' : '') + ' onclick="memRedeem(\'' + r.id + '\')">' + (why || 'Redeem') + '</button></div>';
    }).join('') + '</div>';
  }).join('') : '<div class="loading">No active rewards — add some under Catalog</div>';

  memBody(
    '<div class="grid-2" style="grid-template-columns:3fr 2fr;align-items:start;"><div>'
    + '<div class="card" style="margin-bottom:8px;">'
    + '<div class="card-title">Member</div>'
    + (m
      ? '<div style="display:flex;align-items:center;gap:12px;">' + memAvatar(m, 44)
        + '<div style="flex:1;"><div style="font-weight:600;">' + escHtml(m.name) + ' <span style="color:var(--muted);font-family:\'DM Mono\',monospace;font-size:12px;">#' + m.member_number + '</span></div><div style="margin-top:4px;">' + memTierPill(m) + '</div></div>'
        + '<div style="text-align:right;"><div class="card-value teal">' + m.points_balance + '</div><div class="card-sub">points</div></div>'
        + '<button class="btn btn-secondary btn-sm" onclick="memMember=null;memRenderRewards()">Change</button></div>'
      : '<input class="search-bar" style="width:100%;" type="text" placeholder="Search by name, email or member #..." oninput="memRewardSearch(this.value)">'
        + '<div class="dropdown-results" id="mem-rw-results"></div>')
    + '<div class="admin-field" style="margin:14px 0 0;"><label class="admin-label">Notes for this redemption (optional)</label>'
    + '<input class="admin-input" type="text" id="mem-rw-notes" placeholder="e.g. size, color, embroidered name..."></div>'
    + '</div>' + rewardRows
    + '</div><div>'
    + '<div class="section-label" style="margin-top:0;">Recent Redemptions</div><div class="card" id="mem-rw-log"><div class="loading">Loading...</div></div>'
    + '</div></div>'
  );
  memLoadRedemptionLog();
}

function memRewardSearch(val) {
  clearTimeout(memSearchTimer);
  memSearchTimer = setTimeout(async () => {
    const el = document.getElementById('mem-rw-results');
    if (!el) return;
    const found = await memFindMembers(val);
    el.style.display = found.length ? 'block' : 'none';
    el.innerHTML = found.map((m) => '<div class="dropdown-item" onclick="memMember={id:\'' + m.id + '\'};memRenderRewards()">'
      + '<span>' + escHtml(m.name) + ' <span style="margin-left:8px;">' + memTierPill(m) + '</span></span>'
      + '<span style="font-family:\'DM Mono\',monospace;font-size:12px;color:var(--teal);">' + m.points_balance + ' pts</span></div>').join('');
  }, 300);
}

async function memRedeem(rewardId) {
  const r = memRewards.find((x) => x.id === rewardId);
  if (!memMember || !r) return;
  if (!confirm('Redeem "' + r.reward_name + '" for ' + memMember.name + '?\n\n' + r.points_cost + ' points will come off their balance.')) return;
  const res = await memRpc('member_redeem', { p_member: memMember.id, p_reward: rewardId, p_notes: document.getElementById('mem-rw-notes').value });
  if (!res) return;
  toast('✓ Redeemed · ' + res.reward + ' · ' + res.balance + ' pts left');
  memRenderRewards();
}

function memRedemptionRows(rows, showMember) {
  return rows.map((r) => '<div class="rdm-row"><div>'
    + '<div class="rdm-name">' + escHtml(showMember ? ((r.members && r.members.name) || 'Unknown') : r.reward_name) + '</div>'
    + (showMember ? '<div class="rdm-meta">' + (r.reward_level ? '<span class="tier-pill">L' + r.reward_level + '</span>' : '') + escHtml(r.reward_name) + (r.notes ? ' · ' + escHtml(r.notes) : '') + '</div>' : '')
    + '<div class="rdm-meta">' + memDate(r.redeemed_at) + (r.processed_by ? ' · ' + escHtml(r.processed_by) : '') + (!showMember && r.notes ? ' · ' + escHtml(r.notes) : '') + '</div>'
    + '</div><div class="rdm-pts">-' + r.points_spent + '</div></div>').join('');
}

async function memLoadRedemptionLog() {
  const { data } = await window.supabase.from('redemptions').select('*, members(name)').order('redeemed_at', { ascending: false }).limit(12);
  const el = document.getElementById('mem-rw-log');
  if (el) el.innerHTML = (data || []).length ? memRedemptionRows(data, true) : '<div class="loading">No redemptions yet</div>';
}

// ── MEMBERS (admin) ──────────────────────────────────────
function memTierOptions(selected) {
  return memTiers.map((t) => '<option value="' + t.id + '"' + (t.id === selected ? ' selected' : '') + '>' + escHtml(t.name) + '</option>').join('');
}

function memField(label, inner, full) {
  return '<div class="admin-field"' + (full ? ' style="grid-column:1/-1;"' : '') + '><label class="admin-label">' + label + '</label>' + inner + '</div>';
}

function memRenderMembers() {
  memBody(
    '<div class="grid-2" style="margin-bottom:16px;align-items:start;">'
    + '<div class="card"><div class="card-title" style="margin-bottom:16px;">Add New Member</div>'
    + '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">'
    + memField('Name', '<input class="admin-input" type="text" id="mem-new-name" placeholder="Full name">')
    + memField('Email', '<input class="admin-input" type="email" id="mem-new-email" placeholder="email@example.com">')
    + memField('Phone', '<input class="admin-input" type="text" id="mem-new-phone" placeholder="512-555-0100">')
    + memField('Birthday', '<input class="admin-input" type="date" id="mem-new-birthday">')
    + memField('Membership Tier', '<select class="admin-select" id="mem-new-tier">' + memTierOptions(memTiers[0] && memTiers[0].id) + '</select>')
    + '</div><button class="btn btn-primary" onclick="memAddMember()">Create Member</button></div>'
    + '<div class="card"><div class="card-title" style="margin-bottom:4px;">All Members</div>'
    + '<div class="card-sub" style="margin-bottom:12px;">Click a row to edit</div>'
    + '<input class="search-bar" style="margin-bottom:12px;width:100%;" type="text" placeholder="Search by name, email or member #..." oninput="memAdminSearch(this.value)">'
    + '<div id="mem-admin-list" style="max-height:340px;overflow-y:auto;"><div class="loading">Loading...</div></div></div>'
    + '</div><div id="mem-admin-edit"></div>'
  );
  memAdminList();
  if (memAdminMember) memAdminOpen(memAdminMember.id);
}

async function memAdminList(term) {
  const el = document.getElementById('mem-admin-list');
  let rows;
  if (term && term.trim()) rows = await memFindMembers(term);
  else rows = (await window.supabase.from('members').select(MEM_SELECT).order('name').limit(500)).data || [];
  if (!el || memView !== 'members') return;
  el.innerHTML = rows.length ? '<table><thead><tr><th>#</th><th>Name</th><th>Tier</th><th>Balance</th><th>Status</th></tr></thead><tbody>'
    + rows.map((m) => '<tr style="cursor:pointer;" onclick="memAdminOpen(\'' + m.id + '\')">'
      + '<td style="font-family:\'DM Mono\',monospace;">' + m.member_number + '</td>'
      + '<td>' + escHtml(m.name) + '<div style="font-family:\'DM Mono\',monospace;font-size:11px;color:var(--sub);">' + escHtml(m.email) + '</div></td>'
      + '<td>' + memTierPill(m) + '</td><td style="font-family:\'DM Mono\',monospace;">' + m.points_balance + '</td>'
      + '<td style="font-size:12px;color:' + (m.is_active ? 'var(--teal)' : 'var(--red)') + ';">' + (m.is_active ? 'Active' : 'Inactive') + '</td></tr>').join('')
    + '</tbody></table>' : '<div class="loading">No members found</div>';
}

function memAdminSearch(val) {
  clearTimeout(memSearchTimer);
  memSearchTimer = setTimeout(() => memAdminList(val), 300);
}

async function memAddMember() {
  const name = document.getElementById('mem-new-name').value.trim();
  const email = document.getElementById('mem-new-email').value.trim().toLowerCase();
  if (!name || !email) { toast('Name and email are required', true); return; }
  const { data, error } = await window.supabase.from('members').insert({
    name, email,
    phone: document.getElementById('mem-new-phone').value.trim() || null,
    birthday: document.getElementById('mem-new-birthday').value || null,
    tier_id: +document.getElementById('mem-new-tier').value,
  }).select('id, member_number').single();
  if (error) { toast(error.code === '23505' ? 'A member with that email already exists' : error.message, true); return; }
  toast('✓ Member #' + data.member_number + ' created — ' + name);
  memAdminMember = { id: data.id };
  memRenderMembers();
}

async function memAdminOpen(id) {
  const [m, checkins, pours, journal, token, badges, rdms, ledger] = await Promise.all([
    memFetchMember(id),
    window.supabase.from('check_ins').select('id', { count: 'exact', head: true }).eq('member_id', id),
    window.supabase.from('free_pours').select('id', { count: 'exact', head: true }).eq('member_id', id),
    window.supabase.from('member_beers').select('id', { count: 'exact', head: true }).eq('member_id', id),
    window.supabase.from('qr_tokens').select('token').eq('member_id', id).limit(1),
    window.supabase.from('member_badges').select('earned_at, badges(name)').eq('member_id', id).order('earned_at'),
    window.supabase.from('redemptions').select('*').eq('member_id', id).order('redeemed_at', { ascending: false }),
    window.supabase.from('points_transactions').select('transaction_type, points, notes, processed_by, created_at').eq('member_id', id).order('created_at', { ascending: false }).limit(15),
  ]);
  const el = document.getElementById('mem-admin-edit');
  if (!m || !el) return;
  memAdminMember = m;
  const summary = [
    ['Member #', m.member_number], ['Joined', memDate(m.joined_at)], ['Total Check-ins', checkins.count || 0],
    ['Free Pours Given', pours.count || 0], ['Beers in Journal', journal.count || 0],
    ['Points Balance', m.points_balance], ['Lifetime Points', m.points_earned_lifetime],
    ['Badges', (badges.data || []).map((b) => b.badges.name).join(', ') || '—'],
    ['QR Code', (token.data && token.data[0] && token.data[0].token) || '—'],
  ];
  const awardable = memRules.filter((r) => r.is_active && !r.transaction_type.startsWith('checkin_') && r.transaction_type !== 'manual_adjustment');

  el.innerHTML = '<div class="grid-2" style="align-items:start;"><div class="card">'
    + '<div class="menu-col-header"><div class="card-title" style="margin:0;">Edit Member Record</div>'
    + '<button class="btn btn-sm btn-secondary" onclick="memMember=memAdminMember;setMembersView(\'checkin\')">Open on Check-In</button></div>'
    + '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">'
    + memField('Name', '<input class="admin-input" type="text" id="mem-ed-name" value="' + escHtml(m.name) + '">')
    + memField('Email', '<input class="admin-input" type="email" id="mem-ed-email" value="' + escHtml(m.email) + '">')
    + memField('Phone', '<input class="admin-input" type="text" id="mem-ed-phone" value="' + escHtml(m.phone) + '">')
    + memField('Birthday', '<input class="admin-input" type="date" id="mem-ed-birthday" value="' + escHtml(m.birthday) + '">')
    + memField('Membership Tier', '<select class="admin-select" id="mem-ed-tier">' + memTierOptions(m.tier_id) + '</select>')
    + memField('Status', '<select class="admin-select" id="mem-ed-active"><option value="true"' + (m.is_active ? ' selected' : '') + '>Active</option><option value="false"' + (m.is_active ? '' : ' selected') + '>Inactive</option></select>')
    + '</div><button class="btn btn-primary" onclick="memSaveMember()">Save Changes</button>'

    + '<div style="margin-top:20px;padding-top:20px;border-top:1px solid var(--border);">'
    + '<div class="card-title" style="margin-bottom:12px;">Award Points</div>'
    + '<div style="display:flex;gap:12px;align-items:flex-end;">'
    + '<div class="admin-field" style="flex:1;margin-bottom:0;"><label class="admin-label">For</label><select class="admin-select" id="mem-award-type">'
    + awardable.map((r) => '<option value="' + r.transaction_type + '">' + escHtml(r.label) + ' (+' + r.points + ')</option>').join('') + '</select></div>'
    + '<button class="btn btn-secondary" onclick="memAward()">Award</button></div></div>'

    + '<div style="margin-top:20px;padding-top:20px;border-top:1px solid var(--border);">'
    + '<div class="card-title" style="margin-bottom:12px;">Manual Points Adjustment</div>'
    + '<div style="display:grid;grid-template-columns:140px 1fr;gap:12px;">'
    + memField('Points (+/-)', '<input class="admin-input" type="number" id="mem-adj-points" placeholder="50 or -50">')
    + memField('Reason', '<input class="admin-input" type="text" id="mem-adj-reason" placeholder="Why the balance is changing">')
    + '</div><button class="btn btn-secondary" onclick="memAdjust()">Apply Adjustment</button></div>'
    + '</div><div>'

    + '<div class="card" style="margin-bottom:16px;"><div class="card-title" style="margin-bottom:12px;">Member Summary</div>'
    + summary.map((s) => '<div class="admin-summary-row"><span>' + s[0] + '</span><span class="admin-summary-val" style="text-align:right;max-width:60%;overflow-wrap:anywhere;">' + escHtml(String(s[1])) + '</span></div>').join('') + '</div>'
    + '<div class="section-label">Redemption History</div><div class="card" style="margin-bottom:16px;">'
    + ((rdms.data || []).length ? memRedemptionRows(rdms.data, false) : '<div class="loading">No redemptions yet</div>') + '</div>'
    + '<div class="section-label">Points Ledger (last 15)</div><div class="card">'
    + ((ledger.data || []).length ? ledger.data.map((t) => '<div class="rdm-row"><div><div class="rdm-name" style="font-size:13px;">' + escHtml(memRuleLabel(t.transaction_type)) + '</div>'
      + '<div class="rdm-meta">' + memDate(t.created_at) + (t.processed_by ? ' · ' + escHtml(t.processed_by) : '') + (t.notes ? ' · ' + escHtml(t.notes) : '') + '</div></div>'
      + '<div class="rdm-pts" style="font-size:17px;color:' + (t.points < 0 ? 'var(--amber)' : 'var(--teal)') + ';">' + (t.points > 0 ? '+' : '') + t.points + '</div></div>').join('')
      : '<div class="loading">No activity yet</div>') + '</div>'
    + '</div></div>';
  el.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function memSaveMember() {
  if (!memAdminMember) return;
  const name = document.getElementById('mem-ed-name').value.trim();
  const email = document.getElementById('mem-ed-email').value.trim().toLowerCase();
  if (!name || !email) { toast('Name and email are required', true); return; }
  const active = document.getElementById('mem-ed-active').value === 'true';
  if (!active && memAdminMember.is_active && !confirm('Deactivate ' + memAdminMember.name + '? They will no longer be able to check in, earn or redeem.')) return;
  const { error } = await window.supabase.from('members').update({
    name, email,
    phone: document.getElementById('mem-ed-phone').value.trim() || null,
    birthday: document.getElementById('mem-ed-birthday').value || null,
    tier_id: +document.getElementById('mem-ed-tier').value,
    is_active: active,
  }).eq('id', memAdminMember.id);
  if (error) { toast(error.code === '23505' ? 'A member with that email already exists' : error.message, true); return; }
  toast('✓ Member record updated');
  memRenderMembers();
}

async function memAward() {
  if (!memAdminMember) return;
  const res = await memRpc('member_award_points', { p_member: memAdminMember.id, p_type: document.getElementById('mem-award-type').value });
  if (!res) return;
  toast('+' + res.points + ' pts awarded · balance ' + res.balance);
  memRenderMembers();
}

async function memAdjust() {
  if (!memAdminMember) return;
  const pts = parseInt(document.getElementById('mem-adj-points').value, 10);
  const res = await memRpc('member_award_points', {
    p_member: memAdminMember.id, p_type: 'manual_adjustment',
    p_points: isNaN(pts) ? 0 : pts, p_notes: document.getElementById('mem-adj-reason').value,
  });
  if (!res) return;
  toast((res.points > 0 ? '+' : '') + res.points + ' pts applied · balance ' + res.balance);
  memRenderMembers();
}

// ── CATALOG ──────────────────────────────────────────────
function memRuleText(b) {
  const p = b.rule_params || {};
  switch (b.rule_type) {
    case 'first_checkin': return 'First check-in';
    case 'checkin_count': return p.count + ' check-ins';
    case 'checkins_in_season': return p.count + '+ check-ins in ' + (p.months || []).map((n) => MEM_MONTHS[n - 1]).join('/');
    case 'unique_beers': return p.count + ' unique beers' + ((p.patterns || []).length ? ' with style matching ' + p.patterns.join(', ') : '');
    case 'lifetime_points': return p.points + ' lifetime points';
    case 'anniversary': return p.years + '-year anniversary';
    case 'tier': return 'While on ' + p.tier;
    case 'all_of': return 'Holds ' + (p.badges || []).join(', ');
    default: return 'No rule — never awarded automatically';
  }
}

async function memRenderCatalog() {
  await memLoadCatalog(true);
  const [badgesRes, heldRes] = await Promise.all([
    window.supabase.from('badges').select('*').order('category').order('name'),
    window.supabase.from('member_badges').select('badge_id'),
  ]);
  if (memView !== 'catalog') return;
  const badges = badgesRes.data || [];
  const held = {};
  (heldRes.data || []).forEach((r) => { held[r.badge_id] = (held[r.badge_id] || 0) + 1; });
  const byCat = {};
  badges.forEach((b) => { (byCat[b.category] = byCat[b.category] || []).push(b); });

  const rewardsHtml = memRewards.length ? '<div class="table-wrap">' + memRewards.map((r) =>
    '<div class="reward-admin-row"' + (r.is_active ? '' : ' style="opacity:0.5;"') + '><div><span class="tier-pill">L' + r.level + '</span><span style="font-weight:500;font-size:13px;">' + escHtml(r.reward_name) + '</span>'
    + '<div style="font-size:11px;color:var(--muted);font-family:\'DM Mono\',monospace;margin-top:2px;">' + escHtml(memLimitText(r) || 'no limit') + '</div></div>'
    + '<div style="display:flex;align-items:center;gap:10px;">'
    + '<input type="number" class="scoring-input" style="width:90px;" value="' + r.points_cost + '" id="mem-rw-cost-' + r.id + '">'
    + '<button class="scoring-save" onclick="memSaveRewardCost(\'' + r.id + '\')">Save</button>'
    + '<button class="btn btn-sm btn-secondary" style="min-width:76px;" onclick="memToggleReward(\'' + r.id + '\')">' + (r.is_active ? 'Disable' : 'Enable') + '</button>'
    + '</div></div>').join('') + '</div>' : '<div class="loading">No rewards yet</div>';

  const rulesHtml = '<div class="table-wrap">' + memRules.map((r) =>
    '<div class="scoring-row"' + (r.is_active ? '' : ' style="opacity:0.5;"') + '><div style="flex:1;"><div class="scoring-label">' + escHtml(r.label) + '</div><div class="scoring-desc">' + escHtml(r.description || r.transaction_type) + '</div></div>'
    + (r.transaction_type === 'manual_adjustment' ? '<span class="scoring-desc">amount entered each time</span>'
      : '<input type="number" class="scoring-input" value="' + r.points + '" id="mem-rule-' + r.id + '">'
        + '<button class="scoring-save" onclick="memSaveRule(' + r.id + ')">Save</button>'
        + (r.transaction_type === 'checkin_standard' ? '<span style="min-width:76px;"></span>'
          : '<button class="btn btn-sm btn-secondary" style="min-width:76px;" onclick="memToggleRule(' + r.id + ')">' + (r.is_active ? 'Disable' : 'Enable') + '</button>'))
    + '</div>').join('') + '</div>';

  const badgesHtml = badges.length ? Object.keys(byCat).map((cat) =>
    '<div class="section-label">' + escHtml(cat) + '</div><div class="table-wrap">' + byCat[cat].map((b) =>
      '<div class="badge-admin-row"' + (b.is_active ? '' : ' style="opacity:0.5;"') + '><div class="badge-color-dot" style="background:' + escHtml(b.border_color || 'var(--muted)') + ';"></div>'
      + '<div style="flex:1;"><div style="font-size:13px;font-weight:500;">' + escHtml(b.name) + '</div>'
      + '<div style="font-size:11px;color:var(--sub);font-family:\'DM Mono\',monospace;">' + escHtml(memRuleText(b)) + '</div></div>'
      + '<span class="scoring-desc">' + (held[b.id] || 0) + ' earned</span>'
      + '<span class="rarity-pill rarity-' + b.rarity.toLowerCase() + '">' + b.rarity + '</span>'
      + (b.is_secret ? '<span class="badge badge-purple">Secret</span>' : '')
      + '<button class="btn btn-sm btn-secondary" onclick="memToggleBadge(\'' + b.id + '\',' + !b.is_active + ')">' + (b.is_active ? 'Disable' : 'Enable') + '</button>'
      + '</div>').join('') + '</div>').join('') : '<div class="loading">No badges yet</div>';

  memBody(
    '<div class="grid-2" style="align-items:start;"><div>'
    + '<div class="section-label" style="margin-top:0;">Rewards</div>' + rewardsHtml
    + '<div class="section-label">Add Reward</div><div class="card">'
    + '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">'
    + memField('Reward Name', '<input class="admin-input" type="text" id="mem-rw-name" placeholder="e.g. LVBC Growler">')
    + memField('Level', '<select class="admin-select" id="mem-rw-level">' + [1, 2, 3, 4, 5].map((l) => '<option value="' + l + '">Level ' + l + ' — ' + MEM_LEVELS[l] + '</option>').join('') + '</select>')
    + memField('Points Cost', '<input class="admin-input" type="number" id="mem-rw-cost" placeholder="750">')
    + memField('Limit', '<div style="display:flex;gap:6px;"><input class="admin-input" style="width:64px;" type="number" min="1" id="mem-rw-limit" placeholder="–">'
      + '<select class="admin-select" id="mem-rw-period"><option value="month">per month</option><option value="quarter">per quarter</option><option value="year">per year</option></select>'
      + '<select class="admin-select" id="mem-rw-scope"><option value="member">each member</option><option value="brewery">brewery-wide</option></select></div>', true)
    + '</div>'
    + '<div class="checkbox-row"><input type="checkbox" id="mem-rw-repeat" checked><label for="mem-rw-repeat">A member can redeem it more than once</label></div>'
    + '<div class="checkbox-row"><input type="checkbox" id="mem-rw-paid"><label for="mem-rw-paid">Paid memberships only</label></div>'
    + '<button class="btn btn-primary" onclick="memAddReward()">Add Reward</button></div>'

    + '<div class="section-label">Scoring</div>'
    + '<div class="card-sub" style="margin-bottom:10px;">What each activity is worth. A change applies from the next check-in or award.</div>' + rulesHtml
    + '</div><div>'

    + '<div class="section-label" style="margin-top:0;">Badges</div>'
    + '<div class="card-sub" style="margin-bottom:4px;">Badges are awarded automatically the moment a member meets the rule.</div>' + badgesHtml
    + '<div class="section-label">Add Badge</div><div class="card">'
    + '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">'
    + memField('Badge Name', '<input class="admin-input" type="text" id="mem-bd-name" placeholder="e.g. Regular">')
    + memField('Category', '<select class="admin-select" id="mem-bd-cat">' + MEM_BADGE_CATEGORIES.map((c) => '<option>' + c + '</option>').join('') + '</select>')
    + memField('Rarity', '<select class="admin-select" id="mem-bd-rarity"><option>Standard</option><option>Rare</option><option>Exclusive</option></select>')
    + memField('Border Color', '<input class="admin-input" type="text" id="mem-bd-color" placeholder="#E8B84B">')
    + memField('Description (shown to members)', '<input class="admin-input" type="text" id="mem-bd-desc" placeholder="e.g. Check in 25 times">', true)
    + memField('Earned By', '<select class="admin-select" id="mem-bd-rule" onchange="memBadgeRuleFields()">'
      + Object.keys(MEM_RULE_TYPES).map((k) => '<option value="' + k + '">' + MEM_RULE_TYPES[k] + '</option>').join('') + '</select>', true)
    + '</div><div id="mem-bd-params" style="display:grid;grid-template-columns:1fr 1fr;gap:12px;"></div>'
    + '<div class="checkbox-row"><input type="checkbox" id="mem-bd-secret"><label for="mem-bd-secret">Secret badge — hidden from the catalog until earned</label></div>'
    + '<button class="btn btn-primary" onclick="memAddBadge()">Add Badge</button></div>'
    + '</div></div>'
  );
  memBadgeRuleFields();
}

function memBadgeRuleFields() {
  const inputs = {
    count: memField('How many', '<input class="admin-input" type="number" min="1" id="mem-bd-count" value="5">'),
    months: memField('Months (numbers, in season order)', '<input class="admin-input" type="text" id="mem-bd-months" placeholder="12, 1, 2">'),
    patterns: memField('Beer style contains (blank = any beer)', '<input class="admin-input" type="text" id="mem-bd-patterns" placeholder="ipa, india pale">'),
    points: memField('Lifetime points', '<input class="admin-input" type="number" min="1" id="mem-bd-points" value="1000">'),
    years: memField('Years', '<input class="admin-input" type="number" min="1" id="mem-bd-years" value="1">'),
    tier: memField('Tier', '<select class="admin-select" id="mem-bd-tier">' + memTiers.map((t) => '<option>' + escHtml(t.name) + '</option>').join('') + '</select>'),
    badges: memField('Badge names, comma separated', '<input class="admin-input" type="text" id="mem-bd-badges" placeholder="Spring Sipper, Summer Regular">', true),
  };
  document.getElementById('mem-bd-params').innerHTML = MEM_RULE_FIELDS[document.getElementById('mem-bd-rule').value].map((f) => inputs[f]).join('');
}

async function memSaveRewardCost(id) {
  const val = parseInt(document.getElementById('mem-rw-cost-' + id).value, 10);
  if (!val || val < 1) { toast('Enter a valid point cost', true); return; }
  const { error } = await window.supabase.from('rewards').update({ points_cost: val }).eq('id', id);
  if (error) { toast(error.message, true); return; }
  toast('✓ Reward updated');
  memRenderCatalog();
}

async function memToggleReward(id) {
  const r = memRewards.find((x) => x.id === id);
  const { error } = await window.supabase.from('rewards').update({ is_active: !r.is_active }).eq('id', id);
  if (error) { toast(error.message, true); return; }
  toast(r.is_active ? 'Reward disabled' : 'Reward enabled');
  memRenderCatalog();
}

async function memAddReward() {
  const name = document.getElementById('mem-rw-name').value.trim();
  const cost = parseInt(document.getElementById('mem-rw-cost').value, 10);
  const limit = parseInt(document.getElementById('mem-rw-limit').value, 10);
  if (!name || !cost || cost < 1) { toast('Name and points cost are required', true); return; }
  const { error } = await window.supabase.from('rewards').insert({
    reward_name: name, points_cost: cost, level: +document.getElementById('mem-rw-level').value,
    repeatable: document.getElementById('mem-rw-repeat').checked, paid_only: document.getElementById('mem-rw-paid').checked,
    limit_count: limit > 0 ? limit : null, limit_period: limit > 0 ? document.getElementById('mem-rw-period').value : null,
    limit_scope: document.getElementById('mem-rw-scope').value,
  });
  if (error) { toast(error.message, true); return; }
  toast('✓ Reward added');
  memRenderCatalog();
}

async function memSaveRule(id) {
  const val = parseInt(document.getElementById('mem-rule-' + id).value, 10);
  if (isNaN(val)) { toast('Enter a valid number', true); return; }
  const { error } = await window.supabase.from('point_rules').update({ points: val }).eq('id', id);
  if (error) { toast(error.message, true); return; }
  toast('✓ Scoring rule updated');
  memRenderCatalog();
}

async function memToggleRule(id) {
  const r = memRules.find((x) => x.id === id);
  const { error } = await window.supabase.from('point_rules').update({ is_active: !r.is_active }).eq('id', id);
  if (error) { toast(error.message, true); return; }
  toast(r.is_active ? 'Rule disabled' : 'Rule enabled');
  memRenderCatalog();
}

async function memToggleBadge(id, active) {
  const { error } = await window.supabase.from('badges').update({ is_active: active }).eq('id', id);
  if (error) { toast(error.message, true); return; }
  memRenderCatalog();
}

async function memAddBadge() {
  const val = (id) => { const el = document.getElementById(id); return el ? el.value.trim() : ''; };
  const list = (id) => val(id).split(',').map((s) => s.trim()).filter(Boolean);
  const name = val('mem-bd-name');
  const rule = val('mem-bd-rule');
  if (!name) { toast('Badge name is required', true); return; }
  const params = {};
  for (const f of MEM_RULE_FIELDS[rule]) {
    if (f === 'months') {
      params.months = list('mem-bd-months').map(Number).filter((n) => n >= 1 && n <= 12);
      if (!params.months.length) { toast('Enter the season\'s months as numbers, e.g. 6, 7, 8', true); return; }
    } else if (f === 'patterns') params.patterns = list('mem-bd-patterns').map((s) => s.toLowerCase());
    else if (f === 'badges') {
      params.badges = list('mem-bd-badges');
      if (!params.badges.length) { toast('List the badges this one requires', true); return; }
    } else if (f === 'tier') params.tier = val('mem-bd-tier');
    else {
      params[f] = parseInt(val('mem-bd-' + f), 10);
      if (!(params[f] > 0)) { toast('Enter a number greater than 0', true); return; }
    }
  }
  const { error } = await window.supabase.from('badges').insert({
    name, category: val('mem-bd-cat'), rarity: val('mem-bd-rarity'), border_color: val('mem-bd-color') || null,
    description: val('mem-bd-desc') || null, trigger_description: null,
    is_secret: document.getElementById('mem-bd-secret').checked, rule_type: rule, rule_params: params,
  });
  if (error) { toast(error.message, true); return; }
  toast('✓ Badge added — members earn it from their next activity');
  memRenderCatalog();
}

// ── REPORTS ──────────────────────────────────────────────
function memRenderReports() {
  const now = new Date();
  memBody(
    '<div style="display:flex;gap:8px;margin-bottom:20px;flex-wrap:wrap;">'
    + Object.keys(MEM_REPORTS).map((k) => '<button class="tap-toggle-btn' + (k === memReport ? ' active' : '') + '" onclick="memReport=\'' + k + '\';memRenderReports()">' + MEM_REPORTS[k] + '</button>').join('')
    + '</div><div style="display:flex;gap:12px;margin-bottom:20px;align-items:center;flex-wrap:wrap;">'
    + '<label class="form-label">From</label><input class="form-input" type="date" id="mem-rep-from" style="width:160px;" value="' + (memReportData ? memReportData.from : toDateStr(new Date(now.getFullYear(), now.getMonth(), 1))) + '">'
    + '<label class="form-label">To</label><input class="form-input" type="date" id="mem-rep-to" style="width:160px;" value="' + (memReportData ? memReportData.to : toDateStr(now)) + '">'
    + '<button class="btn btn-primary" onclick="memRunReport()">Run Report</button>'
    + '<button class="btn btn-secondary" onclick="memReportCsv()">Download CSV</button>'
    + '</div><div id="mem-rep-out"><div class="loading">Pick a date range and run the report</div></div>'
  );
}

async function memRunReport() {
  const from = document.getElementById('mem-rep-from').value;
  const to = document.getElementById('mem-rep-to').value;
  if (!from || !to) { toast('Select a date range', true); return; }
  const a = new Date(from + 'T00:00:00').toISOString();
  const b = new Date(to + 'T23:59:59.999').toISOString();
  const out = document.getElementById('mem-rep-out');
  out.innerHTML = '<div class="loading">Loading...</div>';
  const sb = window.supabase;
  const nm = (r) => (r.members && r.members.name) || 'Unknown';
  let summary = []; let cols = []; let rows = []; let res;

  if (memReport === 'checkins') {
    res = await sb.from('check_ins').select('checked_in_at, kind, points_awarded, free_pour_beer, members(name, tiers(name))').gte('checked_in_at', a).lte('checked_in_at', b).order('checked_in_at', { ascending: false });
    const d = res.data || [];
    summary = [['Check-Ins', d.length], ['Points Awarded', d.reduce((x, r) => x + r.points_awarded, 0)], ['DD Check-Ins', d.filter((r) => r.kind === 'dd').length], ['Free Pours', d.filter((r) => r.free_pour_beer).length]];
    cols = ['Member', 'Tier', 'Date', 'Time', 'Type', 'Free Pour', 'Points'];
    rows = d.map((r) => [nm(r), memTierName(r.members), memDate(r.checked_in_at), memTime(r.checked_in_at), r.kind === 'dd' ? 'DD' : 'Standard', r.free_pour_beer || '', r.points_awarded]);
  } else if (memReport === 'points') {
    res = await sb.from('points_transactions').select('created_at, transaction_type, points, notes, processed_by, members(name)').gte('created_at', a).lte('created_at', b).order('created_at', { ascending: false });
    const d = res.data || [];
    summary = [['Transactions', d.length], ['Points Earned', d.filter((r) => r.points > 0).reduce((x, r) => x + r.points, 0)], ['Points Spent', -d.filter((r) => r.points < 0).reduce((x, r) => x + r.points, 0)]];
    cols = ['Member', 'Type', 'Points', 'Notes', 'Staff', 'Date'];
    rows = d.map((r) => [nm(r), memRuleLabel(r.transaction_type), r.points, r.notes || '', r.processed_by || '', memDate(r.created_at)]);
  } else if (memReport === 'topearners') {
    res = await sb.from('points_transactions').select('member_id, points, members(name, tiers(name))').gte('created_at', a).lte('created_at', b).gt('points', 0);
    const totals = {}; const info = {};
    (res.data || []).forEach((r) => { totals[r.member_id] = (totals[r.member_id] || 0) + r.points; info[r.member_id] = r.members; });
    cols = ['Rank', 'Member', 'Tier', 'Points Earned'];
    rows = Object.keys(totals).sort((x, y) => totals[y] - totals[x]).slice(0, 20).map((id, i) => [i + 1, (info[id] && info[id].name) || 'Unknown', memTierName(info[id]), totals[id]]);
    summary = [['Members Earning', Object.keys(totals).length]];
  } else if (memReport === 'redemptions') {
    res = await sb.from('redemptions').select('*, members(name)').gte('redeemed_at', a).lte('redeemed_at', b).order('redeemed_at', { ascending: false });
    const d = res.data || [];
    summary = [['Redemptions', d.length], ['Points Redeemed', d.reduce((x, r) => x + r.points_spent, 0)]];
    cols = ['Member', 'Reward', 'Level', 'Points', 'Staff', 'Notes', 'Date'];
    rows = d.map((r) => [nm(r), r.reward_name, r.reward_level || '', r.points_spent, r.processed_by || '', r.notes || '', memDate(r.redeemed_at)]);
  } else {
    res = await sb.from('members').select('member_number, name, email, points_balance, joined_at, tiers(name)').gte('joined_at', a).lte('joined_at', b).order('joined_at', { ascending: false });
    const d = res.data || [];
    summary = [['New Members', d.length], ['On a Paid Tier', d.filter((m) => memTierName(m) !== 'Free').length]];
    cols = ['#', 'Name', 'Email', 'Tier', 'Balance', 'Joined'];
    rows = d.map((m) => [m.member_number, m.name, m.email, memTierName(m), m.points_balance, memDate(m.joined_at)]);
  }
  if (res.error) { out.innerHTML = '<div class="loading">Could not load the report: ' + escHtml(res.error.message) + '</div>'; return; }

  memReportData = { type: memReport, from, to, cols, rows };
  out.innerHTML = '<div class="report-summary">' + summary.map((s) => '<div class="card"><div class="card-title">' + s[0] + '</div><div class="card-value teal">' + s[1] + '</div></div>').join('') + '</div>'
    + (rows.length ? '<table class="report-table"><thead><tr>' + cols.map((c) => '<th>' + c + '</th>').join('') + '</tr></thead><tbody>'
      + rows.map((r) => '<tr>' + r.map((c) => '<td>' + escHtml(String(c)) + '</td>').join('') + '</tr>').join('') + '</tbody></table>'
      : '<div class="loading">Nothing in that date range</div>');
}

function memReportCsv() {
  if (!memReportData || memReportData.type !== memReport) { toast('Run the report first', true); return; }
  const cell = (c) => '"' + String(c).replace(/"/g, '""') + '"';
  const csv = [memReportData.cols].concat(memReportData.rows).map((r) => r.map(cell).join(',')).join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = 'lvbc-' + memReportData.type + '-' + memReportData.from + '-to-' + memReportData.to + '.csv';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(a.href);
}
