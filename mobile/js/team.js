// team.js (mobile)
// Screen: #screen-team — everyone on staff, with buttons that hand a
// number to the phone's own Messages and Phone apps (sms: / tel:
// links), so nothing is sent through this app. Group texts too: pick
// people, or "Working today", and one tap opens a group message.
//
// Numbers live on staff_profiles.phone (migration_043), stored as +1
// and ten digits. Everyone must have one — core.js stops a staffer at
// sign-in until they've added theirs — and each person edits their own
// here. All staff can see all numbers. Admins can take someone off this
// list (staff_profiles.show_in_roster, migration_044); you always see yourself.
// Depends on: window.supabase, window.currentStaff, toast(),
// escHtml(), toDateStr(), normalizePhone(), formatPhone() (core.js),
// mOpenSheet(), mCloseSheet() (inventory.js)

const M_TEAM_POSITIONS = { bartender: 'Bartender', cellarman: 'Cellarman', manager: 'Manager' };

let mTeam = [];
let mTeamWorkingToday = new Set();
let mTeamSelecting = false;
let mTeamSelected = new Set();

async function loadTeam() {
  const el = document.getElementById('m-team');
  const [staff, today] = await Promise.all([
    window.supabase.from('staff_profiles').select('id,name,position,photo_url,phone,show_in_roster').order('name'),
    window.supabase.from('shifts').select('staff_id').eq('shift_date', toDateStr(new Date())).not('staff_id', 'is', null),
  ]);
  if (staff.error) { el.innerHTML = '<div class="loading">Could not load the team: ' + escHtml(staff.error.message) + '</div>'; return; }
  mTeam = staff.data.filter((p) => p.show_in_roster !== false || p.id === window.currentStaff.id);
  mTeamWorkingToday = new Set((today.data || []).map((s) => s.staff_id));
  renderTeam();
}

// iPhones open a group message from sms:/open?addresses=a,b; Android
// reads a comma list straight after sms:.
function mSmsLink(numbers) {
  if (numbers.length === 1) return 'sms:' + numbers[0];
  return /iPhone|iPad|iPod/i.test(navigator.userAgent) ? 'sms:/open?addresses=' + numbers.join(',') : 'sms:' + numbers.join(',');
}

function mTeamAvatar(p) {
  return p.photo_url ? '<img class="m-thumb m-avatar" src="' + escHtml(p.photo_url) + '" alt="">'
    : '<div class="m-thumb m-avatar m-avatar-initials">' + escHtml((p.name || '?').split(' ').map((w) => w[0]).join('').slice(0, 2).toUpperCase()) + '</div>';
}

