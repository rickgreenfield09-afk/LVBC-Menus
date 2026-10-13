// card.js (member app)
// Pages: #tab-card (My Card) and #tab-rewards.
//
// My Card is what the member holds up at the bar: their name, tier,
// member number and the QR code staff scan to check them in, with the
// points balance and progress toward a reward they've picked as a goal.
// Rewards lists what points buy. Both read the rewards table, so what
// a member sees is what staff can actually redeem on the Members
// screen — redeeming itself happens at the bar, not here.
// The goal is a per-phone preference, kept in localStorage.
// Depends on: window.supabase, window.currentMember, escHtml(),
// tierName(), tierClass(), isPaidMember() (core.js), QRCode (qrcodejs)

const REWARD_LEVELS = { 1: 'Treasure Box', 2: 'Social Currency', 3: 'Real Merch', 4: 'Insider Access', 5: 'Legacy' };

let memberRewards = null;   // active rewards, loaded once per session
let memberQrToken = null;

async function loadRewards() {
  if (memberRewards) return memberRewards;
  const { data } = await window.supabase.from('rewards').select('*').eq('is_active', true)
    .order('level').order('points_cost').order('reward_name');
  memberRewards = data || [];
  return memberRewards;
}

function goalKey() { return 'lvbc_reward_goal_' + window.currentMember.id; }

// ── MY CARD ──────────────────────────────────────────────
async function renderCard() {
  const m = window.currentMember;
  document.getElementById('card-name').textContent = m.name;
  document.getElementById('card-number').textContent = m.member_number;
  document.getElementById('card-balance').textContent = m.points_balance.toLocaleString();
  document.getElementById('card-lifetime').textContent = m.points_earned_lifetime.toLocaleString();
  document.getElementById('card-since').textContent = new Date(m.joined_at).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  const tierEl = document.getElementById('card-tier');
  tierEl.textContent = tierName(m);
  tierEl.className = 'tier-badge ' + tierClass(tierName(m));

  renderQr();
  renderGoal(await loadRewards());
}

// The token never changes, so it's fetched once and the code drawn once.
async function renderQr() {
  const wrap = document.getElementById('qr-wrapper');
  if (memberQrToken && wrap.dataset.token === memberQrToken) return;
  if (!memberQrToken) {
    const { data } = await window.supabase.from('qr_tokens').select('token').eq('member_id', window.currentMember.id).order('created_at', { ascending: false }).limit(1).maybeSingle();
    memberQrToken = data && data.token;
  }
  if (!memberQrToken) {
    wrap.innerHTML = '<div class="qr-container"><div class="qr-empty">No QR code yet — ask staff to look you up by name</div></div>';
    return;
  }
  wrap.innerHTML = '<div class="qr-container"><div id="qr-render"></div></div>';
  wrap.dataset.token = memberQrToken;
  new QRCode(document.getElementById('qr-render'), {
    text: memberQrToken, width: 160, height: 160,
    colorDark: '#000000', colorLight: '#ffffff', correctLevel: QRCode.CorrectLevel.M,
  });
}

function renderGoal(rewards) {
  const m = window.currentMember;
  const bal = m.points_balance;
  const saved = localStorage.getItem(goalKey());
  const open = rewards.filter((r) => !r.paid_only || isPaidMember(m));
  const goal = open.find((r) => r.id === saved);

  document.getElementById('reward-goal-select').innerHTML = '<option value="">— Select a reward to track —</option>'
    + open.map((r) => '<option value="' + r.id + '"' + (goal && goal.id === r.id ? ' selected' : '') + '>'
      + escHtml(r.reward_name) + ' (' + r.points_cost.toLocaleString() + ' pts)</option>').join('');

  const label = document.getElementById('progress-label');
  const pct = document.getElementById('progress-pct');
  const bar = document.getElementById('progress-bar-wrap');
  const fill = document.getElementById('progress-fill');
  if (!goal) {
    label.textContent = 'Select a reward to track your progress';
    label.style.color = 'var(--text-muted)';
    pct.textContent = '';
    bar.style.display = 'none';
    return;
  }
  const done = bal >= goal.points_cost;
  const p = done ? 100 : Math.round((bal / goal.points_cost) * 100);
  label.textContent = done ? '✓ You can redeem: ' + goal.reward_name : (goal.points_cost - bal).toLocaleString() + ' pts to ' + goal.reward_name;
  label.style.color = done ? 'var(--accent-teal)' : '';
  pct.textContent = p + '%';
  bar.style.display = 'block';
  fill.style.width = p + '%';
}

