// checkin.js
// Screen: #screen-checkin
// Depends on: window.supabase, toast(), tierClass(), getInitials()

let currentMember = null;
let checkinLocked = false;

async function searchMembers() {
  const val = document.getElementById('checkin-search').value.trim();
  const resultsEl = document.getElementById('checkin-results');
  if (!val) {
    resultsEl.innerHTML = '';
    return;
  }

  const { data, error } = await window.supabase
    .from('members')
    .select('id, name, email, points_balance, tier:tiers(name)')
    .or(`name.ilike.%${val}%,email.ilike.%${val}%`)
    .limit(10);

  if (error) {
    resultsEl.innerHTML = '<div class="loading">Error searching</div>';
    console.error(error);
    return;
  }

  if (!data.length) {
    resultsEl.innerHTML = '<div class="loading">No members found</div>';
    return;
  }

  resultsEl.innerHTML = data
    .map(
      (m) => `
      <div class="checkin-row" style="cursor:pointer" onclick="loadMemberProfile('${m.id}')">
        <div>
          <div class="checkin-name">${m.name}</div>
          <div class="checkin-time">${m.email}</div>
        </div>
        <span class="tier ${tierClass(m.tier && m.tier.name)}">${(m.tier && m.tier.name) || '—'}</span>
      </div>`
    )
    .join('');
}

async function loadMemberProfile(memberId) {
  const { data: member, error } = await window.supabase
    .from('members')
    .select('*, tier:tiers(name, rank)')
    .eq('id', memberId)
    .single();

  if (error || !member) {
    toast('Could not load member', true);
    return;
  }

  currentMember = member;
  checkinLocked = false;

  document.getElementById('checkin-results').innerHTML = '';
  document.getElementById('checkin-search').value = '';

  const profile = document.getElementById('member-profile');
  profile.classList.add('visible');

  const photoWrap = document.getElementById('profile-photo-wrap');
  photoWrap.innerHTML = member.profile_photo_url
    ? `<img class="profile-photo" src="${member.profile_photo_url}" alt="${member.name}" onerror="this.outerHTML='<div class=\\'profile-photo-initials\\'>${getInitials(member.name)}</div>'">`
    : `<div class="profile-photo-initials">${getInitials(member.name)}</div>`;

  document.getElementById('profile-name').textContent = member.name;
  document.getElementById('profile-email').textContent = member.email;
  document.getElementById('profile-balance').textContent = member.points_balance;
  const tierEl = document.getElementById('profile-tier');
  tierEl.textContent = (member.tier && member.tier.name) || '—';
  tierEl.className = 'tier ' + tierClass(member.tier && member.tier.name);
  document.getElementById('profile-since').textContent = new Date(
    member.joined_at
  ).toLocaleDateString('en-US', { month: 'short', year: 'numeric' });

  const { data: pours } = await window.supabase
    .from('free_pours')
    .select('id')
    .eq('member_id', member.id);
  document.getElementById('profile-pour-count').textContent = pours ? pours.length : 0;

  await renderTapList(member.id);
}

// ── CHECK-IN POINTS LOGIC ────────────────────────────────
// Mirrors the old resolveCheckinPoints(): first visit > Wed/Thu > standard.
// Rule *values* now come from point_rules so staff can tune them without a
// code change; the day-of-week logic itself stays here.
async function resolveCheckinPoints(memberId) {
  const { data: existing } = await window.supabase
    .from('check_ins')
    .select('id')
    .eq('member_id', memberId)
    .limit(1);

  const { data: rules } = await window.supabase.from('point_rules').select('*');
  const ruleMap = Object.fromEntries((rules || []).map((r) => [r.transaction_type, r.points]));

  if (!existing || !existing.length) {
    return { type: 'checkin_first_visit', pts: ruleMap.checkin_first_visit ?? 50 };
  }
  const day = new Date().getDay(); // 0=Sun,3=Wed,4=Thu
  if (day === 3) return { type: 'checkin_wednesday', pts: ruleMap.checkin_wednesday ?? 25 };
  if (day === 4) return { type: 'checkin_thursday', pts: ruleMap.checkin_thursday ?? 25 };
  return { type: 'checkin_standard', pts: ruleMap.checkin_standard ?? 15 };
}

