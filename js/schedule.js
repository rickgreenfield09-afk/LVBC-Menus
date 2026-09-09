// schedule.js
// Screen: #screen-schedule (sub-tabs: Calendar, Scheduling, Settings)
// Everyone signed in can view; adding/removing shifts and editing
// settings is gated by window.currentStaff.can_schedule (also
// enforced by RLS — see supabase/schema.sql). Scope: view + manual
// assign + weekday bulk-assign + settings. No coverage requests,
// trades, or email sending yet (HANDOFF.md has the full module).
// Depends on: window.supabase, toast(), escHtml() (from menu.js)

let scheduleCursor = new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate());
let scheduleViewMode = 'month';
let scheduleShifts = [];
let scheduleEvents = [];
let scheduleStaff = [];
let scheduleDaySettings = [];
let scheduleSettings = null;
let scheduleActiveDate = null;

function canSchedule() {
  return !!(window.currentStaff && (window.currentStaff.can_schedule || window.currentStaff.role === 'admin'));
}

function toDateStr(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function staffName(id) {
  const s = scheduleStaff.find((x) => x.id === id);
  return s ? s.name : 'Unassigned';
}

function fmtTime(t) {
  if (!t) return '';
  const [h, m] = t.split(':');
  const hr = ((+h + 11) % 12) + 1;
  return hr + (m === '00' ? '' : ':' + m) + (+h < 12 ? 'am' : 'pm');
}

// ── ENTRY ────────────────────────────────────────────────
async function loadStaffAndSettings() {
  const [{ data: staffData }, { data: daySettingsData }, { data: settingsData }] = await Promise.all([
    window.supabase.from('staff_profiles').select('id,name').order('name'),
    window.supabase.from('shift_day_settings').select('*').order('day_of_week'),
    window.supabase.from('schedule_settings').select('*').limit(1),
  ]);
  scheduleStaff = staffData || [];
  scheduleDaySettings = daySettingsData || [];
  scheduleSettings = (settingsData && settingsData[0]) || null;
}

async function loadSchedule() {
  await loadStaffAndSettings();

  document.getElementById('bulk-form-col').style.display = canSchedule() ? '' : 'none';
  document.getElementById('btn-save-day-settings').style.display = canSchedule() ? '' : 'none';
  document.getElementById('btn-save-schedule-settings').style.display = canSchedule() ? '' : 'none';
  ['set-timeout', 'set-tpl-coverage', 'set-tpl-trade', 'set-tpl-sent'].forEach((id) => {
    document.getElementById(id).disabled = !canSchedule();
  });

  populateBulkSelectors();
  renderDaySettingsRows();
  populateScheduleSettingsForm();
  await loadScheduleRange();
}

function setScheduleTab(tab, btn) {
  document.querySelectorAll('#screen-schedule > .sub-tabs .sub-tab').forEach((b) => b.classList.remove('active'));
  document.querySelectorAll('#screen-schedule > .sub-sec').forEach((s) => s.classList.remove('active'));
  btn.classList.add('active');
  document.getElementById('scheduletab-' + tab).classList.add('active');
  if (tab === 'bulk') loadBulkShiftList();
  if (tab === 'settings') { renderDaySettingsRows(); populateScheduleSettingsForm(); }
}

// ── CALENDAR: NAVIGATION ─────────────────────────────────
function setScheduleView(mode) {
  scheduleViewMode = mode;
  ['month', 'week', 'day'].forEach((m) => document.getElementById('cal-view-' + m).classList.toggle('active', m === mode));
  loadScheduleRange();
}

function scheduleShiftPeriod(delta) {
  if (scheduleViewMode === 'month') {
    scheduleCursor = new Date(scheduleCursor.getFullYear(), scheduleCursor.getMonth() + delta, 1);
  } else {
    const d = new Date(scheduleCursor);
    d.setDate(d.getDate() + (scheduleViewMode === 'week' ? 7 * delta : delta));
    scheduleCursor = d;
  }
  loadScheduleRange();
}

function scheduleGoToday() {
  const now = new Date();
  scheduleCursor = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  loadScheduleRange();
}

function getVisibleRange() {
  if (scheduleViewMode === 'month') {
    return {
      start: new Date(scheduleCursor.getFullYear(), scheduleCursor.getMonth(), 1),
      end: new Date(scheduleCursor.getFullYear(), scheduleCursor.getMonth() + 1, 0),
    };
  }
  if (scheduleViewMode === 'week') {
    const start = new Date(scheduleCursor);
    start.setDate(scheduleCursor.getDate() - scheduleCursor.getDay());
    const end = new Date(start);
    end.setDate(start.getDate() + 6);
    return { start, end };
  }
  const d = new Date(scheduleCursor.getFullYear(), scheduleCursor.getMonth(), scheduleCursor.getDate());
  return { start: d, end: d };
}

function periodLabel() {
  const { start, end } = getVisibleRange();
  if (scheduleViewMode === 'month') return scheduleCursor.toLocaleString('default', { month: 'long', year: 'numeric' });
  if (scheduleViewMode === 'week') {
    return start.toLocaleDateString('default', { month: 'short', day: 'numeric' }) + ' – ' +
      end.toLocaleDateString('default', { month: 'short', day: 'numeric', year: 'numeric' });
  }
  return start.toLocaleDateString('default', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
}

// ── CALENDAR: LOAD + RENDER ──────────────────────────────
async function loadScheduleRange() {
  const grid = document.getElementById('schedule-cal-grid');
  grid.innerHTML = '<div class="loading">Loading...</div>';
  const { start, end } = getVisibleRange();
  const startStr = toDateStr(start);
  const endExclusive = new Date(end); endExclusive.setDate(endExclusive.getDate() + 1);

  const [{ data: shiftData, error: shiftErr }, { data: eventData, error: eventErr }] = await Promise.all([
    window.supabase.from('shifts').select('*').gte('shift_date', startStr).lte('shift_date', toDateStr(end)),
    window.supabase.from('events').select('*').gte('event_date', startStr + 'T00:00:00').lt('event_date', toDateStr(endExclusive) + 'T00:00:00'),
  ]);

  if (shiftErr) { grid.innerHTML = '<div class="loading">Error: ' + escHtml(shiftErr.message) + '</div>'; return; }
  scheduleShifts = shiftData || [];
  scheduleEvents = eventErr ? [] : (eventData || []);
  renderScheduleCalendar();
}

function dowHeaderHtml() {
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d) => '<div class="cal-dow">' + d + '</div>').join('');
}

