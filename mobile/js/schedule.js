// schedule.js (mobile)
// Screen: #screen-schedule — the light version of My Shifts
// (js/myshifts.js): the signed-in staffer's upcoming shifts as a list,
// asking for coverage on one of them, covering someone else's request,
// and claiming open shifts. Building or editing the schedule stays on
// the desktop panel.
//
// Covering a request only marks it claimed (migration_015) — it does
// not move the shift. A scheduler still reassigns it on the desktop
// panel, same as when a request is claimed there.
// Depends on: window.supabase, window.currentStaff, toast(),
// escHtml(), toDateStr(), fmtTime() (core.js), mOpenSheet(),
// mCloseSheet() (inventory.js), mTasks, mTaskSlots(), mTasksFor(),
// M_TASK_CATEGORIES (tasks.js)

let mDaySettings = [];
let mMyStaffIds = [];
let mMyShifts = [];
let mMyShiftRequests = [];
let mCoverFormShiftId = null;

// Same rule as js/schedule.js — a "morning" slot that starts at noon
// or later (Sunday) reads as Afternoon.
function shiftSlotLabel(setting, period) {
  if (period === 'evening') return 'Evening';
  const h = setting && setting.morning_start ? parseInt(setting.morning_start.split(':')[0], 10) : 9;
  return h >= 12 ? 'Afternoon' : 'Morning';
}

// A shift assigned to a duplicate/placeholder profile (same email,
// different id — see migration_008/014) won't match the session's own
// id, so resolve every staff_profiles row sharing this email.
async function resolveMyStaffIds() {
  const selfId = window.currentStaff.id;
  const email = window.currentStaff.email;
  if (!email) return [selfId];
  const { data, error } = await window.supabase.from('staff_profiles').select('id').eq('email', email);
  if (error || !data || !data.length) return [selfId];
  const ids = data.map((r) => r.id);
  if (!ids.includes(selfId)) ids.push(selfId);
  return ids;
}

async function loadSchedule() {
  if (!mDaySettings.length) {
    const { data } = await window.supabase.from('shift_day_settings').select('*').order('day_of_week');
    mDaySettings = data || [];
  }
  mMyStaffIds = await resolveMyStaffIds();
  await Promise.all([loadScheduleCalendar(), loadMyUpcomingShifts(), loadCoverageRequests(), loadOpenShifts()]);
}

// ── WHOLE-SCHEDULE CALENDAR ───────────────────────
// A month of everyone's shifts. Each day shows a teal dot if you're on
// and an amber one if a shift is still open; tapping a day lists every
// shift on it underneath — who, which shift, hours — with Claim on
// open ones.
let mCalCursor = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
let mCalShifts = [];
let mCalSelected = toDateStr(new Date());

function calendarMonth(delta) {
  mCalCursor = new Date(mCalCursor.getFullYear(), mCalCursor.getMonth() + delta, 1);
  const today = new Date();
  mCalSelected = mCalCursor.getFullYear() === today.getFullYear() && mCalCursor.getMonth() === today.getMonth() ? toDateStr(today) : toDateStr(mCalCursor);
  loadScheduleCalendar();
}

async function loadScheduleCalendar() {
  const start = toDateStr(mCalCursor);
  const end = toDateStr(new Date(mCalCursor.getFullYear(), mCalCursor.getMonth() + 1, 0));
  const { data, error } = await window.supabase.from('shifts').select('id,shift_date,period,role,staff_id,start_time,end_time,staff:staff_id(name)')
    .gte('shift_date', start).lte('shift_date', end).order('start_time');
  if (error) { document.getElementById('m-cal').innerHTML = '<div class="loading">Could not load the schedule: ' + escHtml(error.message) + '</div>'; return; }
  mCalShifts = data || [];
  renderScheduleCalendar();
}

function selectCalendarDay(dateStr) { mCalSelected = dateStr; renderScheduleCalendar(); }

