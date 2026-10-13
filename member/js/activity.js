// activity.js (member app)
// Pages: #tab-activity, #tab-badges and #tab-leaderboard.
//
//   Activity     the member's last six badges, then a feed of their
//                check-ins (with any free pour that day), and every
//                other points line: beers logged, awards, redemptions
//   Badges       the whole catalog by category, earned ones lit. A
//                secret badge stays hidden until it's earned.
//   Leaderboard  top 20 by points, this month or all time. This is
//                the only place a member sees anyone else, and it comes
//                from member_leaderboard() — name, photo, tier, points.
//
// Badges are awarded by the database when staff record activity
// (migration_040); this file only reads them.
// Depends on: window.supabase, window.currentMember, escHtml(),
// initials(), avatarHtml(), fmtDate() (core.js), toggleCollapse()
// (card.js)

const LEDGER_LABELS = {
  redemption: 'Reward Redeemed', beer_journal_new: 'New Beer Tried', manual_adjustment: 'Points Adjustment',
  event_attendance: 'Event Attendance', event_special: 'Special Event', event_win_bingo: 'Bingo Round Win',
  event_win_trivia: 'Trivia Round Win', event_win_trivia_overall: 'Trivia Overall Win',
  referral_free: 'Referral', referral_paid: 'Referral — Paid Member',
};

let leaderboardMode = 'month';

function badgeArt(b) {
  if (b.image_url) return '<img class="badge-full-img" src="' + escHtml(b.image_url) + '" alt="">';
  return '<div class="badge-medal" style="border-color:' + escHtml(b.border_color || 'var(--border)') + ';">' + escHtml(initials(b.name)) + '</div>';
}

// ── ACTIVITY ─────────────────────────────────────────────
async function loadActivity() {
  const sb = window.supabase;
  const me = window.currentMember.id;
  const [checkins, pours, ledger, badges] = await Promise.all([
    sb.from('check_ins').select('checked_in_at, kind, points_awarded, free_pour_beer').eq('member_id', me).order('checked_in_at', { ascending: false }).limit(50),
    sb.from('free_pours').select('poured_at, beers(name, style)').eq('member_id', me).order('poured_at', { ascending: false }).limit(50),
    sb.from('points_transactions').select('transaction_type, points, notes, created_at').eq('member_id', me).not('transaction_type', 'like', 'checkin_%').order('created_at', { ascending: false }).limit(50),
    sb.from('member_badges').select('earned_at, badges(name, image_url, border_color)').eq('member_id', me).order('earned_at', { ascending: false }).limit(6),
  ]);

  // badge strip: six slots, empty ones shown as "?"
  const recent = badges.data || [];
  document.getElementById('badge-strip-grid').innerHTML = [0, 1, 2, 3, 4, 5].map((i) => {
    const mb = recent[i];
    if (!mb) return '<div class="badge-slot empty"></div>';
    return '<div class="badge-slot" title="' + escHtml(mb.badges.name) + '">' + badgeArt(mb.badges)
      + '<div class="badge-slot-label">' + escHtml(mb.badges.name) + '</div></div>';
  }).join('');

  const day = (ts) => new Date(ts).toDateString();
  const pourByDay = {};
  (pours.data || []).forEach((p) => { (pourByDay[day(p.poured_at)] = pourByDay[day(p.poured_at)] || []).push(p); });

  const row = (ts, icon, title, sub, pts, ptsColor) => ({
    ts: new Date(ts).getTime(),
    html: '<div class="activity-item"><div class="activity-icon" style="font-size:18px;">' + icon + '</div><div class="activity-details">'
      + '<div class="activity-title">' + escHtml(title) + '</div><div class="activity-meta">' + fmtDate(ts) + '</div>' + sub + '</div>'
      + '<div class="activity-pts"' + (ptsColor ? ' style="color:' + ptsColor + '"' : '') + '>' + pts + '</div></div>',
  });
  const pourLine = (text) => '<div class="activity-sub" style="color:var(--accent-amber)">Free pour — ' + escHtml(text) + '</div>';

  const items = [];
  const checkinDays = new Set();
  (checkins.data || []).forEach((c) => {
    const d = day(c.checked_in_at);
    checkinDays.add(d);
    const dayPours = pourByDay[d] || [];
    const sub = dayPours.length
      ? dayPours.filter((p) => p.beers).map((p) => pourLine(p.beers.name + (p.beers.style ? ' (' + p.beers.style + ')' : ''))).join('')
      : (c.free_pour_beer ? pourLine(c.free_pour_beer) : '');
    items.push(row(c.checked_in_at, '📍', c.kind === 'dd' ? 'Check-In · Designated Driver' : 'Check-In', sub, '+' + c.points_awarded));
  });

  // a free pour on a day with no check-in of its own (carried-over history)
  (pours.data || []).forEach((p) => {
    if (!p.beers || checkinDays.has(day(p.poured_at))) return;
    items.push(row(p.poured_at, '🍺', 'Free Pour', '<div class="activity-sub" style="color:var(--accent-amber)">' + escHtml(p.beers.name) + '</div>', '', null));
  });

  (ledger.data || []).forEach((t) => {
    const spent = t.points < 0;
    const title = LEDGER_LABELS[t.transaction_type] || t.transaction_type.replace(/_/g, ' ');
    const sub = t.notes ? '<div class="activity-sub" style="color:var(--text-secondary)">' + escHtml(t.notes) + '</div>' : '';
    items.push(row(t.created_at, spent ? '🎁' : t.transaction_type === 'beer_journal_new' ? '🍺' : '⭐', title, sub,
      (t.points > 0 ? '+' : '') + t.points, spent ? 'var(--accent-amber)' : null));
  });

  items.sort((a, b) => b.ts - a.ts);
  document.getElementById('activity-list').innerHTML = items.length
    ? items.map((i) => i.html).join('')
    : '<div class="empty">No activity yet — visit us to get started!</div>';
}