function dayCellHtml(dateObj, extraClass) {
  const dateStr = toDateStr(dateObj);
  const dow = dateObj.getDay();
  const setting = scheduleDaySettings.find((s) => s.day_of_week === dow) || {};
  const isToday = dateStr === toDateStr(new Date());
  const cls = 'cal-day' + (extraClass ? ' ' + extraClass : '') + (isToday ? ' today' : '');

  if (setting.is_closed) {
    return '<div class="' + cls + ' closed" onclick="openShiftModal(\'' + dateStr + '\')">'
      + '<div class="cal-day-num">' + dateObj.getDate() + '</div><div class="cal-closed-label">Closed</div></div>';
  }

  const dayShifts = scheduleShifts.filter((s) => s.shift_date === dateStr);
  const mod = dayShifts.find((s) => s.role === 'manager');
  const dayEvents = scheduleEvents.filter((e) => toDateStr(new Date(e.event_date)) === dateStr);
  const halves = [];
  if (setting.morning_start) halves.push('morning');
  if (setting.evening_start) halves.push('evening');

  let html = '<div class="' + cls + '" onclick="openShiftModal(\'' + dateStr + '\')">';
  html += '<div class="cal-day-num">' + dateObj.getDate() + '</div>';
  if (mod) html += '<div class="cal-mod-pill">MOD: ' + escHtml(staffName(mod.staff_id)) + '</div>';
  html += '<div class="cal-day-split">';
  halves.forEach((period) => {
    html += '<div class="cal-half">';
    dayShifts.filter((s) => s.role === 'bartender' && s.period === period).forEach((s) => {
      html += '<div class="cal-pill-emp">' + escHtml(staffName(s.staff_id)) + '</div>';
    });
    dayEvents.filter((e) => {
      if (halves.length === 1) return true;
      return period === 'morning' ? new Date(e.event_date).getHours() < 15 : new Date(e.event_date).getHours() >= 15;
    }).forEach((e) => {
      html += '<div class="cal-pill-event">' + escHtml(e.event_name) + '</div>';
    });
    html += '</div>';
  });
  html += '</div></div>';
  return html;
}