function renderScheduleCalendar() {
  const today = toDateStr(new Date());
  const first = mCalCursor;
  const last = new Date(first.getFullYear(), first.getMonth() + 1, 0);
  let cells = ['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((d) => '<div class="m-cal-dow">' + d + '</div>').join('');
  for (let i = 0; i < first.getDay(); i++) cells += '<div></div>';
  for (let day = 1; day <= last.getDate(); day++) {
    const dateStr = toDateStr(new Date(first.getFullYear(), first.getMonth(), day));
    const setting = mDaySettings.find((x) => x.day_of_week === new Date(dateStr + 'T00:00:00').getDay()) || {};
    const rows = mCalShifts.filter((s) => s.shift_date === dateStr);
    const mine = rows.some((s) => mMyStaffIds.includes(s.staff_id));
    const open = rows.some((s) => !s.staff_id);
    cells += '<button class="m-cal-day' + (dateStr === mCalSelected ? ' selected' : '') + (dateStr === today ? ' today' : '') + (setting.is_closed ? ' closed' : '') + '" onclick="selectCalendarDay(\'' + dateStr + '\')">'
      + '<span>' + day + '</span><i>' + (mine ? '<b class="mine"></b>' : '') + (open ? '<b class="open"></b>' : '') + '</i></button>';
  }
  document.getElementById('m-cal').innerHTML = '<div class="m-cal-head"><button class="m-cal-nav" aria-label="Previous month" onclick="calendarMonth(-1)">&#8249;</button>'
    + '<div class="m-cal-title">' + first.toLocaleDateString('default', { month: 'long', year: 'numeric' }) + '</div>'
    + '<button class="m-cal-nav" aria-label="Next month" onclick="calendarMonth(1)">&#8250;</button></div>'
    + '<div class="m-cal-grid">' + cells + '</div>'
    + '<div class="m-cal-key"><span><b class="mine"></b>You\'re on</span><span><b class="open"></b>Open shift</span></div>'
    + mCalDayHtml(mCalSelected);
}

// Everything on one day: manager on duty first, then AM and PM.
function mCalDayHtml(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  const setting = mDaySettings.find((x) => x.day_of_week === d.getDay()) || {};
  let html = '<div class="m-cal-detail"><div class="m-item-name">' + d.toLocaleDateString('default', { weekday: 'long', month: 'long', day: 'numeric' }) + '</div>';
  if (setting.is_closed) return html + '<div class="loading">Closed</div></div>';
  const rows = mCalShifts.filter((s) => s.shift_date === dateStr);
  if (!rows.length) return html + '<div class="loading">Nothing scheduled yet</div></div>';
  const order = (s) => (s.role === 'manager' ? 0 : s.period === 'morning' ? 1 : 2);
  html += rows.slice().sort((a, b) => order(a) - order(b)).map((s) => {
    const mine = mMyStaffIds.includes(s.staff_id);
    const label = s.role === 'manager' ? 'Manager on Duty' + (s.period ? ' · ' + shiftSlotLabel(setting, s.period) : '') : shiftSlotLabel(setting, s.period);
    return '<div class="shift-row"><div><div class="shift-row-name">' + (s.staff_id ? escHtml(mine ? 'You' : (s.staff && s.staff.name) || 'Staff') : '<span style="color:var(--amber);">Open shift</span>') + '</div>'
      + '<div class="shift-row-meta">' + escHtml(label) + (s.start_time ? ' · ' + fmtTime(s.start_time) + (s.end_time ? '–' + fmtTime(s.end_time) : '') : '') + '</div></div>'
      + (!s.staff_id && dateStr >= toDateStr(new Date()) ? '<button class="btn btn-sm btn-primary" onclick="claimOpenShift(\'' + s.id + '\')">Claim</button>' : '')
      + (mine ? '<span class="badge badge-teal">You</span>' : '') + '</div>';
  }).join('');
  return html + '</div>';
}

// detailId makes the left side of the row tappable, opening that shift's details sheet.
function shiftRowHtml(s, actionHtml, metaExtraHtml, detailId) {
  const d = new Date(s.shift_date + 'T00:00:00');
  const setting = mDaySettings.find((x) => x.day_of_week === d.getDay()) || {};
  const label = s.role === 'manager' ? 'Manager on Duty' : shiftSlotLabel(setting, s.period);
  const isToday = s.shift_date === toDateStr(new Date());
  const time = s.start_time ? fmtTime(s.start_time) + (s.end_time ? '–' + fmtTime(s.end_time) : '') : '';
  return '<div class="shift-row"><div' + (detailId ? ' class="m-shift-tap" role="button" tabindex="0" onclick="openShiftDetails(\'' + detailId + '\')"' : '') + '>'
    + '<div class="shift-row-name">' + d.toLocaleDateString('default', { weekday: 'short', month: 'short', day: 'numeric' }) + ' · ' + escHtml(label)
    + (isToday ? ' <span class="badge badge-teal">Today</span>' : '') + '</div>'
    + '<div class="shift-row-meta">' + [time, metaExtraHtml].filter(Boolean).join(' · ') + '</div>'
    + (detailId ? '<div class="m-shift-more">View duties &rsaquo;</div>' : '')
    + '</div>' + (actionHtml || '') + '</div>';
}

// ── MY UPCOMING SHIFTS (+ asking for coverage) ────────────
async function loadMyUpcomingShifts() {
  const el = document.getElementById('m-my-shifts');
  const { data, error } = await window.supabase.from('shifts').select('*')
    .in('staff_id', mMyStaffIds).gte('shift_date', toDateStr(new Date())).order('shift_date').order('start_time');
  if (error) { el.innerHTML = '<div class="loading">Error: ' + escHtml(error.message) + '</div>'; return; }
  mMyShifts = data || [];

  mMyShiftRequests = [];
  if (mMyShifts.length) {
    const { data: reqs } = await window.supabase.from('coverage_requests').select('*, claimer:claimed_by(name)')
      .in('shift_id', mMyShifts.map((s) => s.id)).in('status', ['open', 'claimed']);
    mMyShiftRequests = reqs || [];
  }
  renderMyUpcomingShifts();
}

function renderMyUpcomingShifts() {
  const el = document.getElementById('m-my-shifts');
  if (!mMyShifts.length) { el.innerHTML = '<div class="loading">No upcoming shifts</div>'; return; }
  el.innerHTML = mMyShifts.map((s) => {
    const req = mMyShiftRequests.find((r) => r.shift_id === s.id);
    if (req && req.status === 'claimed') {
      return shiftRowHtml(s, '', '<span style="color:var(--teal);">Covered by ' + escHtml((req.claimer && req.claimer.name) || 'someone') + '</span>', s.id);
    }
    if (req) {
      return shiftRowHtml(s, '<button class="btn btn-sm btn-danger" onclick="cancelCoverageRequest(\'' + req.id + '\')">Cancel Request</button>',
        '<span style="color:var(--amber);">Coverage requested</span>', s.id);
    }
    if (mCoverFormShiftId === s.id) {
      return shiftRowHtml(s, '', '', s.id) + '<div class="m-cover-form">'
        + '<input class="admin-input" type="text" id="m-cover-note" maxlength="200" placeholder="Note for the team (optional)">'
        + '<div class="m-cover-form-btns"><button class="btn btn-secondary" onclick="toggleCoverForm(null)">Cancel</button>'
        + '<button class="btn btn-primary" onclick="submitCoverageRequest(\'' + s.id + '\')">Send Request</button></div></div>';
    }
    return shiftRowHtml(s, '<button class="btn btn-sm btn-secondary" onclick="toggleCoverForm(\'' + s.id + '\')">Need Coverage</button>', '', s.id);
  }).join('');
}

// ── SHIFT DETAILS (tap one of your shifts) ────────
// Read-only: the date, the hours, and the duties assigned to that
// shift, in the order they're done. Checking them off happens on the
// Tasks tab on the day.
async function openShiftDetails(shiftId) {
  const s = mMyShifts.find((x) => x.id === shiftId);
  if (!s) return;
  const d = new Date(s.shift_date + 'T00:00:00');
  const setting = mDaySettings.find((x) => x.day_of_week === d.getDay()) || {};
  const head = '<div class="m-sheet-body"><div class="m-sheet-title">' + d.toLocaleDateString('default', { weekday: 'long', month: 'long', day: 'numeric' }) + '</div>'
    + '<div class="m-item-sub">' + escHtml(s.role === 'manager' ? 'Manager on Duty' : shiftSlotLabel(setting, s.period) + ' shift')
    + (s.start_time ? ' · ' + fmtTime(s.start_time) + (s.end_time ? '–' + fmtTime(s.end_time) : '') : '') + '</div>';
  const foot = '</div><div class="m-sheet-actions" style="grid-template-columns:1fr;"><button class="btn btn-primary" onclick="mCloseSheet()">Close</button></div>';
  mOpenSheet(head + '<div class="loading">Loading duties...</div>' + foot);

  // The plan may not be loaded yet if the Tasks tab hasn't been opened.
  if (!mTasks.length) {
    const { data, error } = await window.supabase.from('assignment_tasks').select('*').eq('is_active', true).order('sort_order').order('title');
    if (error) { mOpenSheet(head + '<div class="loading">Could not load duties: ' + escHtml(error.message) + '</div>' + foot); return; }
    mTasks = data;
  }
  const slots = mTaskSlots(d.getDay());
  const slot = s.role === 'bartender' ? (slots.length === 1 ? slots[0] : slots.find((x) => x.period === s.period)) : null;
  const duties = slot ? mTasksFor(s.shift_date, slot.covers) : [];
  let body = '';
  Object.keys(M_TASK_CATEGORIES).forEach((cat) => {
    const list = duties.filter((t) => t.category === cat);
    if (!list.length) return;
    body += '<label class="admin-label m-sheet-label">' + M_TASK_CATEGORIES[cat] + '</label>'
      + list.map((t) => '<div class="m-duty"><div class="m-task-target-name">' + escHtml(t.title) + '</div>' + (t.instructions ? '<div class="m-task-notes" style="margin-top:2px;">' + escHtml(t.instructions) + '</div>' : '') + '</div>').join('');
  });
  mOpenSheet(head + (body || '<div class="loading">No duties are assigned to this shift.</div>') + foot);
}

function toggleCoverForm(shiftId) {
  mCoverFormShiftId = shiftId;
  renderMyUpcomingShifts();
}

async function submitCoverageRequest(shiftId) {
  const note = document.getElementById('m-cover-note').value.trim();
  const { error } = await window.supabase.from('coverage_requests')
    .insert({ shift_id: shiftId, requested_by: window.currentStaff.id, note: note || null });
  if (error) { toast('Error: ' + error.message, true); return; }
  toast('Coverage requested');
  mCoverFormShiftId = null;
  loadMyUpcomingShifts();
}

async function cancelCoverageRequest(requestId) {
  const { error } = await window.supabase.from('coverage_requests').delete().eq('id', requestId);
  if (error) { toast('Error: ' + error.message, true); return; }
  toast('Request cancelled');
  loadMyUpcomingShifts();
}

// ── COVERAGE REQUESTS (open, from other staff) ────────────
async function loadCoverageRequests() {
  const el = document.getElementById('m-coverage-requests');
  const { data, error } = await window.supabase.from('coverage_requests')
    .select('*, shifts(shift_date, role, period, start_time, end_time), requester:requested_by(name)').eq('status', 'open');
  if (error) { el.innerHTML = '<div class="loading">Error: ' + escHtml(error.message) + '</div>'; return; }

  // Your own requests show on the shift itself, above.
  const todayStr = toDateStr(new Date());
  const rows = (data || []).filter((r) => r.shifts && r.shifts.shift_date >= todayStr && !mMyStaffIds.includes(r.requested_by))
    .sort((a, b) => a.shifts.shift_date.localeCompare(b.shifts.shift_date));
  if (!rows.length) { el.innerHTML = '<div class="loading">No one needs coverage right now</div>'; return; }
  el.innerHTML = rows.map((r) => shiftRowHtml(r.shifts,
    '<button class="btn btn-sm btn-primary" onclick="claimCoverageRequest(\'' + r.id + '\')">I\'ll Cover</button>',
    escHtml((r.requester && r.requester.name) || 'Staff') + (r.note ? ' · ' + escHtml(r.note) : ''))).join('');
}

// Filters the update to requests still open so two people tapping
// "I'll Cover" on the same request can't both win it.
async function claimCoverageRequest(requestId) {
  if (!confirm('Cover this shift? The team will be told you\'ve picked it up.')) return;
  const { data, error } = await window.supabase.from('coverage_requests')
    .update({ status: 'claimed', claimed_by: window.currentStaff.id, claimed_at: new Date().toISOString() })
    .eq('id', requestId).eq('status', 'open').select();
  if (error) { toast('Error: ' + error.message, true); return; }
  if (!data || !data.length) { toast('Someone already covered that shift', true); loadCoverageRequests(); return; }
  toast('You\'re covering it — a manager will update the schedule');
  loadCoverageRequests();
  notifyCoverageClaimed(requestId);
}

// Best-effort — email is optional (needs RESEND_API_KEY in Vercel) and
// should never block the claim itself if it fails.
async function notifyCoverageClaimed(requestId) {
  try {
    const { data: { session } } = await window.supabase.auth.getSession();
    if (!session) return;
    await fetch('/api/notify-coverage-claimed', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + session.access_token },
      body: JSON.stringify({ requestId }),
    });
  } catch (e) { /* best-effort, never block the UI on this */ }
}

