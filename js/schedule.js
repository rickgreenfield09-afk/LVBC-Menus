// schedule.js
// Screen: #screen-schedule (sub-tabs: My Shifts, Calendar, Scheduling,
// Events, Settings). My Shifts is visible to everyone; the other four
// are admin/scheduler-only (canSchedule()) both in the UI and via RLS
// — see supabase/schema.sql. No coverage requests or trades yet
// (HANDOFF.md has the full module).
// Depends on: window.supabase, toast(), escHtml() (from menu.js)

let scheduleCursor = new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate());
let scheduleViewMode = 'month';
let scheduleShifts = [];
let scheduleEvents = [];
let scheduleStaff = [];
let scheduleDaySettings = [];
let scheduleSettings = null;
let scheduleActiveDate = null;
let recurringEvents = [];
let recurringOverrides = [];
let visibleRecurringOccurrences = [];

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

// Position select values are "role:period", e.g. "bartender:morning"
// or "manager:evening" — manager (MOD) shares the same period windows
// as bartenders now, since MOD swaps at the same break as staff.
function positionOptionsForSetting(setting) {
  const opts = [];
  if (setting.morning_start) { const l = shiftSlotLabel(setting, 'morning'); opts.push(['bartender:morning', 'Bartender - ' + l]); opts.push(['manager:morning', 'Manager - ' + l]); }
  if (setting.evening_start) { opts.push(['bartender:evening', 'Bartender - Evening']); opts.push(['manager:evening', 'Manager - Evening']); }
  return opts;
}

function parsePosition(val) {
  const [role, period] = val.split(':');
  return { role, period: period || null };
}

async function logAudit(action, entityType, entityId, detail) {
  try {
    await window.supabase.from('audit_log').insert({ actor_id: window.currentStaff.id, action, entity_type: entityType, entity_id: entityId, detail: detail || null });
  } catch (e) { /* best-effort, never block the UI on logging */ }
}

// ── ENTRY ────────────────────────────────────────────────
async function loadStaffAndSettings() {
  const [{ data: staffData }, { data: daySettingsData }, { data: settingsData }, { data: recEvents }, { data: recOverrides }] = await Promise.all([
    window.supabase.from('staff_profiles').select('id,name,role').order('name'),
    window.supabase.from('shift_day_settings').select('*').order('day_of_week'),
    window.supabase.from('schedule_settings').select('*').limit(1),
    window.supabase.from('recurring_events').select('*').eq('is_active', true),
    window.supabase.from('recurring_event_overrides').select('*'),
  ]);
  scheduleStaff = staffData || [];
  scheduleDaySettings = daySettingsData || [];
  scheduleSettings = (settingsData && settingsData[0]) || null;
  recurringEvents = recEvents || [];
  recurringOverrides = recOverrides || [];
}

// "Morning" reads oddly for a shift that starts at 1pm (Sunday) — so
// label off the day's actual start hour instead of a fixed name.
function shiftSlotLabel(setting, period) {
  if (period === 'evening') return 'Evening';
  const h = setting && setting.morning_start ? parseInt(setting.morning_start.split(':')[0], 10) : 9;
  return h >= 12 ? 'Afternoon' : 'Morning';
}

// Position dropdowns filter the staff list to admins for a manager
// slot and non-admins for a bartender slot.
function populateStaffSelect(selectEl, roleFilter) {
  const list = scheduleStaff.filter((s) => (roleFilter === 'manager' ? s.role === 'admin' : s.role !== 'admin'));
  const prev = selectEl.value;
  selectEl.innerHTML = '<option value="" disabled selected>Select staff member</option>' + list.map((s) => '<option value="' + s.id + '">' + escHtml(s.name) + '</option>').join('');
  if (list.some((s) => s.id === prev)) selectEl.value = prev;
}

