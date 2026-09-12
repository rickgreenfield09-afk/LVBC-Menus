// myshifts.js
// Screen: #screen-myshifts — the logged-in staffer's own calendar +
// blackout dates. Rows are gated by RLS to the caller's own
// staff_id (see supabase/schema.sql, migration_009). Also offers an
// "email me this schedule" send (via /api/send-schedule, needs
// RESEND_API_KEY configured in Vercel) and an .ics download for
// importing the month into a phone calendar.
// Depends on: window.supabase, window.currentStaff, toast(),
// escHtml() (menu.js), toDateStr/staffName/fmtTime/dowHeaderHtml
// (schedule.js), scheduleStaff/scheduleDaySettings (schedule.js)

let myShiftsCursor = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
let myShiftsData = [];
let myModData = [];
let myBlackouts = [];
let myStaffIds = [];

// A shift assigned to a duplicate/placeholder profile (same name,
// different id — see migration_008/014) won't match the logged-in
// session's own id. Resolve every staff_profiles row sharing this
// session's email so those still show up here.
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

async function loadMyShifts() {
  if (!scheduleDaySettings.length) await loadStaffAndSettings();
  myStaffIds = await resolveMyStaffIds();
  await loadMyBlackouts();
  renderBlackoutRecurringPicker();
  renderOneOffBlackoutList();
  renderBlackoutDatePicker();
  await loadMyShiftsMonth();
  await loadCoverageRequestsList();
}

// ── COVERAGE REQUESTS (open, from any staffer) ────────────
async function loadCoverageRequestsList() {
  const el = document.getElementById('coverage-requests-list');
  el.innerHTML = '<div class="loading">Loading...</div>';
  const { data, error } = await window.supabase.from('coverage_requests')
    .select('*, shifts(shift_date, role, period, start_time, end_time)').eq('status', 'open').order('created_at', { ascending: false });
  if (error) { el.innerHTML = '<div class="loading">Error: ' + escHtml(error.message) + '</div>'; return; }
  renderCoverageRequestsList(data || []);
}

function renderCoverageRequestsList(requests) {
  const el = document.getElementById('coverage-requests-list');
  if (!requests.length) { el.innerHTML = '<div class="loading">No open requests</div>'; return; }
  el.innerHTML = requests.map((r) => {
    const s = r.shifts || {};
    const d = s.shift_date ? new Date(s.shift_date + 'T00:00:00') : null;
    const label = (s.role === 'manager' ? 'Manager on Duty' : (s.period === 'morning' ? 'Morning' : 'Evening'));
    const isMine = myStaffIds.includes(r.requested_by);
    return '<div class="shift-row">'
      + '<div><div class="shift-row-name">' + (d ? d.toLocaleDateString('default', { weekday: 'short', month: 'short', day: 'numeric' }) : '') + ' · ' + escHtml(label) + '</div>'
      + '<div class="shift-row-meta">' + escHtml(staffName(r.requested_by)) + (s.start_time ? ' · ' + fmtTime(s.start_time) + (s.end_time ? '–' + fmtTime(s.end_time) : '') : '') + (r.note ? ' · ' + escHtml(r.note) : '') + '</div></div>'
      + (isMine
        ? '<button class="btn btn-sm btn-danger" onclick="cancelMyCoverageRequest(\'' + r.id + '\')">Cancel</button>'
        : '<button class="btn btn-sm btn-primary" onclick="claimCoverageRequest(\'' + r.id + '\')">I\'ll Cover This</button>')
      + '</div>';
  }).join('');
}

