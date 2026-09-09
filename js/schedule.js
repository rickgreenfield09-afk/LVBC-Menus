// schedule.js
// Screen: #screen-schedule — monthly staff shift grid.
// Everyone signed in can view the full month; adding/removing shifts
// is gated by window.currentStaff.can_schedule (also enforced by RLS
// on shifts — see supabase/schema.sql). Scope: view + manual assign
// only, no copy-forward / coverage requests / trades yet (HANDOFF.md
// has the full planned module).
// Depends on: window.supabase, toast(), escHtml() (from menu.js)

let scheduleCursor = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
let scheduleShifts = [];
let scheduleStaff = [];
let scheduleActiveDate = null;

function canSchedule() {
  return !!(window.currentStaff && (window.currentStaff.can_schedule || window.currentStaff.role === 'admin'));
}

async function loadSchedule() {
  await loadScheduleStaff();
  await loadScheduleMonth();
}

async function loadScheduleStaff() {
  const { data, error } = await window.supabase.from('staff_profiles').select('id,name').order('name');
  if (error) { toast('Error loading staff: ' + error.message, true); return; }
  scheduleStaff = data || [];
}

function monthBounds(d) {
  const start = new Date(d.getFullYear(), d.getMonth(), 1);
  const end = new Date(d.getFullYear(), d.getMonth() + 1, 0);
  return { start, end };
}

function toDateStr(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

async function loadScheduleMonth() {
  const grid = document.getElementById('schedule-cal-grid');
  grid.innerHTML = '<div class="loading">Loading...</div>';
  document.getElementById('schedule-month-label').textContent =
    scheduleCursor.toLocaleString('default', { month: 'long', year: 'numeric' });

  const { start, end } = monthBounds(scheduleCursor);
  const { data, error } = await window.supabase
    .from('shifts')
    .select('*')
    .gte('shift_date', toDateStr(start))
    .lte('shift_date', toDateStr(end))
    .order('start_time', { ascending: true });

  if (error) { grid.innerHTML = '<div class="loading">Error: ' + escHtml(error.message) + '</div>'; return; }
  scheduleShifts = data || [];
  renderScheduleCalendar();
}

function scheduleShiftMonth(delta) {
  scheduleCursor = new Date(scheduleCursor.getFullYear(), scheduleCursor.getMonth() + delta, 1);
  loadScheduleMonth();
}

function scheduleGoToday() {
  const now = new Date();
  scheduleCursor = new Date(now.getFullYear(), now.getMonth(), 1);
  loadScheduleMonth();
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

function renderScheduleCalendar() {
  const grid = document.getElementById('schedule-cal-grid');
  const { start, end } = monthBounds(scheduleCursor);
  const firstDow = start.getDay();
  const daysInMonth = end.getDate();
  const todayStr = toDateStr(new Date());

  const byDate = {};
  scheduleShifts.forEach((s) => { (byDate[s.shift_date] = byDate[s.shift_date] || []).push(s); });

  let html = '';
  ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].forEach((d) => { html += '<div class="cal-dow">' + d + '</div>'; });

  for (let i = 0; i < firstDow; i++) html += '<div class="cal-day other-month"></div>';

  for (let day = 1; day <= daysInMonth; day++) {
    const d = new Date(scheduleCursor.getFullYear(), scheduleCursor.getMonth(), day);
    const dateStr = toDateStr(d);
    const shifts = byDate[dateStr] || [];
    const isToday = dateStr === todayStr;
    let chips = shifts.map((s) =>
      '<div class="cal-shift-chip' + (s.role === 'manager' ? ' mgr' : '') + '">' + escHtml(staffName(s.staff_id)) + (s.start_time ? ' ' + fmtTime(s.start_time) : '') + '</div>'
    ).join('');
    html += '<div class="cal-day' + (isToday ? ' today' : '') + '" onclick="openShiftModal(\'' + dateStr + '\')">'
      + '<div class="cal-day-num">' + day + '</div>' + chips + '</div>';
  }

  grid.innerHTML = html;
}

function openShiftModal(dateStr) {
  scheduleActiveDate = dateStr;
  const modal = document.getElementById('shift-modal');
  const d = new Date(dateStr + 'T00:00:00');
  document.getElementById('shift-modal-date').textContent = d.toLocaleDateString('default', { weekday: 'long', month: 'long', day: 'numeric' });

  const staffSel = document.getElementById('sm-staff');
  staffSel.innerHTML = scheduleStaff.map((s) => '<option value="' + s.id + '">' + escHtml(s.name) + '</option>').join('');
  document.getElementById('sm-role').value = 'bartender';
  document.getElementById('sm-start').value = '';
  document.getElementById('sm-end').value = '';
  document.getElementById('sm-notes').value = '';

  document.getElementById('shift-modal-form-wrap').style.display = canSchedule() ? '' : 'none';
  renderShiftModalList();
  modal.style.display = 'flex';
}

function closeShiftModal() {
  document.getElementById('shift-modal').style.display = 'none';
  scheduleActiveDate = null;
}

function renderShiftModalList() {
  const listEl = document.getElementById('shift-modal-list');
  const shifts = scheduleShifts.filter((s) => s.shift_date === scheduleActiveDate);
  if (!shifts.length) { listEl.innerHTML = '<div class="loading">No shifts scheduled</div>'; return; }
  listEl.innerHTML = shifts.map((s) =>
    '<div class="shift-row">'
    + '<div><div class="shift-row-name">' + escHtml(staffName(s.staff_id)) + (s.role === 'manager' ? ' <span class="badge badge-amber">MOD</span>' : '') + '</div>'
    + '<div class="shift-row-meta">' + (s.start_time ? fmtTime(s.start_time) + (s.end_time ? '–' + fmtTime(s.end_time) : '') : '') + (s.notes ? ' · ' + escHtml(s.notes) : '') + '</div></div>'
    + (canSchedule() ? '<button class="btn btn-sm btn-danger" onclick="deleteShift(\'' + s.id + '\')">Remove</button>' : '')
    + '</div>'
  ).join('');
}

async function addShift() {
  if (!canSchedule()) return;
  const staffId = document.getElementById('sm-staff').value;
  if (!staffId) { toast('Select a staff member', true); return; }
  const payload = {
    shift_date: scheduleActiveDate,
    staff_id: staffId,
    role: document.getElementById('sm-role').value,
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