async function loadSchedule() {
  await loadStaffAndSettings();

  const admin = canSchedule();
  ['calendar', 'bulk', 'events', 'settings'].forEach((t) => {
    document.getElementById('scheduletab-btn-' + t).style.display = admin ? '' : 'none';
  });
  document.getElementById('btn-save-day-settings').style.display = admin ? '' : 'none';
  document.getElementById('btn-save-schedule-settings').style.display = admin ? '' : 'none';
  ['set-timeout', 'set-tpl-coverage', 'set-tpl-trade', 'set-tpl-sent'].forEach((id) => {
    document.getElementById(id).disabled = !admin;
  });

  setScheduleTab('myshifts', document.getElementById('scheduletab-btn-myshifts'));
}

function setScheduleTab(tab, btn) {
  document.querySelectorAll('#screen-schedule > .sub-tabs .sub-tab').forEach((b) => b.classList.remove('active'));
  document.querySelectorAll('#screen-schedule > .sub-sec').forEach((s) => s.classList.remove('active'));
  btn.classList.add('active');
  document.getElementById('scheduletab-' + tab).classList.add('active');
  if (tab === 'myshifts') loadMyShifts();
  if (tab === 'calendar') loadScheduleRange();
  if (tab === 'bulk') { populateBulkSelectors(); loadBulkShiftList(); }
  if (tab === 'events') loadEventsList();
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
  recomputeVisibleRecurring();
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

  // Closed days can still host a one-off/recurring event (e.g. VFW
  // night on an otherwise-closed Tuesday) — only skip the bartender
  // split, never the event pills.
  if (setting.is_closed) {
    const closedDayEvents = scheduleEvents.filter((e) => toDateStr(new Date(e.event_date)) === dateStr);
    const closedDayRecurring = visibleRecurringOccurrences.filter((o) => o.date === dateStr);
    let closedHtml = '<div class="' + cls + (closedDayEvents.length || closedDayRecurring.length ? '' : ' closed') + '" onclick="openShiftModal(\'' + dateStr + '\')">'
      + '<div class="cal-day-num">' + dateObj.getDate() + '</div>';
    if (!closedDayEvents.length && !closedDayRecurring.length) {
      closedHtml += '<div class="cal-closed-label">Closed</div></div>';
      return closedHtml;
    }
    closedHtml += '<div class="cal-closed-label">Closed</div>';
    closedDayEvents.forEach((e) => { closedHtml += '<div class="cal-pill-event">' + escHtml(e.event_name) + '</div>'; });
    closedDayRecurring.forEach((o) => { closedHtml += '<div class="cal-pill-event recurring">' + escHtml(o.name) + (o.staff_id ? ' · ' + escHtml(staffName(o.staff_id)) : '') + '</div>'; });
    closedHtml += '</div>';
    return closedHtml;
  }

  const dayShifts = scheduleShifts.filter((s) => s.shift_date === dateStr);
  const dayLevelMods = dayShifts.filter((s) => s.role === 'manager' && !s.period);
  const dayEvents = scheduleEvents.filter((e) => toDateStr(new Date(e.event_date)) === dateStr);
  const dayRecurring = visibleRecurringOccurrences.filter((o) => o.date === dateStr);
  const halves = [];
  if (setting.morning_start) halves.push('morning');
  if (setting.evening_start) halves.push('evening');

  let html = '<div class="' + cls + '" onclick="openShiftModal(\'' + dateStr + '\')">';
  html += '<div class="cal-day-num">' + dateObj.getDate() + '</div>';
  dayLevelMods.forEach((m) => { html += '<div class="cal-mod-pill">MOD: ' + escHtml(staffName(m.staff_id)) + '</div>'; });
  html += '<div class="cal-day-split">';
  halves.forEach((period) => {
    html += '<div class="cal-half">';
    dayShifts.filter((s) => s.role === 'manager' && s.period === period).forEach((s) => {
      html += '<div class="cal-mod-pill">MOD: ' + escHtml(staffName(s.staff_id)) + '</div>';
    });
    dayShifts.filter((s) => s.role === 'bartender' && s.period === period).forEach((s) => {
      html += '<div class="cal-pill-emp">' + escHtml(staffName(s.staff_id)) + '</div>';
    });
    dayEvents.filter((e) => {
      if (halves.length === 1) return true;
      return period === 'morning' ? new Date(e.event_date).getHours() < 15 : new Date(e.event_date).getHours() >= 15;
    }).forEach((e) => {
      html += '<div class="cal-pill-event">' + escHtml(e.event_name) + '</div>';
    });
    dayRecurring.filter((o) => {
      if (halves.length === 1) return true;
      const hr = o.start_time ? parseInt(o.start_time.split(':')[0], 10) : 18;
      return period === 'morning' ? hr < 15 : hr >= 15;
    }).forEach((o) => {
      html += '<div class="cal-pill-event recurring">' + escHtml(o.name) + (o.staff_id ? ' · ' + escHtml(staffName(o.staff_id)) : '') + '</div>';
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
// Opens read-only by default; admins/schedulers get an Edit toggle
// that reveals the add-shift / add-event forms and Remove buttons.
let shiftModalEditMode = false;
let modalEvents = [];

async function openShiftModal(dateStr) {
  scheduleActiveDate = dateStr;
  shiftModalEditMode = false;
  const dow = new Date(dateStr + 'T00:00:00').getDay();
  const setting = scheduleDaySettings.find((s) => s.day_of_week === dow) || {};
  const d = new Date(dateStr + 'T00:00:00');
  document.getElementById('shift-modal-date').textContent = d.toLocaleDateString('default', { weekday: 'long', month: 'long', day: 'numeric' });

  const editBtn = document.getElementById('shift-modal-edit-btn');
  editBtn.style.display = canSchedule() ? '' : 'none';
  editBtn.textContent = 'Edit';

  document.getElementById('sm-role').innerHTML = positionOptionsForSetting(setting).map(([v, l]) => '<option value="' + v + '">' + l + '</option>').join('');
  document.getElementById('sm-notes').value = '';

  onShiftModalRoleChange();
  applyShiftModalEditVisibility();
  document.getElementById('shift-modal').style.display = 'flex';

  document.getElementById('shift-modal-events-list').innerHTML = '<div class="loading">Loading...</div>';
  modalEvents = await fetchEventsForDate(dateStr);
  renderModalEventsList();
}

function closeShiftModal() {
  document.getElementById('shift-modal').style.display = 'none';
  scheduleActiveDate = null;
}

function toggleShiftModalEdit() {
  shiftModalEditMode = !shiftModalEditMode;
  document.getElementById('shift-modal-edit-btn').textContent = shiftModalEditMode ? 'Done Editing' : 'Edit';
  applyShiftModalEditVisibility();
}

function applyShiftModalEditVisibility() {
  const dow = new Date(scheduleActiveDate + 'T00:00:00').getDay();
  const setting = scheduleDaySettings.find((s) => s.day_of_week === dow) || {};
  const editing = canSchedule() && shiftModalEditMode;
  document.getElementById('shift-modal-form-wrap').style.display = (editing && !setting.is_closed) ? '' : 'none';
  document.getElementById('shift-modal-event-form-wrap').style.display = editing ? '' : 'none';
  renderShiftModalList();
  renderModalEventsList();
}

function onShiftModalRoleChange() {
  const dow = new Date(scheduleActiveDate + 'T00:00:00').getDay();
  const setting = scheduleDaySettings.find((s) => s.day_of_week === dow) || {};
  const { role, period } = parsePosition(document.getElementById('sm-role').value || 'bartender:morning');
  populateStaffSelect(document.getElementById('sm-staff'), role);
  const start = period === 'morning' ? setting.morning_start : setting.evening_start;
  const end = period === 'morning' ? setting.morning_end : setting.evening_end;
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

  const editing = canSchedule() && shiftModalEditMode;
  listEl.innerHTML = shifts.map((s) => {
    const periodTag = s.period ? (s.period === 'morning' ? ' (AM)' : ' (PM)') : '';
    const label = s.role === 'manager' ? 'Manager on Duty' + periodTag : shiftSlotLabel(setting, s.period);
    return '<div class="shift-row">'
      + '<div><div class="shift-row-name">' + escHtml(staffName(s.staff_id)) + (s.role === 'manager' ? ' <span class="badge badge-amber">MOD' + periodTag + '</span>' : '') + '</div>'
      + '<div class="shift-row-meta">' + label + (s.start_time ? ' · ' + fmtTime(s.start_time) + (s.end_time ? '–' + fmtTime(s.end_time) : '') : '') + (s.notes ? ' · ' + escHtml(s.notes) : '') + '</div></div>'
      + (editing ? '<button class="btn btn-sm btn-danger" onclick="deleteShift(\'' + s.id + '\')">Remove</button>' : '')
      + '</div>';
  }).join('');
}

async function addShift() {
  if (!canSchedule()) return;
  const staffId = document.getElementById('sm-staff').value;
  if (!staffId) { toast('Select a staff member', true); return; }
  const { role, period } = parsePosition(document.getElementById('sm-role').value);
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
  logAudit('add_shift', 'shifts', data.id, { shift_date: data.shift_date, staff_id: data.staff_id, role, period });
  toast('Shift added');
}

async function deleteShift(id) {
  if (!canSchedule()) return;
  const removed = scheduleShifts.find((s) => s.id === id);
  const { error } = await window.supabase.from('shifts').delete().eq('id', id);
  if (error) { toast('Error: ' + error.message, true); return; }
  scheduleShifts = scheduleShifts.filter((s) => s.id !== id);
  renderShiftModalList();
  renderScheduleCalendar();
  if (removed) logAudit('remove_shift', 'shifts', id, { shift_date: removed.shift_date, staff_id: removed.staff_id, role: removed.role, period: removed.period });
  toast('Shift removed');
}

// ── DAY MODAL: EVENTS ─────────────────────────────────────
async function fetchEventsForDate(dateStr) {
  const next = new Date(dateStr + 'T00:00:00'); next.setDate(next.getDate() + 1);
  const { data, error } = await window.supabase.from('events').select('*')
    .gte('event_date', dateStr + 'T00:00:00').lt('event_date', toDateStr(next) + 'T00:00:00').order('event_date');
  return error ? [] : (data || []);
}

function renderModalEventsList() {
  const el = document.getElementById('shift-modal-events-list');
  const editing = canSchedule() && shiftModalEditMode;
  const recurringToday = computeRecurringOccurrences(new Date(scheduleActiveDate + 'T00:00:00'), new Date(scheduleActiveDate + 'T00:00:00'))
    .filter((o) => o.date === scheduleActiveDate);

  const oneOffHtml = modalEvents.map((e) => {
    const t = new Date(e.event_date);
    return '<div class="shift-row">'
      + '<div><div class="shift-row-name">' + escHtml(e.event_name) + '</div>'
      + '<div class="shift-row-meta">' + t.toLocaleTimeString('default', { hour: 'numeric', minute: '2-digit' }) + (e.event_type ? ' · ' + escHtml(e.event_type) : '') + '</div></div>'
      + (editing ? '<button class="btn btn-sm btn-danger" onclick="deleteModalEvent(\'' + e.id + '\')">Remove</button>' : '')
      + '</div>';
  }).join('');

  const recurringHtml = recurringToday.map((o) => {
    const idSafe = o.recurringEventId + '-' + o.baseDate;
    const staffOptions = '<option value="">Unassigned</option>' + scheduleStaff.map((s) => '<option value="' + s.id + '"' + (s.id === o.staff_id ? ' selected' : '') + '>' + escHtml(s.name) + '</option>').join('');
    return '<div class="shift-row" style="align-items:flex-start;">'
      + '<div style="flex:1;"><div class="shift-row-name">' + escHtml(o.name) + ' <span class="badge badge-purple">Recurring</span>' + (o.moved ? ' <span class="badge badge-amber">Moved</span>' : '') + '</div>'
      + '<div class="shift-row-meta">' + (o.start_time ? fmtTime(o.start_time) + (o.end_time ? '–' + fmtTime(o.end_time) : '') : '') + (o.staff_id ? ' · ' + escHtml(staffName(o.staff_id)) : ' · Unassigned') + '</div>'
      + (editing ? '<div style="margin-top:8px;display:flex;flex-direction:column;gap:6px;">'
        + '<select class="form-select" style="width:100%;" onchange="assignRecurringStaff(\'' + o.recurringEventId + '\',\'' + o.baseDate + '\',this.value)">' + staffOptions + '</select>'
        + '<div style="display:flex;gap:6px;">'
        + '<input type="date" class="form-input" id="rec-move-' + idSafe + '" style="flex:1;">'
        + '<button class="btn btn-sm btn-secondary" onclick="moveRecurringOccurrence(\'' + o.recurringEventId + '\',\'' + o.baseDate + '\')">Move</button>'
        + '<button class="btn btn-sm btn-danger" onclick="skipRecurringOccurrence(\'' + o.recurringEventId + '\',\'' + o.baseDate + '\')">Skip</button>'
        + '</div></div>' : '')
      + '</div></div>';
  }).join('');

  const combined = oneOffHtml + recurringHtml;
  el.innerHTML = combined || '<div class="loading">No events this day</div>';
}

async function addModalEvent() {
  if (!canSchedule()) return;
  const name = document.getElementById('sme-name').value.trim();
  if (!name) { toast('Enter an event name', true); return; }
  const time = document.getElementById('sme-time').value || '18:00';
  const payload = {
    event_name: name,
    event_type: document.getElementById('sme-type').value,
    event_date: scheduleActiveDate + 'T' + time + ':00',
  };
  const { data, error } = await window.supabase.from('events').insert(payload).select().single();
  if (error) { toast('Error: ' + error.message, true); return; }
  modalEvents.push(data);
  document.getElementById('sme-name').value = '';
  renderModalEventsList();
  loadScheduleRange();
  logAudit('add_event', 'events', data.id, payload);
  toast('Event added');
}

async function deleteModalEvent(id) {
  if (!canSchedule()) return;
  const { error } = await window.supabase.from('events').delete().eq('id', id);
  if (error) { toast('Error: ' + error.message, true); return; }
  modalEvents = modalEvents.filter((e) => e.id !== id);
  renderModalEventsList();
  loadScheduleRange();
  logAudit('delete_event', 'events', id, null);
  toast('Event removed');
}

// ── BULK SCHEDULING ───────────────────────────────────────
let bulkSelectedWeekdays = new Set();
let bulkSelectedDates = new Set();

function populateBulkSelectors() {
  document.getElementById('bulk-filter-staff').innerHTML = '<option value="">All Staff</option>' + scheduleStaff.map((s) => '<option value="' + s.id + '">' + escHtml(s.name) + '</option>').join('');
  document.getElementById('bulk-filter-position').value = '';
  document.getElementById('bk-staff').value = '';
  const monthStart = new Date(scheduleCursor.getFullYear(), scheduleCursor.getMonth(), 1);
  const monthEnd = new Date(scheduleCursor.getFullYear(), scheduleCursor.getMonth() + 1, 0);
  document.getElementById('bk-from').value = toDateStr(monthStart);
  document.getElementById('bk-through').value = toDateStr(monthEnd);
  const firstOpenDay = scheduleDaySettings.find((s) => !s.is_closed);
  bulkSelectedWeekdays = new Set(firstOpenDay ? [firstOpenDay.day_of_week] : []);
  recomputeBulkDatesFromPattern();
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

function recomputeBulkDatesFromPattern() {
  const fromStr = document.getElementById('bk-from').value;
  const throughStr = document.getElementById('bk-through').value;
  bulkSelectedDates = new Set();
  if (!fromStr || !throughStr) return;
  for (let d = new Date(fromStr + 'T00:00:00'); d <= new Date(throughStr + 'T00:00:00'); d.setDate(d.getDate() + 1)) {
    if (bulkSelectedWeekdays.has(d.getDay())) bulkSelectedDates.add(toDateStr(d));
  }
}

function toggleBulkWeekday(n) {
  if (bulkSelectedWeekdays.has(n)) bulkSelectedWeekdays.delete(n); else bulkSelectedWeekdays.add(n);
  recomputeBulkDatesFromPattern();
  renderWeekdayPicker();
  onBulkPositionChange();
}

function onBulkRangeChange() {
  recomputeBulkDatesFromPattern();
  renderBulkDatePicker();
}

function validPositionsForSelectedWeekdays() {
  const days = scheduleDaySettings.filter((s) => bulkSelectedWeekdays.has(s.day_of_week));
  const morningOk = days.length && days.every((d) => d.morning_start);
  const eveningOk = days.length && days.every((d) => d.evening_start);
  const opts = [];
  if (morningOk) { const l = shiftSlotLabel(days[0], 'morning'); opts.push(['bartender:morning', 'Bartender - ' + l]); opts.push(['manager:morning', 'Manager - ' + l]); }
  if (eveningOk) { opts.push(['bartender:evening', 'Bartender - Evening']); opts.push(['manager:evening', 'Manager - Evening']); }
  return opts;
}

function onBulkPositionChange() {
  const valid = validPositionsForSelectedWeekdays();
  const posSel = document.getElementById('bk-position');
  const prev = posSel.value;
  posSel.innerHTML = valid.map(([v, l]) => '<option value="' + v + '">' + l + '</option>').join('');
  if (valid.some(([v]) => v === prev)) posSel.value = prev;
  const { role } = parsePosition(posSel.value || 'bartender:morning');
  populateStaffSelect(document.getElementById('bk-staff'), role);
  renderBulkDatePicker();
}

function renderBulkDatePicker() {
  const el = document.getElementById('bk-date-picker');
  const fromStr = document.getElementById('bk-from').value;
  if (!fromStr) { el.innerHTML = ''; return; }
  const fromD = new Date(fromStr + 'T00:00:00');
  const monthStart = new Date(fromD.getFullYear(), fromD.getMonth(), 1);
  const monthEnd = new Date(fromD.getFullYear(), fromD.getMonth() + 1, 0);

  let html = dowHeaderHtml();
  const firstDow = monthStart.getDay();
  for (let i = 0; i < firstDow; i++) html += '<div class="bk-date-cell disabled"></div>';
  for (let d = new Date(monthStart); d <= monthEnd; d.setDate(d.getDate() + 1)) {
    const dateStr = toDateStr(d);
    const dow = d.getDay();
    const setting = scheduleDaySettings.find((s) => s.day_of_week === dow) || {};
    if (setting.is_closed) { html += '<div class="bk-date-cell disabled">' + d.getDate() + '</div>'; continue; }
    const included = bulkSelectedDates.has(dateStr);
    html += '<div class="bk-date-cell' + (included ? ' included' : '') + '" onclick="toggleBulkDate(\'' + dateStr + '\')">' + d.getDate() + '</div>';
  }
  el.innerHTML = html;
}

function toggleBulkDate(dateStr) {
  if (bulkSelectedDates.has(dateStr)) bulkSelectedDates.delete(dateStr); else bulkSelectedDates.add(dateStr);
  renderBulkDatePicker();
}

async function applyBulkSchedule() {
  if (!canSchedule()) return;
  const alertEl = document.getElementById('bulk-alert');
  alertEl.style.display = 'none';

  const { role, period } = parsePosition(document.getElementById('bk-position').value);
  const staffId = document.getElementById('bk-staff').value;
  const dates = Array.from(bulkSelectedDates).sort();
  if (!staffId || !dates.length) { toast('Pick at least one date', true); return; }

  const { data: existing, error: exErr } = await window.supabase.from('shifts').select('shift_date,role,period').in('shift_date', dates);
  if (exErr) { toast('Error: ' + exErr.message, true); return; }
  const taken = new Set((existing || []).filter((s) => s.role === role && s.period === period).map((s) => s.shift_date));

  const toInsert = dates.filter((dt) => !taken.has(dt)).map((dt) => {
    const setting = scheduleDaySettings.find((s) => s.day_of_week === new Date(dt + 'T00:00:00').getDay()) || {};
    const start_time = period === 'morning' ? setting.morning_start : setting.evening_start;
    const end_time = period === 'morning' ? setting.morning_end : setting.evening_end;
    return { shift_date: dt, staff_id: staffId, role, period, start_time, end_time };
  });

  const flash = (bg, color, text) => { alertEl.style.display = 'block'; alertEl.style.background = bg; alertEl.style.color = color; alertEl.textContent = text; };

  if (!toInsert.length) { flash('rgba(224,82,82,0.12)', 'var(--red)', 'All selected dates already have someone in that slot.'); return; }

  const { data: inserted, error: insErr } = await window.supabase.from('shifts').insert(toInsert).select();
  if (insErr) { toast('Error: ' + insErr.message, true); return; }

  flash('rgba(42,184,166,0.12)', 'var(--teal)', 'Added ' + toInsert.length + ' shift(s)' + (dates.length > toInsert.length ? ', skipped ' + (dates.length - toInsert.length) + ' already filled' : '') + '.');
  logAudit('bulk_add_shifts', 'shifts', null, { staff_id: staffId, role, period, count: toInsert.length, dates: toInsert.map((s) => s.shift_date) });
  loadBulkShiftList();
  loadScheduleRange();
}

async function loadBulkShiftList() {
  const el = document.getElementById('bulk-shift-list');
  el.innerHTML = '<div class="loading">Loading...</div>';
  const monthStart = toDateStr(new Date(scheduleCursor.getFullYear(), scheduleCursor.getMonth(), 1));
  const monthEnd = toDateStr(new Date(scheduleCursor.getFullYear(), scheduleCursor.getMonth() + 1, 0));
  let query = window.supabase.from('shifts').select('*').gte('shift_date', monthStart).lte('shift_date', monthEnd).order('shift_date').order('period');
  const staffFilter = document.getElementById('bulk-filter-staff').value;
  if (staffFilter) query = query.eq('staff_id', staffFilter);
  const posFilter = document.getElementById('bulk-filter-position').value;
  if (posFilter) {
    const { role, period } = parsePosition(posFilter);
    query = query.eq('role', role).eq('period', period);
  }
  const { data, error } = await query;
  if (error) { el.innerHTML = '<div class="loading">Error: ' + escHtml(error.message) + '</div>'; return; }
  if (!data.length) { el.innerHTML = '<div class="loading">No shifts match</div>'; return; }
  el.innerHTML = '<div class="table-wrap"><table><thead><tr><th>Date</th><th>Position</th><th>Staff</th><th>Time</th><th></th></tr></thead><tbody>' +
    data.map((s) => {
      const d = new Date(s.shift_date + 'T00:00:00');
      const rowSetting = scheduleDaySettings.find((x) => x.day_of_week === d.getDay()) || {};
      const periodTag = s.period ? (s.period === 'morning' ? 'AM' : 'PM') : '';
      const label = (s.role === 'manager' ? 'MOD' : shiftSlotLabel(rowSetting, s.period)) + (s.role === 'manager' && periodTag ? ' ' + periodTag : '');
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
  logAudit('remove_shift', 'shifts', id, null);
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