function renderScheduleCalendar() {
  const grid = document.getElementById('schedule-cal-grid');
  const { start, end } = getVisibleRange();
  grid.className = 'cal-grid' + (scheduleViewMode !== 'month' ? ' view-' + scheduleViewMode : '');
  document.getElementById('schedule-period-label').textContent = periodLabel();
  document.getElementById('schedule-print-title').textContent = periodLabel();

  let html = '';
  if (scheduleViewMode === 'month') {
    html += dowHeaderHtml();
    const firstDow = start.getDay();
    for (let i = 0; i < firstDow; i++) html += '<div class="cal-day other-month"></div>';
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) html += dayCellHtml(new Date(d));
  } else if (scheduleViewMode === 'week') {
    html += dowHeaderHtml();
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) html += dayCellHtml(new Date(d));
  } else {
    html += dayCellHtml(new Date(start));
  }
  grid.innerHTML = html;
}

// ── DAY MODAL ─────────────────────────────────────────────
function openShiftModal(dateStr) {
  scheduleActiveDate = dateStr;
  const dow = new Date(dateStr + 'T00:00:00').getDay();
  const setting = scheduleDaySettings.find((s) => s.day_of_week === dow) || {};
  const d = new Date(dateStr + 'T00:00:00');
  document.getElementById('shift-modal-date').textContent = d.toLocaleDateString('default', { weekday: 'long', month: 'long', day: 'numeric' });

  const staffSel = document.getElementById('sm-staff');
  staffSel.innerHTML = scheduleStaff.map((s) => '<option value="' + s.id + '">' + escHtml(s.name) + '</option>').join('');

  let opts = '';
  if (setting.morning_start) opts += '<option value="morning">Bartender - Morning</option>';
  if (setting.evening_start) opts += '<option value="evening">Bartender - Evening</option>';
  opts += '<option value="manager">Manager on Duty</option>';
  document.getElementById('sm-role').innerHTML = opts;
  document.getElementById('sm-notes').value = '';

  document.getElementById('shift-modal-form-wrap').style.display = (canSchedule() && !setting.is_closed) ? '' : 'none';

  onShiftModalRoleChange();
  renderShiftModalList();
  document.getElementById('shift-modal').style.display = 'flex';
}

function closeShiftModal() {
  document.getElementById('shift-modal').style.display = 'none';
  scheduleActiveDate = null;
}

function onShiftModalRoleChange() {
  const dow = new Date(scheduleActiveDate + 'T00:00:00').getDay();
  const setting = scheduleDaySettings.find((s) => s.day_of_week === dow) || {};
  const val = document.getElementById('sm-role').value;
  let start = null, end = null;
  if (val === 'morning') { start = setting.morning_start; end = setting.morning_end; }
  else if (val === 'evening') { start = setting.evening_start; end = setting.evening_end; }
  else { start = setting.morning_start || setting.evening_start; end = setting.evening_end || setting.morning_end; }
  document.getElementById('sm-start').value = (start || '').slice(0, 5);
  document.getElementById('sm-end').value = (end || '').slice(0, 5);
}

