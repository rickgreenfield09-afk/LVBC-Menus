// metrics.js
// Schedule > Metrics sub-tab (admin/scheduler-only) — the landing tab
// for admins on the Schedule screen. Month-scoped dashboard
// summarizing who's carrying the schedule: shift counts, hours,
// morning/evening/MOD split, weekend load, coverage requests raised,
// and open shifts (posted with no staff_id — see migration_032) plus
// how many of those got claimed, and by whom.
// Depends on: window.supabase, toast(), escHtml() (menu.js),
// toDateStr/staffName/scheduleStaff (schedule.js)

let metricsCursor = new Date(new Date().getFullYear(), new Date().getMonth(), 1);

function metricsMonth(delta) {
  metricsCursor = new Date(metricsCursor.getFullYear(), metricsCursor.getMonth() + delta, 1);
  loadMetrics();
}

async function loadMetrics() {
  if (!scheduleStaff.length) await loadStaffAndSettings();
  document.getElementById('metrics-month-label').textContent = metricsCursor.toLocaleString('default', { month: 'long', year: 'numeric' });
  document.getElementById('metrics-body').innerHTML = '<div class="loading">Loading...</div>';

  const monthStart = toDateStr(new Date(metricsCursor.getFullYear(), metricsCursor.getMonth(), 1));
  const monthEnd = toDateStr(new Date(metricsCursor.getFullYear(), metricsCursor.getMonth() + 1, 0));

  const [{ data: shifts, error: shiftErr }, { data: coverage, error: covErr }] = await Promise.all([
    window.supabase.from('shifts').select('*').gte('shift_date', monthStart).lte('shift_date', monthEnd),
    window.supabase.from('coverage_requests').select('requested_by').gte('created_at', monthStart + 'T00:00:00').lt('created_at', toDateStr(new Date(metricsCursor.getFullYear(), metricsCursor.getMonth() + 1, 1)) + 'T00:00:00'),
  ]);
  if (shiftErr) { document.getElementById('metrics-body').innerHTML = '<div class="loading">Error: ' + escHtml(shiftErr.message) + '</div>'; return; }
  renderMetrics(shifts || [], covErr ? [] : (coverage || []));
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

function metricCard(label, value) {
  return '<div class="card" style="text-align:center;padding:16px;">'
    + '<div style="font-family:\'Bebas Neue\',sans-serif;font-size:28px;color:var(--teal);">' + value + '</div>'
    + '<div style="font-size:11px;color:var(--sub);letter-spacing:1px;text-transform:uppercase;">' + label + '</div></div>';
}

function renderMetrics(shifts, coverage) {
  // Unassigned shifts (staff_id null) don't belong to any staffer, so
  // they're excluded from the per-staff table and rolled up as their
  // own summary card instead. claimed_by stays stamped after a claim
  // fills in staff_id, so "was this originally open" survives.
  const assigned = shifts.filter((s) => s.staff_id);
  const openShifts = shifts.filter((s) => !s.staff_id);
  const claimedShifts = shifts.filter((s) => s.claimed_by);

  const byStaff = {};
  const rowFor = (id) => {
    if (!byStaff[id]) byStaff[id] = { name: staffName(id), shifts: 0, hours: 0, morning: 0, evening: 0, mod: 0, weekend: 0, coverage: 0, claimedOpen: 0 };
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

  const rows = Object.values(byStaff).sort((a, b) => b.shifts - a.shifts);

  document.getElementById('metrics-summary').innerHTML =
    metricCard('Total Shifts', shifts.length)
    + metricCard('Total Hours', totalHours.toFixed(1))
    + metricCard('Staff Scheduled', rows.length)
    + metricCard('Open Shifts', openShifts.length)
    + metricCard('Open Shifts Claimed', claimedShifts.length)
    + metricCard('Coverage Requests', coverage.length);

  const body = document.getElementById('metrics-body');
  if (!rows.length) { body.innerHTML = '<div class="loading">No shifts scheduled this month</div>'; return; }
  body.innerHTML = '<div class="table-wrap"><table><thead><tr>'
    + '<th>Staff</th><th>Shifts</th><th>Hours</th><th>Morning</th><th>Evening</th><th>MOD</th><th>Weekend</th><th>Coverage Requests</th><th>Open Shifts Claimed</th>'
    + '</tr></thead><tbody>'
    + rows.map((r) => '<tr><td>' + escHtml(r.name) + '</td><td>' + r.shifts + '</td><td>' + r.hours.toFixed(1) + '</td><td>' + r.morning + '</td><td>'
      + r.evening + '</td><td>' + r.mod + '</td><td>' + r.weekend + '</td><td>' + r.coverage + '</td><td>' + r.claimedOpen + '</td></tr>').join('')
    + '</tbody></table></div>';
}