function renderTeam() {
  const el = document.getElementById('m-team');
  const me = mTeam.find((p) => p.id === window.currentStaff.id) || window.currentStaff;
  const others = mTeam.filter((p) => p.id !== window.currentStaff.id);
  const chip = (label, onclick) => '<div class="badge-pill" onclick="' + onclick + '">' + label + '</div>';

  let html = '<div class="m-item m-rec">' + mTeamAvatar(me) + '<div class="m-rec-body"><div class="m-item-name">' + escHtml(me.name) + ' <span class="m-rec-unit">(you)</span></div>'
    + '<div class="m-item-sub">' + escHtml(me.phone ? formatPhone(me.phone) : 'No number yet') + '</div></div>'
    + '<button class="btn btn-sm btn-secondary" onclick="openMyPhone()">Edit Number</button></div>'
    + '<div class="m-team-bar"><div class="section-label" style="margin:0;">Team</div>'
    + '<button class="btn btn-sm ' + (mTeamSelecting ? 'btn-primary' : 'btn-secondary') + '" onclick="toggleTeamSelect()">' + (mTeamSelecting ? 'Done' : 'Group Text') + '</button></div>';
  if (mTeamSelecting) {
    html += '<div class="m-chips">' + chip('Working today', 'selectTeam(\'today\')') + chip('Everyone', 'selectTeam(\'all\')') + chip('Clear', 'selectTeam(\'none\')') + '</div>';
  }

  html += others.map((p) => {
    const sel = mTeamSelected.has(p.id);
    return '<div class="m-item m-rec' + (sel ? ' counted' : '') + '"' + (mTeamSelecting && p.phone ? ' onclick="toggleTeamPerson(\'' + p.id + '\')"' : '') + '>'
      + (mTeamSelecting ? '<div class="m-task-check' + (sel ? ' on' : '') + '" aria-hidden="true">' + (sel ? '&#10003;' : '') + '</div>' : mTeamAvatar(p))
      + '<div class="m-rec-body"><div class="m-item-name">' + escHtml(p.name) + '</div>'
      + '<div class="m-item-sub">' + escHtml(M_TEAM_POSITIONS[p.position] || '') + (mTeamWorkingToday.has(p.id) ? ' · <span style="color:var(--teal);">working today</span>' : '') + '</div>'
      + '<div class="m-item-sub">' + escHtml(p.phone ? formatPhone(p.phone) : 'No number yet') + '</div></div>'
      + (!mTeamSelecting && p.phone ? '<div class="m-team-actions"><a class="btn btn-sm btn-primary" href="' + mSmsLink([p.phone]) + '">Text</a><a class="btn btn-sm btn-secondary" href="tel:' + p.phone + '">Call</a></div>' : '')
      + '</div>';
  }).join('');

  const picked = others.filter((p) => mTeamSelected.has(p.id) && p.phone);
  if (mTeamSelecting) {
    html += '<div class="m-team-send">' + (picked.length
      ? '<a class="btn btn-primary" href="' + mSmsLink(picked.map((p) => p.phone)) + '">Text ' + picked.length + ' ' + (picked.length === 1 ? 'person' : 'people') + '</a>'
      : '<button class="btn btn-primary" disabled>Pick people to text</button>') + '</div>';
  }
  el.innerHTML = html;
}

function toggleTeamSelect() { mTeamSelecting = !mTeamSelecting; mTeamSelected.clear(); renderTeam(); }
function toggleTeamPerson(id) { if (mTeamSelected.has(id)) mTeamSelected.delete(id); else mTeamSelected.add(id); renderTeam(); }

function selectTeam(which) {
  mTeamSelected.clear();
  mTeam.filter((p) => p.id !== window.currentStaff.id && p.phone && (which === 'all' || (which === 'today' && mTeamWorkingToday.has(p.id))))
    .forEach((p) => mTeamSelected.add(p.id));
  if (which === 'today' && !mTeamSelected.size) toast('No one else is on the schedule today');
  renderTeam();
}

// ── YOUR OWN NUMBER ──────────────────────────────
function openMyPhone() {
  mOpenSheet('<div class="m-sheet-body"><div class="m-sheet-title">Your Phone Number</div>'
    + '<div class="m-item-sub">Everyone on staff can see it on the Team page.</div>'
    + '<label class="admin-label m-sheet-label" for="m-my-phone">Mobile number</label>'
    + '<input class="admin-input" type="tel" id="m-my-phone" inputmode="tel" autocomplete="tel" placeholder="(512) 555-0123" value="' + escHtml(window.currentStaff.phone ? formatPhone(window.currentStaff.phone) : '') + '">'
    + '<div id="m-my-phone-error" class="m-login-error" style="margin-top:8px;"></div>'
    + '</div><div class="m-sheet-actions"><button class="btn btn-secondary" onclick="mCloseSheet()">Cancel</button><button class="btn btn-primary" onclick="saveMyPhoneFromSheet()">Save</button></div>');
}

async function saveMyPhoneFromSheet() {
  const err = await saveMyPhone(document.getElementById('m-my-phone').value);
  if (err) { document.getElementById('m-my-phone-error').textContent = err; return; }
  mCloseSheet();
  toast('Number saved');
  loadTeam();
}