function renderShiftModalList() {
  const listEl = document.getElementById('shift-modal-list');
  const dow = new Date(scheduleActiveDate + 'T00:00:00').getDay();
  const setting = scheduleDaySettings.find((s) => s.day_of_week === dow) || {};
  if (setting.is_closed) { listEl.innerHTML = '<div class="loading">Bar is closed this day.</div>'; return; }

  const shifts = scheduleShifts.filter((s) => s.shift_date === scheduleActiveDate)
    .sort((a, b) => (a.role === 'manager' ? -1 : 1) - (b.role === 'manager' ? -1 : 1) || (a.period || '').localeCompare(b.period || ''));
  if (!shifts.length) { listEl.innerHTML = '<div class="loading">No shifts scheduled</div>'; return; }

  listEl.innerHTML = shifts.map((s) => {
    const label = s.role === 'manager' ? 'Manager on Duty' : (s.period === 'morning' ? 'Morning' : 'Evening');
    return '<div class="shift-row">'
      + '<div><div class="shift-row-name">' + escHtml(staffName(s.staff_id)) + (s.role === 'manager' ? ' <span class="badge badge-amber">MOD</span>' : '') + '</div>'
      + '<div class="shift-row-meta">' + label + (s.start_time ? ' · ' + fmtTime(s.start_time) + (s.end_time ? '–' + fmtTime(s.end_time) : '') : '') + (s.notes ? ' · ' + escHtml(s.notes) : '') + '</div></div>'
      + (canSchedule() ? '<button class="btn btn-sm btn-danger" onclick="deleteShift(\'' + s.id + '\')">Remove</button>' : '')
      + '</div>';
  }).join('');
}

async function addShift() {
  if (!canSchedule()) return;
  const staffId = document.getElementById('sm-staff').value;
  if (!staffId) { toast('Select a staff member', true); return; }
  const val = document.getElementById('sm-role').value;
  const role = val === 'manager' ? 'manager' : 'bartender';
  const period = val === 'manager' ? null : val;
  const payload = {
    shift_date: scheduleActiveDate,
    staff_id: staffId,
    role, period,
    start_time: document.getElementById('sm-start').value || null,
    end_time: document.getElementById('sm-end').value || null,
    notes: document.getElementById('sm-notes').value.trim() || null,
  };
  const { data, error } = await window.supabase.from('shifts').insert(payload).select().single();
  if (error) { toast('Error: ' + error.message, true); return; }
  scheduleShifts.push(data);
  document.getElementById('sm-notes').value = '';
  renderShiftModalList();
  renderScheduleCalendar();
  toast('Shift added');
}

async function deleteShift(id) {
  if (!canSchedule()) return;
  const { error } = await window.supabase.from('shifts').delete().eq('id', id);
  if (error) { toast('Error: ' + error.message, true); return; }
  scheduleShifts = scheduleShifts.filter((s) => s.id !== id);
  renderShiftModalList();
  renderScheduleCalendar();
  toast('Shift removed');
}

// ── BULK SCHEDULING ───────────────────────────────────────
let bulkSelectedWeekdays = new Set();
let bulkExcludedDates = new Set();

function populateBulkSelectors() {
  document.getElementById('bk-staff').innerHTML = scheduleStaff.map((s) => '<option value="' + s.id + '">' + escHtml(s.name) + '</option>').join('');
  const monthStart = new Date(scheduleCursor.getFullYear(), scheduleCursor.getMonth(), 1);
  const monthEnd = new Date(scheduleCursor.getFullYear(), scheduleCursor.getMonth() + 1, 0);
  document.getElementById('bk-from').value = toDateStr(monthStart);
  document.getElementById('bk-through').value = toDateStr(monthEnd);
  const firstOpenDay = scheduleDaySettings.find((s) => !s.is_closed);
  bulkSelectedWeekdays = new Set(firstOpenDay ? [firstOpenDay.day_of_week] : []);
  bulkExcludedDates = new Set();
  renderWeekdayPicker();
  onBulkPositionChange();
}

function renderWeekdayPicker() {
  const el = document.getElementById('bk-weekday-picker');
  el.innerHTML = scheduleDaySettings.map((s) => {
    const sel = bulkSelectedWeekdays.has(s.day_of_week);
    if (s.is_closed) return '<div class="badge-pill" style="opacity:.3;">' + escHtml(s.label.slice(0, 3)) + '</div>';
    return '<div class="badge-pill' + (sel ? ' selected' : '') + '" style="cursor:pointer;" onclick="toggleBulkWeekday(' + s.day_of_week + ')">' + escHtml(s.label.slice(0, 3)) + '</div>';
  }).join('');
}

