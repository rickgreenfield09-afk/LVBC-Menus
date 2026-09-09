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

async function loadMyShifts() {
  if (!scheduleDaySettings.length) await loadStaffAndSettings();
  await loadMyBlackouts();
  renderBlackoutRecurringPicker();
  renderOneOffBlackoutList();
  await loadMyShiftsMonth();
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
    window.supabase.from('shifts').select('*').eq('staff_id', window.currentStaff.id).gte('shift_date', monthStart).lte('shift_date', monthEnd),
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
  const mod = myModData.find((s) => s.shift_date === dateStr);

  let html = '<div class="' + cls + '" onclick="toggleBlackoutForDate(\'' + dateStr + '\')" title="Click to toggle a blackout for this date">';
  html += '<div class="cal-day-num">' + dateObj.getDate() + '</div>';
  if (mod) html += '<div class="cal-mod-pill">MOD: ' + escHtml(mod.staff_id === window.currentStaff.id ? 'you' : staffName(mod.staff_id)) + '</div>';
  mine.forEach((s) => {
    const label = s.role === 'manager' ? 'MOD (you)' : (s.period === 'morning' ? 'Morning' : 'Evening');
    html += '<div class="cal-pill-emp">' + label + (s.start_time ? ' · ' + fmtTime(s.start_time) : '') + '</div>';
  });
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

async function addOneOffBlackout() {
  const val = document.getElementById('blackout-date-input').value;
  if (!val) { toast('Pick a date', true); return; }
  if (myBlackouts.some((b) => b.kind === 'date' && b.blackout_date === val)) { toast('Already blacked out', true); return; }
  const { data, error } = await window.supabase.from('blackout_dates').insert({ staff_id: window.currentStaff.id, kind: 'date', blackout_date: val }).select().single();
  if (error) { toast('Error: ' + error.message, true); return; }
  myBlackouts.push(data);
  document.getElementById('blackout-date-input').value = '';
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

async function toggleBlackoutForDate(dateStr) {
  const dow = new Date(dateStr + 'T00:00:00').getDay();
  if (myBlackouts.some((b) => b.kind === 'recurring' && b.day_of_week === dow)) {
    toast('This weekday is already blacked out every week — see Blackout Dates below', true);
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
  renderMyShiftsCalendar();
  renderOneOffBlackoutList();
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
    const label = s.role === 'manager' ? 'LVBC - Manager on Duty' : 'LVBC - Bartender Shift (' + (s.period === 'morning' ? 'Morning' : 'Evening') + ')';
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