// ── OPEN SHIFTS (never assigned, anyone can claim) ────────
async function loadOpenShifts() {
  const el = document.getElementById('m-open-shifts');
  const { data, error } = await window.supabase.from('shifts').select('*')
    .is('staff_id', null).gte('shift_date', toDateStr(new Date())).order('shift_date').order('start_time');
  if (error) { el.innerHTML = '<div class="loading">Error: ' + escHtml(error.message) + '</div>'; return; }
  if (!data || !data.length) { el.innerHTML = '<div class="loading">No open shifts right now</div>'; return; }
  el.innerHTML = data.map((s) => shiftRowHtml(s, '<button class="btn btn-sm btn-primary" onclick="claimOpenShift(\'' + s.id + '\')">Claim</button>')).join('');
}

// Filters the update to rows still unassigned (staff_id is null) so
// two people tapping "Claim" on the same shift can't both win it.
async function claimOpenShift(shiftId) {
  const { data, error } = await window.supabase.from('shifts')
    .update({ staff_id: window.currentStaff.id, claimed_by: window.currentStaff.id, claimed_at: new Date().toISOString() })
    .eq('id', shiftId).is('staff_id', null).select();
  if (error) { toast('Error: ' + error.message, true); return; }
  if (!data || !data.length) { toast('Someone already claimed that shift', true); loadOpenShifts(); return; }
  toast('Shift claimed — it\'s yours now');
  loadMyUpcomingShifts();
  loadOpenShifts();
  loadScheduleCalendar();
}