function toggleBulkWeekday(n) {
  if (bulkSelectedWeekdays.has(n)) bulkSelectedWeekdays.delete(n); else bulkSelectedWeekdays.add(n);
  bulkExcludedDates.clear();
  renderWeekdayPicker();
  onBulkPositionChange();
}

function onBulkRangeChange() {
  bulkExcludedDates.clear();
  renderBulkDatePicker();
}

function validPositionsForSelectedWeekdays() {
  const days = scheduleDaySettings.filter((s) => bulkSelectedWeekdays.has(s.day_of_week));
  const morningOk = days.length && days.every((d) => d.morning_start);
  const eveningOk = days.length && days.every((d) => d.evening_start);
  const opts = [];
  if (morningOk) opts.push('morning');
  if (eveningOk) opts.push('evening');
  opts.push('manager');
  return opts;
}

function onBulkPositionChange() {
  const labels = { morning: 'Bartender - Morning', evening: 'Bartender - Evening', manager: 'Manager on Duty' };
  const valid = validPositionsForSelectedWeekdays();
  const posSel = document.getElementById('bk-position');
  const prev = posSel.value;
  posSel.innerHTML = valid.map((v) => '<option value="' + v + '">' + labels[v] + '</option>').join('');
  if (valid.includes(prev)) posSel.value = prev;
  renderBulkDatePicker();
}

function renderBulkDatePicker() {
  const el = document.getElementById('bk-date-picker');
  const fromStr = document.getElementById('bk-from').value;
  const throughStr = document.getElementById('bk-through').value;
  if (!fromStr) { el.innerHTML = ''; return; }
  const fromD = new Date(fromStr + 'T00:00:00');
  const throughD = throughStr ? new Date(throughStr + 'T00:00:00') : fromD;
  const monthStart = new Date(fromD.getFullYear(), fromD.getMonth(), 1);
  const monthEnd = new Date(fromD.getFullYear(), fromD.getMonth() + 1, 0);

  let html = dowHeaderHtml();
  const firstDow = monthStart.getDay();
  for (let i = 0; i < firstDow; i++) html += '<div class="bk-date-cell disabled"></div>';
  for (let d = new Date(monthStart); d <= monthEnd; d.setDate(d.getDate() + 1)) {
    const dateStr = toDateStr(d);
    const inRange = d >= fromD && d <= throughD;
    const matches = inRange && bulkSelectedWeekdays.has(d.getDay());
    if (matches) {
      const excluded = bulkExcludedDates.has(dateStr);
      html += '<div class="bk-date-cell' + (excluded ? '' : ' included') + '" onclick="toggleBulkExcludedDate(\'' + dateStr + '\')">' + d.getDate() + '</div>';
    } else {
      html += '<div class="bk-date-cell disabled">' + d.getDate() + '</div>';
    }
  }
  el.innerHTML = html;
}

function toggleBulkExcludedDate(dateStr) {
  if (bulkExcludedDates.has(dateStr)) bulkExcludedDates.delete(dateStr); else bulkExcludedDates.add(dateStr);
  renderBulkDatePicker();
}