// ── BADGES ───────────────────────────────────────────────
async function loadBadgesPage() {
  const [catalog, mine] = await Promise.all([
    window.supabase.from('badges').select('id, name, category, rarity, border_color, description, is_secret, image_url').eq('is_active', true).order('category').order('name'),
    window.supabase.from('member_badges').select('badge_id').eq('member_id', window.currentMember.id),
  ]);
  const earned = new Set((mine.data || []).map((b) => b.badge_id));
  const visible = (catalog.data || []).filter((b) => !b.is_secret || earned.has(b.id));
  const cats = [...new Set(visible.map((b) => b.category))];

  document.getElementById('badges-page-content').innerHTML = cats.length ? cats.map((cat) => {
    const list = visible.filter((b) => b.category === cat);
    const count = list.filter((b) => earned.has(b.id)).length;
    return '<div class="badge-cat-block"><div class="badge-cat-header" onclick="toggleCollapse(this)">'
      + '<div class="badge-cat-left"><div class="badge-cat-name">' + escHtml(cat) + '</div>'
      + (count ? '<div class="badge-cat-count">' + count + ' earned</div>' : '') + '</div>'
      + '<div class="badge-cat-chevron' + (count ? ' open' : '') + '">▼</div></div>'
      + '<div class="badge-cat-body' + (count ? ' open' : '') + '"><div class="badges-full-grid">'
      + list.map((b) => {
        const has = earned.has(b.id);
        return '<div class="badge-full-item' + (has ? ' earned' : '') + '"><div' + (has ? '' : ' class="badge-locked"') + '>' + badgeArt(b) + '</div>'
          + '<div class="badge-full-name">' + escHtml(b.name) + '</div><div class="badge-full-desc">' + escHtml(b.description) + '</div>'
          + '<div class="badge-rarity rarity-' + escHtml(b.rarity.toLowerCase()) + '">' + escHtml(b.rarity) + '</div>'
          + (has ? '<div style="font-size:10px;color:var(--accent-teal);font-weight:700">✓ EARNED</div>' : '') + '</div>';
      }).join('') + '</div></div></div>';
  }).join('') : '<div class="empty">No badges yet</div>';
}

// ── LEADERBOARD ──────────────────────────────────────────
function setLeaderboard(mode) {
  leaderboardMode = mode;
  loadLeaderboard();
}

async function loadLeaderboard() {
  document.getElementById('lb-btn-month').classList.toggle('active', leaderboardMode === 'month');
  document.getElementById('lb-btn-all').classList.toggle('active', leaderboardMode === 'all');
  const el = document.getElementById('leaderboard-list');
  const { data, error } = await window.supabase.rpc('member_leaderboard', { p_period: leaderboardMode });
  if (error) { el.innerHTML = '<div class="empty">Could not load the leaderboard</div>'; return; }
  if (!data.length) {
    el.innerHTML = '<div class="empty">' + (leaderboardMode === 'month' ? 'No points earned this month yet — be the first!' : 'No leaderboard data yet') + '</div>';
    return;
  }
  const medal = ['gold', 'silver', 'bronze'];
  el.innerHTML = data.map((r, i) => '<div class="lb-row">'
    + '<div class="lb-rank ' + (medal[i] || '') + '">' + (i + 1) + '</div>'
    + '<div class="lb-avatar">' + avatarHtml(r) + '</div>'
    + '<div class="lb-name' + (r.is_you ? ' you' : '') + '">' + escHtml(r.name) + (r.is_you ? ' (You)' : '') + '</div>'
    + '<div class="lb-pts">' + r.points.toLocaleString() + '</div></div>').join('');
}
