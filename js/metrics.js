// metrics.js
// Schedule > Metrics sub-tab (admin/scheduler-only) — the landing tab
// for site admins (role === 'admin') on the Schedule screen. Dashboard
// summarizing who's carrying the schedule: shift counts, hours,
// morning/evening/MOD split, weekend load, coverage requests raised,
// and open AM/PM bartender slots (both explicitly-posted-open shifts
// and slots that were simply never scheduled at all) plus how many
// got claimed, and by whom. Filterable by This Month / This Quarter /
// Year to Date, with the staff table sortable by any column.
// Depends on: window.supabase, toast(), escHtml() (menu.js),
// toDateStr/staffName/scheduleStaff/scheduleDaySettings (schedule.js)

let metricsMode = 'month'; // 'month' | 'quarter' | 'year'
let metricsCursor = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
let metricsRows = [];
let metricsSortField = 'shifts';
let metricsSortDir = 'desc';

function setMetricsMode(mode) {
  metricsMode = mode;
  metricsCursor = new Date(); // re-anchor to "now" whenever the filter changes
  ['month', 'quarter', 'year'].forEach((m) => document.getElementById('metrics-mode-' + m).classList.toggle('active', m === mode));
  loadMetrics();
}

function metricsNav(delta) {
  const y = metricsCursor.getFullYear();
  if (metricsMode === 'month') metricsCursor = new Date(y, metricsCursor.getMonth() + delta, 1);
  else if (metricsMode === 'quarter') metricsCursor = new Date(y, metricsCursor.getMonth() + delta * 3, 1);
  else metricsCursor = new Date(y + delta, metricsCursor.getMonth(), 1);
  loadMetrics();
}

// "Year to Date" only makes literal sense for the current year — for
// any other year shown via the nav arrows it covers the full year.
function getMetricsRange() {
  const y = metricsCursor.getFullYear();
  if (metricsMode === 'month') {
    const start = new Date(y, metricsCursor.getMonth(), 1);
    const end = new Date(y, metricsCursor.getMonth() + 1, 0);
    return { start, end, label: start.toLocaleString('default', { month: 'long', year: 'numeric' }) };
  }
  if (metricsMode === 'quarter') {
    const q = Math.floor(metricsCursor.getMonth() / 3);
    const start = new Date(y, q * 3, 1);
    const end = new Date(y, q * 3 + 3, 0);
    return { start, end, label: 'Q' + (q + 1) + ' ' + y };
  }
  const start = new Date(y, 0, 1);
  const today = new Date();
  const end = y === today.getFullYear() ? today : new Date(y, 11, 31);
  return { start, end, label: y === today.getFullYear() ? y + ' Year to Date' : String(y) };
}

async function loadMetrics() {
  if (!scheduleStaff.length) await loadStaffAndSettings();
  const { start, end, label } = getMetricsRange();
  document.getElementById('metrics-period-label').textContent = label;
  document.getElementById('metrics-body').innerHTML = '<div class="loading">Loading...</div>';

  const monthStart = toDateStr(start);
  const monthEnd = toDateStr(end);
  const nextDayAfterEnd = new Date(end); nextDayAfterEnd.setDate(nextDayAfterEnd.getDate() + 1);

  const [{ data: shifts, error: shiftErr }, { data: coverage, error: covErr }] = await Promise.all([
    window.supabase.from('shifts').select('*').gte('shift_date', monthStart).lte('shift_date', monthEnd),
    window.supabase.from('coverage_requests').select('requested_by').gte('created_at', monthStart + 'T00:00:00').lt('created_at', toDateStr(nextDayAfterEnd) + 'T00:00:00'),
  ]);
  if (shiftErr) { document.getElementById('metrics-body').innerHTML = '<div class="loading">Error: ' + escHtml(shiftErr.message) + '</div>'; return; }
  renderMetrics(shifts || [], covErr ? [] : (coverage || []), start, end);
}

// Handles an overnight end_time (e.g. 23:00-02:00) by wrapping past midnight.
function shiftHours(s) {
  if (!s.start_time || !s.end_time) return 0;
  const [sh, sm] = s.start_time.split(':').map(Number);
  const [eh, em] = s.end_time.split(':').map(Number);
  let mins = (eh * 60 + em) - (sh * 60 + sm);
  if (mins < 0) mins += 24 * 60;
  return mins / 60;
}

// "Open" now covers every AM/PM bartender slot with nobody on it —
// both a shift row explicitly posted open (staff_id null) AND a slot
// that was simply never scheduled at all (no row exists for that
// date+period). MOD slots aren't counted — only bartender AM/PM.
function countOpenBartenderSlots(start, end, shifts) {
  const filled = new Set(
    shifts.filter((s) => s.role === 'bartender' && s.staff_id).map((s) => s.shift_date + '|' + s.period)
  );
  let count = 0;
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const setting = scheduleDaySettings.find((s) => s.day_of_week === d.getDay()) || {};
    if (setting.is_closed) continue;
    ['morning', 'evening'].forEach((period) => {
      const window_ = period === 'morning' ? setting.morning_start : setting.evening_start;
      if (!window_) return;
      if (!filled.has(toDateStr(d) + '|' + period)) count += 1;
    });
  }
  return count;
}