async function applyBulkSchedule() {
  if (!canSchedule()) return;
  const alertEl = document.getElementById('bulk-alert');
  alertEl.style.display = 'none';

  const pos = document.getElementById('bk-position').value;
  const staffId = document.getElementById('bk-staff').value;
  const fromStr = document.getElementById('bk-from').value;
  const throughStr = document.getElementById('bk-through').value;
  if (!staffId || !fromStr || !throughStr || !bulkSelectedWeekdays.size) { toast('Fill in all fields', true); return; }

  const role = pos === 'manager' ? 'manager' : 'bartender';
  const period = pos === 'manager' ? null : pos;

  const dates = [];
  for (let d = new Date(fromStr + 'T00:00:00'); d <= new Date(throughStr + 'T00:00:00'); d.setDate(d.getDate() + 1)) {
    const dateStr = toDateStr(d);
    if (bulkSelectedWeekdays.has(d.getDay()) && !bulkExcludedDates.has(dateStr)) dates.push(dateStr);
  }
  if (!dates.length) { toast('No matching dates selected', true); return; }

  const { data: existing, error: exErr } = await window.supabase.from('shifts').select('shift_date,role,period').in('shift_date', dates);
  if (exErr) { toast('Error: ' + exErr.message, true); return; }
  const taken = new Set((existing || []).filter((s) => s.role === role && (role === 'manager' || s.period === period)).map((s) => s.shift_date));

  const toInsert = dates.filter((dt) => !taken.has(dt)).map((dt) => {
    const setting = scheduleDaySettings.find((s) => s.day_of_week === new Date(dt + 'T00:00:00').getDay()) || {};
    const start_time = pos === 'morning' ? setting.morning_start : (pos === 'evening' ? setting.evening_start : (setting.morning_start || setting.evening_start));
    const end_time = pos === 'morning' ? setting.morning_end : (pos === 'evening' ? setting.evening_end : (setting.evening_end || setting.morning_end));
    return { shift_date: dt, staff_id: staffId, role, period, start_time, end_time };
  });

  const flash = (bg, color, text) => { alertEl.style.display = 'block'; alertEl.style.background = bg; alertEl.style.color = color; alertEl.textContent = text; };

  if (!toInsert.length) { flash('rgba(224,82,82,0.12)', 'var(--red)', 'All selected dates already have someone in that slot.'); return; }

  const { error: insErr } = await window.supabase.from('shifts').insert(toInsert);
  if (insErr) { toast('Error: ' + insErr.message, true); return; }

  flash('rgba(42,184,166,0.12)', 'var(--teal)', 'Added ' + toInsert.length + ' shift(s)' + (dates.length > toInsert.length ? ', skipped ' + (dates.length - toInsert.length) + ' already filled' : '') + '.');
  bulkExcludedDates.clear();
  renderBulkDatePicker();
  loadBulkShiftList();
  loadScheduleRange();
}

async function loadBulkShiftList() {
  const el = document.getElementById('bulk-shift-list');
  el.innerHTML = '<div class="loading">Loading...</div>';
  const monthStart = toDateStr(new Date(scheduleCursor.getFullYear(), scheduleCursor.getMonth(), 1));
  const monthEnd = toDateStr(new Date(scheduleCursor.getFullYear(), scheduleCursor.getMonth() + 1, 0));
  const { data, error } = await window.supabase.from('shifts').select('*').gte('shift_date', monthStart).lte('shift_date', monthEnd).order('shift_date').order('period');
  if (error) { el.innerHTML = '<div class="loading">Error: ' + escHtml(error.message) + '</div>'; return; }
  if (!data.length) { el.innerHTML = '<div class="loading">No shifts this month</div>'; return; }
  el.innerHTML = '<div class="table-wrap"><table><thead><tr><th>Date</th><th>Position</th><th>Staff</th><th>Time</th><th></th></tr></thead><tbody>' +
    data.map((s) => {
      const d = new Date(s.shift_date + 'T00:00:00');
      const label = s.role === 'manager' ? 'MOD' : (s.period === 'morning' ? 'Morning' : 'Evening');
      return '<tr><td>' + d.toLocaleDateString('default', { month: 'short', day: 'numeric' }) + '</td><td>' + label + '</td><td>' + escHtml(staffName(s.staff_id)) + '</td>'
        + '<td style="font-family:\'DM Mono\',monospace;font-size:12px">' + (s.start_time ? fmtTime(s.start_time) + (s.end_time ? '–' + fmtTime(s.end_time) : '') : '') + '</td>'
        + '<td>' + (canSchedule() ? '<button class="btn btn-sm btn-danger" onclick="deleteBulkShift(\'' + s.id + '\')">Remove</button>' : '') + '</td></tr>';
    }).join('') + '</tbody></table></div>';
}

async function deleteBulkShift(id) {
  if (!canSchedule()) return;
  const { error } = await window.supabase.from('shifts').delete().eq('id', id);
  if (error) { toast('Error: ' + error.message, true); return; }
  loadBulkShiftList();
  loadScheduleRange();
  toast('Shift removed');
}