async function claimCoverageRequest(requestId) {
  const { error } = await window.supabase.from('coverage_requests')
    .update({ status: 'claimed', claimed_by: window.currentStaff.id, claimed_at: new Date().toISOString() }).eq('id', requestId);
  if (error) { toast('Error: ' + error.message, true); return; }
  toast('Marked as covered — remember to update the shift assignment');
  loadCoverageRequestsList();
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

async function cancelMyCoverageRequest(requestId) {
  const { error } = await window.supabase.from('coverage_requests').delete().eq('id', requestId);
  if (error) { toast('Error: ' + error.message, true); return; }
  toast('Request cancelled');
  loadCoverageRequestsList();
}

function myShiftsMonth(delta) {
  myShiftsCursor = new Date(myShiftsCursor.getFullYear(), myShiftsCursor.getMonth() + delta, 1);
  loadMyShiftsMonth();
}

async function loadMyShiftsMonth() {
  const grid = document.getElementById('myshifts-cal-grid');
  grid.innerHTML = '<div class="loading">Loading...</div>';
  document.getElementById('myshifts-month-label').textContent = myShiftsCursor.toLocaleString('default', { month: 'long', year: 'numeric' });
  document.getElementById('myshifts-email-status').textContent = '';

  const monthStart = toDateStr(new Date(myShiftsCursor.getFullYear(), myShiftsCursor.getMonth(), 1));
  const monthEnd = toDateStr(new Date(myShiftsCursor.getFullYear(), myShiftsCursor.getMonth() + 1, 0));

  const [{ data: mine, error: mineErr }, { data: mods }] = await Promise.all([
    window.supabase.from('shifts').select('*').in('staff_id', myStaffIds).gte('shift_date', monthStart).lte('shift_date', monthEnd),
    window.supabase.from('shifts').select('*').eq('role', 'manager').gte('shift_date', monthStart).lte('shift_date', monthEnd),
  ]);
  if (mineErr) { grid.innerHTML = '<div class="loading">Error: ' + escHtml(mineErr.message) + '</div>'; return; }
  myShiftsData = mine || [];
  myModData = mods || [];
  renderMyShiftsCalendar();
}

function dateIsBlackedOut(dateStr) {
  const dow = new Date(dateStr + 'T00:00:00').getDay();
  return myBlackouts.some((b) => (b.kind === 'recurring' && b.day_of_week === dow) || (b.kind === 'date' && b.blackout_date === dateStr));
}

function myShiftDayCellHtml(dateObj) {
  const dateStr = toDateStr(dateObj);
  const dow = dateObj.getDay();
  const setting = scheduleDaySettings.find((s) => s.day_of_week === dow) || {};
  const isToday = dateStr === toDateStr(new Date());
  const blacked = dateIsBlackedOut(dateStr);
  const cls = 'cal-day' + (isToday ? ' today' : '') + (blacked ? ' blacked-out' : '');

  if (setting.is_closed) {
    return '<div class="' + cls + ' closed"><div class="cal-day-num">' + dateObj.getDate() + '</div><div class="cal-closed-label">Closed</div></div>';
  }

  const mine = myShiftsData.filter((s) => s.shift_date === dateStr);
  const dayLevelMods = myModData.filter((s) => s.shift_date === dateStr && !s.period);
  const halves = [];
  if (setting.morning_start) halves.push('morning');
  if (setting.evening_start) halves.push('evening');
  const isMe = (m) => myStaffIds.includes(m.staff_id);
  const modName = (m) => escHtml(isMe(m) ? 'you' : staffName(m.staff_id));

  let html = '<div class="' + cls + '" onclick="openShiftModal(\'' + dateStr + '\', \'myshifts\')">';
  html += '<div class="cal-day-num">' + dateObj.getDate() + '</div>';
  dayLevelMods.forEach((m) => { html += '<div class="cal-mod-pill' + (isMe(m) ? ' mine' : '') + '">MOD: ' + modName(m) + '</div>'; });
  html += '<div class="cal-day-split">';
  halves.forEach((period) => {
    html += '<div class="cal-half">';
    myModData.filter((s) => s.shift_date === dateStr && s.period === period).forEach((m) => {
      html += '<div class="cal-mod-pill' + (isMe(m) ? ' mine' : '') + '">MOD: ' + modName(m) + '</div>';
    });
    mine.filter((s) => s.role === 'bartender' && s.period === period).forEach((s) => {
      html += '<div class="cal-pill-emp mine">' + shiftSlotLabel(setting, period) + (s.start_time ? ' · ' + fmtTime(s.start_time) : '') + '</div>';
    });
    html += '</div>';
  });
  html += '</div>';
  if (blacked) html += '<div class="cal-pill-event" style="background:rgba(224,82,82,0.12);border-color:rgba(224,82,82,0.3);color:var(--red);">Blacked out</div>';
  html += '</div>';
  return html;
}

function renderMyShiftsCalendar() {
  const grid = document.getElementById('myshifts-cal-grid');
  const monthStart = new Date(myShiftsCursor.getFullYear(), myShiftsCursor.getMonth(), 1);
  const monthEnd = new Date(myShiftsCursor.getFullYear(), myShiftsCursor.getMonth() + 1, 0);
  let html = dowHeaderHtml();
  const firstDow = monthStart.getDay();
  for (let i = 0; i < firstDow; i++) html += '<div class="cal-day other-month"></div>';
  for (let d = new Date(monthStart); d <= monthEnd; d.setDate(d.getDate() + 1)) html += myShiftDayCellHtml(new Date(d));
  grid.innerHTML = html;
}

// ── BLACKOUT DATES ─────────────────────────────────────────
async function loadMyBlackouts() {
  const { data, error } = await window.supabase.from('blackout_dates').select('*').eq('staff_id', window.currentStaff.id);
  if (error) { toast('Error loading blackout dates: ' + error.message, true); myBlackouts = []; return; }
  myBlackouts = data || [];
}

function renderBlackoutRecurringPicker() {
  const el = document.getElementById('blackout-recurring-picker');
  el.innerHTML = scheduleDaySettings.filter((s) => !s.is_closed).map((s) => {
    const active = myBlackouts.some((b) => b.kind === 'recurring' && b.day_of_week === s.day_of_week);
    return '<div class="badge-pill' + (active ? ' selected red' : '') + '" style="cursor:pointer;" onclick="toggleRecurringBlackout(' + s.day_of_week + ')">' + escHtml(s.label) + '</div>';
  }).join('');
}

async function toggleRecurringBlackout(dow) {
  const existing = myBlackouts.find((b) => b.kind === 'recurring' && b.day_of_week === dow);
  if (existing) {
    const { error } = await window.supabase.from('blackout_dates').delete().eq('id', existing.id);
    if (error) { toast('Error: ' + error.message, true); return; }
    myBlackouts = myBlackouts.filter((b) => b.id !== existing.id);
  } else {
    const { data, error } = await window.supabase.from('blackout_dates').insert({ staff_id: window.currentStaff.id, kind: 'recurring', day_of_week: dow }).select().single();
    if (error) { toast('Error: ' + error.message, true); return; }
    myBlackouts.push(data);
  }
  renderBlackoutRecurringPicker();
  renderMyShiftsCalendar();
}

let blackoutPickerCursor = new Date(new Date().getFullYear(), new Date().getMonth(), 1);

function blackoutPickerMonth(delta) {
  blackoutPickerCursor = new Date(blackoutPickerCursor.getFullYear(), blackoutPickerCursor.getMonth() + delta, 1);
  renderBlackoutDatePicker();
}

function renderBlackoutDatePicker() {
  const el = document.getElementById('blackout-date-picker');
  document.getElementById('blackout-picker-label').textContent = blackoutPickerCursor.toLocaleString('default', { month: 'long', year: 'numeric' });
  const monthStart = new Date(blackoutPickerCursor.getFullYear(), blackoutPickerCursor.getMonth(), 1);
  const monthEnd = new Date(blackoutPickerCursor.getFullYear(), blackoutPickerCursor.getMonth() + 1, 0);
  const todayStr = toDateStr(new Date());

  let html = dowHeaderHtml();
  const firstDow = monthStart.getDay();
  for (let i = 0; i < firstDow; i++) html += '<div class="bk-date-cell disabled"></div>';
  for (let d = new Date(monthStart); d <= monthEnd; d.setDate(d.getDate() + 1)) {
    const dateStr = toDateStr(d);
    const blocked = myBlackouts.some((b) => b.kind === 'date' && b.blackout_date === dateStr);
    const isToday = dateStr === todayStr;
    html += '<div class="bk-date-cell blockable' + (blocked ? ' blocked' : '') + (isToday ? ' today-outline' : '') + '" onclick="toggleOneOffBlackoutFromPicker(\'' + dateStr + '\')">' + d.getDate() + '</div>';
  }
  el.innerHTML = html;
}

async function toggleOneOffBlackoutFromPicker(dateStr) {
  const dow = new Date(dateStr + 'T00:00:00').getDay();
  if (myBlackouts.some((b) => b.kind === 'recurring' && b.day_of_week === dow)) {
    toast('This weekday is already blacked out every week', true);
    return;
  }
  const existing = myBlackouts.find((b) => b.kind === 'date' && b.blackout_date === dateStr);
  if (existing) {
    const { error } = await window.supabase.from('blackout_dates').delete().eq('id', existing.id);
    if (error) { toast('Error: ' + error.message, true); return; }
    myBlackouts = myBlackouts.filter((b) => b.id !== existing.id);
    toast('Blackout removed');
  } else {
    const { data, error } = await window.supabase.from('blackout_dates').insert({ staff_id: window.currentStaff.id, kind: 'date', blackout_date: dateStr }).select().single();
    if (error) { toast('Error: ' + error.message, true); return; }
    myBlackouts.push(data);
    toast('Date blacked out');
  }
  renderBlackoutDatePicker();
  renderOneOffBlackoutList();
  renderMyShiftsCalendar();
}

function renderOneOffBlackoutList() {
  const el = document.getElementById('blackout-oneoff-list');
  const list = myBlackouts.filter((b) => b.kind === 'date').sort((a, b) => a.blackout_date.localeCompare(b.blackout_date));
  if (!list.length) { el.innerHTML = '<div class="loading">No specific dates blacked out</div>'; return; }
  el.innerHTML = list.map((b) => {
    const d = new Date(b.blackout_date + 'T00:00:00');
    return '<div class="shift-row"><div class="shift-row-name">' + d.toLocaleDateString('default', { month: 'short', day: 'numeric', year: 'numeric' }) + '</div>'
      + '<button class="btn btn-sm btn-danger" onclick="removeOneOffBlackout(\'' + b.id + '\')">Remove</button></div>';
  }).join('');
}

async function removeOneOffBlackout(id) {
  const { error } = await window.supabase.from('blackout_dates').delete().eq('id', id);
  if (error) { toast('Error: ' + error.message, true); return; }
  myBlackouts = myBlackouts.filter((b) => b.id !== id);
  renderOneOffBlackoutList();
  renderMyShiftsCalendar();
}

// ── EMAIL + CALENDAR EXPORT ────────────────────────────────
async function emailMySchedule() {
  const statusEl = document.getElementById('myshifts-email-status');
  statusEl.textContent = 'Sending...';
  const { data: { session } } = await window.supabase.auth.getSession();
  if (!session) { statusEl.textContent = 'Not signed in.'; return; }

  try {
    const res = await fetch('/api/send-schedule', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + session.access_token },
      body: JSON.stringify({ email: session.user.email, month: myShiftsCursor.getMonth() + 1, year: myShiftsCursor.getFullYear() }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) { statusEl.textContent = 'Error: ' + (body.error || res.statusText); return; }
    statusEl.textContent = 'Sent to ' + session.user.email + '.';
  } catch (e) {
    statusEl.textContent = 'Error: ' + e.message;
  }
}

function buildIcsForMyShifts() {
  const pad = (n) => String(n).padStart(2, '0');
  const fmtDt = (dateStr, timeStr) => {
    const [y, m, d] = dateStr.split('-');
    const [hh, mm] = (timeStr || '00:00').split(':');
    return y + m + d + 'T' + pad(hh) + pad(mm) + '00';
  };
  let ics = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//LVBC//Schedule//EN\r\n';
  myShiftsData.forEach((s) => {
    const shiftSetting = scheduleDaySettings.find((x) => x.day_of_week === new Date(s.shift_date + 'T00:00:00').getDay()) || {};
    const label = s.role === 'manager' ? 'LVBC - Manager on Duty' : 'LVBC - Bartender Shift (' + shiftSlotLabel(shiftSetting, s.period) + ')';
    ics += 'BEGIN:VEVENT\r\nUID:' + s.id + '@lvbc-menus\r\nDTSTART:' + fmtDt(s.shift_date, s.start_time || '09:00')
      + '\r\nDTEND:' + fmtDt(s.shift_date, s.end_time || '17:00') + '\r\nSUMMARY:' + label + '\r\nEND:VEVENT\r\n';
  });
  ics += 'END:VCALENDAR\r\n';
  return ics;
}

function downloadMyScheduleIcs() {
  if (!myShiftsData.length) { toast('No shifts this month', true); return; }
  const blob = new Blob([buildIcsForMyShifts()], { type: 'text/calendar' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'lvbc-schedule-' + myShiftsCursor.getFullYear() + '-' + String(myShiftsCursor.getMonth() + 1).padStart(2, '0') + '.ics';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