function saveRewardGoal(val) {
  if (val) localStorage.setItem(goalKey(), val);
  else localStorage.removeItem(goalKey());
  renderGoal(memberRewards || []);
}

// Shown when staff check the member in while the app is open.
async function showCheckinFlash(checkin) {
  const m = window.currentMember;
  document.getElementById('flash-detail').innerHTML = 'You just earned <strong style="color:var(--accent-teal)">'
    + (checkin.points_awarded || 0) + ' points</strong> · Balance: ' + m.points_balance.toLocaleString();

  const [beers, poured] = await Promise.all([
    window.supabase.from('beers').select('id, name, style').eq('status', 'active').contains('badges', ['new_release']).order('name'),
    window.supabase.from('free_pours').select('beer_id').eq('member_id', m.id),
  ]);
  const had = new Set((poured.data || []).map((p) => p.beer_id));
  document.getElementById('flash-beers').innerHTML = (beers.data || []).length
    ? '<div class="form-label" style="margin-bottom:0;">New releases — one free pour each</div>'
      + beers.data.map((b) => '<div class="flash-beer-item"><div><div class="flash-beer-name">' + escHtml(b.name) + '</div>'
        + '<div class="flash-beer-style">' + escHtml(b.style) + '</div></div>'
        + '<div class="flash-beer-status ' + (had.has(b.id) ? 'poured">✓ Poured' : 'available">★ Available') + '</div></div>').join('')
    : '';

  const flash = document.getElementById('checkin-flash');
  flash.classList.add('visible', 'pulse');
  setTimeout(() => flash.classList.remove('visible', 'pulse'), 12000);
}

// ── REWARDS ──────────────────────────────────────────────
async function renderRewards() {
  const m = window.currentMember;
  const bal = m.points_balance;
  const paid = isPaidMember(m);
  const rewards = await loadRewards();

  let html = '<div style="font-size:13px;color:var(--text-secondary);margin-bottom:16px">Balance: <strong style="color:var(--accent-teal);font-family:\'Barlow Condensed\',sans-serif;font-size:22px">'
    + bal.toLocaleString() + '</strong> pts · redeem at the bar</div>';

  if (!rewards.length) html += '<div class="empty">No rewards available right now</div>';

  [1, 2, 3, 4, 5].forEach((lvl) => {
    const items = rewards.filter((r) => r.level === lvl);
    if (!items.length) return;
    const costs = items.map((r) => r.points_cost);
    const min = Math.min(...costs); const max = Math.max(...costs);
    const allLocked = items.every((r) => r.paid_only && !paid);
    // open the first tier, and any tier with something they can afford
    const isOpen = lvl === 1 || items.some((r) => bal >= r.points_cost && (!r.paid_only || paid));

    html += '<div class="rewards-tier"><div class="rewards-tier-header" onclick="toggleCollapse(this)">'
      + '<div class="tier-header-left"><div class="tier-dot"' + (allLocked ? ' style="background:var(--text-muted)"' : '') + '></div>'
      + '<div><div class="tier-header-label">Tier ' + lvl + ' — ' + REWARD_LEVELS[lvl] + '</div>'
      + '<div class="tier-header-range">' + (min === max ? min.toLocaleString() : min.toLocaleString() + '–' + max.toLocaleString()) + ' pts</div></div></div>'
      + '<div class="tier-chevron' + (isOpen ? ' open' : '') + '">▼</div></div>'
      + '<div class="tier-body' + (isOpen ? ' open' : '') + '">';

    items.forEach((r) => {
      const locked = r.paid_only && !paid;
      const can = !locked && bal >= r.points_cost;
      const notes = [];
      if (locked) notes.push('Paid members only');
      if (r.limit_count) notes.push(r.limit_count + ' per ' + r.limit_period + (r.limit_scope === 'brewery' ? ', brewery-wide' : ''));
      if (!r.repeatable) notes.push('One time only');
      html += '<div class="reward-item' + (can ? '' : ' locked') + '"><div><div class="reward-name">' + escHtml(r.reward_name) + '</div>'
        + (notes.length ? '<div class="beer-style">' + escHtml(notes.join(' · ')) + '</div>' : '') + '</div>'
        + '<div class="reward-pts ' + (can ? 'can-redeem' : 'locked') + '">' + r.points_cost.toLocaleString() + ' pts</div></div>';
    });
    html += '</div></div>';
  });

  document.getElementById('rewards-content').innerHTML = html;
}

// Reward tiers and badge categories fold the same way.
function toggleCollapse(header) {
  header.querySelector('.tier-chevron, .badge-cat-chevron').classList.toggle('open');
  header.nextElementSibling.classList.toggle('open');
}