// ── SETTINGS ──────────────────────────────────────────────
function renderDaySettingsRows() {
  const tbody = document.getElementById('settings-day-rows');
  const editable = canSchedule();
  tbody.innerHTML = scheduleDaySettings.map((s) => {
    const n = s.day_of_week;
    return '<tr>'
      + '<td>' + escHtml(s.label) + '</td>'
      + '<td><input type="checkbox" id="day-closed-' + n + '" ' + (s.is_closed ? 'checked' : '') + ' onchange="toggleDayClosedInputs(' + n + ')" ' + (editable ? '' : 'disabled') + '></td>'
      + '<td><input type="time" class="settings-time-input" id="day-morning-start-' + n + '" value="' + (s.morning_start || '').slice(0, 5) + '"></td>'
      + '<td><input type="time" class="settings-time-input" id="day-morning-end-' + n + '" value="' + (s.morning_end || '').slice(0, 5) + '"></td>'
      + '<td><input type="time" class="settings-time-input" id="day-evening-start-' + n + '" value="' + (s.evening_start || '').slice(0, 5) + '"></td>'
      + '<td><input type="time" class="settings-time-input" id="day-evening-end-' + n + '" value="' + (s.evening_end || '').slice(0, 5) + '"></td>'
      + '</tr>';
  }).join('');
  scheduleDaySettings.forEach((s) => toggleDayClosedInputs(s.day_of_week));
}

function toggleDayClosedInputs(n) {
  const closed = document.getElementById('day-closed-' + n).checked;
  ['morning-start', 'morning-end', 'evening-start', 'evening-end'].forEach((f) => {
    document.getElementById('day-' + f + '-' + n).disabled = closed || !canSchedule();
  });
}

async function saveDaySettings() {
  if (!canSchedule()) return;
  const statusEl = document.getElementById('day-settings-status');
  statusEl.textContent = 'Saving...';
  const updates = scheduleDaySettings.map((s) => {
    const n = s.day_of_week;
    const closed = document.getElementById('day-closed-' + n).checked;
    return {
      day_of_week: n,
      label: s.label,
      is_closed: closed,
      morning_start: closed ? null : (document.getElementById('day-morning-start-' + n).value || null),
      morning_end: closed ? null : (document.getElementById('day-morning-end-' + n).value || null),
      evening_start: closed ? null : (document.getElementById('day-evening-start-' + n).value || null),
      evening_end: closed ? null : (document.getElementById('day-evening-end-' + n).value || null),
    };
  });
  const { error } = await window.supabase.from('shift_day_settings').upsert(updates);
  if (error) { statusEl.textContent = 'Error: ' + error.message; return; }
  scheduleDaySettings = updates;
  statusEl.textContent = 'Saved';
  setTimeout(() => { statusEl.textContent = ''; }, 2000);
  populateBulkSelectors();
  loadScheduleRange();
}

function populateScheduleSettingsForm() {
  if (!scheduleSettings) return;
  document.getElementById('set-timeout').value = scheduleSettings.coverage_request_timeout_hours;
  document.getElementById('set-tpl-coverage').value = scheduleSettings.email_template_coverage_request;
  document.getElementById('set-tpl-trade').value = scheduleSettings.email_template_trade_confirm;
  document.getElementById('set-tpl-sent').value = scheduleSettings.email_template_schedule_sent;
}

async function saveScheduleSettings() {
  if (!canSchedule()) return;
  const statusEl = document.getElementById('settings-status');
  statusEl.textContent = 'Saving...';
  const payload = {
    id: true,
    coverage_request_timeout_hours: parseInt(document.getElementById('set-timeout').value, 10) || 48,
    email_template_coverage_request: document.getElementById('set-tpl-coverage').value,
    email_template_trade_confirm: document.getElementById('set-tpl-trade').value,
    email_template_schedule_sent: document.getElementById('set-tpl-sent').value,
  };
  const { error } = await window.supabase.from('schedule_settings').upsert(payload);
  if (error) { statusEl.textContent = 'Error: ' + error.message; return; }
  scheduleSettings = payload;
  statusEl.textContent = 'Saved';
  setTimeout(() => { statusEl.textContent = ''; }, 2000);
}