function metricCard(label, value) {
  return '<div class="card" style="text-align:center;padding:16px;">'
    + '<div style="font-family:\'Bebas Neue\',sans-serif;font-size:28px;color:var(--teal);">' + value + '</div>'
    + '<div style="font-size:11px;color:var(--sub);letter-spacing:1px;text-transform:uppercase;">' + label + '</div></div>';
}

const METRICS_COLUMNS = [
  { key: 'name', label: 'Staff' },
  { key: 'shifts', label: 'Shifts' },
  { key: 'hours', label: 'Hours' },
  { key: 'morning', label: 'Morning' },
  { key: 'evening', label: 'Evening' },
  { key: 'mod', label: 'MOD' },
  { key: 'weekend', label: 'Weekend' },
  { key: 'coverage', label: 'Coverage Requests' },
  { key: 'claimedOpen', label: 'Open Shifts Claimed' },
];

function renderMetrics(shifts, coverage, start, end) {
  // Unassigned shifts (staff_id null) don't belong to any staffer, so
  // they're excluded from the per-staff table. claimed_by stays
  // stamped after a claim fills in staff_id, so "was this originally
  // open" survives.
  const assigned = shifts.filter((s) => s.staff_id);
  const claimedShifts = shifts.filter((s) => s.claimed_by);
  const openSlots = countOpenBartenderSlots(start, end, shifts);

  const byStaff = {};
  const rowFor = (id) => {
    if (!byStaff[id]) byStaff[id] = { id, name: staffName(id), shifts: 0, hours: 0, morning: 0, evening: 0, mod: 0, weekend: 0, coverage: 0, claimedOpen: 0 };
    return byStaff[id];
  };

  let totalHours = 0;
  assigned.forEach((s) => {
    const row = rowFor(s.staff_id);
    const hours = shiftHours(s);
    row.shifts += 1;
    row.hours += hours;
    totalHours += hours;
    if (s.role === 'manager') row.mod += 1;
    if (s.period === 'morning') row.morning += 1;
    if (s.period === 'evening') row.evening += 1;
    const dow = new Date(s.shift_date + 'T00:00:00').getDay();
    if (dow === 0 || dow === 5 || dow === 6) row.weekend += 1;
  });
  coverage.forEach((c) => { if (byStaff[c.requested_by]) byStaff[c.requested_by].coverage += 1; });
  claimedShifts.forEach((s) => { if (byStaff[s.claimed_by]) byStaff[s.claimed_by].claimedOpen += 1; });

  metricsRows = Object.values(byStaff);

  document.getElementById('metrics-summary').innerHTML =
    metricCard('Total Shifts', shifts.length)
    + metricCard('Total Hours', totalHours.toFixed(1))
    + metricCard('Staff Scheduled', metricsRows.length)
    + metricCard('Open Shifts', openSlots)
    + metricCard('Open Shifts Claimed', claimedShifts.length)
    + metricCard('Coverage Requests', coverage.length);

  renderMetricsTable();
}

function sortMetricsBy(field) {
  if (metricsSortField === field) {
    metricsSortDir = metricsSortDir === 'desc' ? 'asc' : 'desc';
  } else {
    metricsSortField = field;
    metricsSortDir = field === 'name' ? 'asc' : 'desc';
  }
  renderMetricsTable();
}

function renderMetricsTable() {
  const body = document.getElementById('metrics-body');
  if (!metricsRows.length) { body.innerHTML = '<div class="loading">No shifts scheduled this period</div>'; return; }

  const dir = metricsSortDir === 'desc' ? -1 : 1;
  const field = metricsSortField;
  const sorted = metricsRows.slice().sort((a, b) => {
    if (field === 'name') return dir * a.name.localeCompare(b.name);
    return dir * (a[field] - b[field]);
  });

  const headHtml = METRICS_COLUMNS.map((c) => {
    const active = c.key === field;
    const arrow = active ? (metricsSortDir === 'desc' ? ' ↓' : ' ↑') : '';
    return '<th style="cursor:pointer;user-select:none;' + (active ? 'color:var(--teal);' : '') + '" onclick="sortMetricsBy(\'' + c.key + '\')">' + c.label + arrow + '</th>';
  }).join('');

  body.innerHTML = '<div class="table-wrap"><table><thead><tr>' + headHtml + '</tr></thead><tbody>'
    + sorted.map((r) => '<tr><td>' + escHtml(r.name) + '</td><td>' + r.shifts + '</td><td>' + r.hours.toFixed(1) + '</td><td>' + r.morning + '</td><td>'
      + r.evening + '</td><td>' + r.mod + '</td><td>' + r.weekend + '</td><td>' + r.coverage + '</td><td>' + r.claimedOpen + '</td></tr>').join('')
    + '</tbody></table></div>';
}