async function applyCheckin() {
  if (!currentMember || checkinLocked) return null;
  checkinLocked = true;
  document.getElementById('checkin-btn').disabled = true;

  const resolved = await resolveCheckinPoints(currentMember.id);
  const now = new Date().toISOString();

  const { error: ciError } = await window.supabase.from('check_ins').insert({
    member_id: currentMember.id,
    checked_in_at: now,
    new_release_poured: false,
    points_awarded: resolved.pts,
  });
  if (ciError) {
    toast('Error logging check-in', true);
    checkinLocked = false;
    document.getElementById('checkin-btn').disabled = false;
    return null;
  }

  await window.supabase.from('points_transactions').insert({
    member_id: currentMember.id,
    transaction_type: resolved.type,
    points: resolved.pts,
    processed_by: window.currentStaff ? window.currentStaff.name : null,
  });

  const newBalance = currentMember.points_balance + resolved.pts;
  await window.supabase
    .from('members')
    .update({
      points_balance: newBalance,
      points_earned_lifetime: currentMember.points_earned_lifetime + resolved.pts,
    })
    .eq('id', currentMember.id);

  currentMember.points_balance = newBalance;
  document.getElementById('profile-balance').textContent = newBalance;
  toast(`✓ Checked in — +${resolved.pts} pts`);
  return resolved;
}

// ── FREE POUR TAP GRID ───────────────────────────────────
async function renderTapList(memberId) {
  const tapList = document.getElementById('tap-list');
  tapList.innerHTML = '<div class="loading" style="grid-column:1/-1">Loading...</div>';

  try {
    const { data: beers } = await window.supabase
      .from('beers')
      .select('id, name, style, abv, is_new_release')
      .eq('is_on_tap', true)
      .eq('retired', false)
      .order('is_new_release', { ascending: false })
      .order('name', { ascending: true });

    const { data: memberPours } = await window.supabase
      .from('free_pours')
      .select('beer_id')
      .eq('member_id', memberId);
    const pouredIds = (memberPours || []).map((p) => p.beer_id);

    tapList.innerHTML = (beers || [])
      .map((b) => {
        const isNew = b.is_new_release;
        const alreadyPoured = pouredIds.includes(b.id);
        const tileClass = 'beer-tile' + (isNew ? ' new-release' : '') + (alreadyPoured ? ' already-poured' : '');
        const badge = isNew
          ? '<span class="pour-badge new">New Release</span>'
          : alreadyPoured
          ? '<span class="pour-badge done">Poured</span>'
          : '';
        const pourBtn = alreadyPoured
          ? '<button class="btn-pour" disabled>Already Poured</button>'
          : `<button class="btn-pour" onclick="logFreePour('${b.id}', '${b.name.replace(/'/g, "\\'")}')">Log Free Pour</button>`;

        return `<div class="${tileClass}">${badge}<div class="beer-name">${b.name}</div><div class="beer-style">${b.style || ''}</div><div class="beer-abv">${b.abv ?? '—'}% ABV</div>${pourBtn}</div>`;
      })
      .join('');
  } catch (e) {
    tapList.innerHTML = '<div class="loading" style="grid-column:1/-1">Error</div>';
    console.error(e);
  }
}

async function logFreePour(beerId, beerName) {
  if (!currentMember) return;
  const now = new Date().toISOString();
  const { error } = await window.supabase.from('free_pours').insert({
    member_id: currentMember.id,
    beer_id: beerId,
    poured_at: now,
  });
  if (error) {
    toast('Error logging free pour', true);
    return;
  }
  toast(`🍺 Free pour logged — ${beerName}`);
  await renderTapList(currentMember.id);

  const { data: pours } = await window.supabase
    .from('free_pours')
    .select('id')
    .eq('member_id', currentMember.id);
  document.getElementById('profile-pour-count').textContent = pours ? pours.length : 0;
}
