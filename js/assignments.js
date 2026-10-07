// assignments.js
// Screen: #screen-assignments — responsibilities that belong to a
// SHIFT rather than a person (migration_037 + 038). Whoever is
// scheduled on that shift sees them on their phone
// (mobile/js/tasks.js). This screen is for the people who build the
// schedule (canSchedule()); RLS enforces the same.
//
//   Dashboard               this week's shifts with each task done /
//                           open / missed, plus how many tasks were
//                           assigned to and completed by each employee
//   Inventory               which items and merch each shift counts
//   Cleaning & Maintenance  recurring tasks, plus special assignments
//   Shift Duties            opening, turnover and closing lists
//   Events                  off-site event checklists (js/offsite.js)
//
// Who a task belongs to:
//   opening    the AM bartender
//   turnover   the AM bartender, before handing off to the PM shift —
//              a day with one shift has no turnover
//   closing    the closing (PM) bartender
//   the rest   the AM or PM bartender, whichever the task names
// A day with a single shift (Sunday) gives that shift both periods'
// tasks; closed days get none — both read off shift_day_settings.
//
// How often:
//   daily      every open day
//   weekly     on its weekday
//   quarterly  once per calendar quarter; offered on every matching
//              shift until someone does it
//   ad hoc     on its due date, staying open until done. Naming an
//              employee makes it a SPECIAL ASSIGNMENT: theirs alone,
//              whatever shift they're on.
//
// Credit (assignment_completions.credited_to) is who the work counts
// for in the metrics. It's the person on the shift even when a
// manager ticks the box here — completed_by still records who ticked.
//
// An inventory task lists what to count: percent items, and merch
// styles each at a named location. The phone completes it
// automatically once every one has been counted that day.
// Depends on: window.supabase, window.currentStaff, toast(),
// escHtml() (menu.js), canSchedule/toDateStr/staffName/scheduleStaff/
// scheduleDaySettings/loadStaffAndSettings (schedule.js),
// INV_CATEGORY_LABELS (inventory.js), invLoadLocations/invLocationPath/
// invLocationOptions (locations.js), loadOffsite (offsite.js)

const ASG_CATEGORIES = { inventory: 'Inventory', cleaning: 'Cleaning', maintenance: 'Maintenance', opening: 'Opening', turnover: 'Turnover', closing: 'Closing' };
// Badge color follows the page a category lives on, not the category itself.
const ASG_CATEGORY_BADGE = { inventory: 'badge-teal', cleaning: 'badge-purple', maintenance: 'badge-purple', opening: 'badge-amber', turnover: 'badge-amber', closing: 'badge-amber' };
const ASG_PAGES = { inventory: ['inventory'], cleaning: ['cleaning', 'maintenance'], duties: ['opening', 'turnover', 'closing'] };
const ASG_VIEWS = ['dashboard', 'inventory', 'cleaning', 'duties', 'events'];
// Shift duties don't get to choose a shift — the duty decides it.
const ASG_FIXED_PERIOD = { opening: 'morning', turnover: 'morning', closing: 'evening' };
const ASG_DUTY_NOTE = { opening: 'AM bartender', turnover: 'AM bartender, before handing off', closing: 'Closing bartender' };
const ASG_FREQUENCIES = { daily: 'Daily', weekly: 'Weekly', quarterly: 'Quarterly', adhoc: 'Ad hoc' };
const ASG_PERIODS = { morning: 'AM', evening: 'PM' };
const ASG_DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

let asgTasks = [];
let asgTargets = [];
let asgCompletions = [];
let asgWeekShifts = [];
let asgItems = [];        // percent items, for target pickers and labels
let asgMerchStyles = [];  // active styles with their product name
let asgView = 'dashboard';
let asgWeekStart = asgSundayOf(new Date());
let asgMetricsMode = 'month'; // 'week' | 'month' | 'quarter'
let asgMetrics = null;        // { shifts, completions, start, end } for the metrics table
let asgEditId = null;
let asgFormOpen = false;
let asgFormDraft = null;
let asgFormTargets = [];  // targets in the open form, saved with the task

function asgSundayOf(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate() - d.getDay()); }
function asgQuarterStart(dateStr) { return dateStr.slice(0, 5) + String(Math.floor((+dateStr.slice(5, 7) - 1) / 3) * 3 + 1).padStart(2, '0') + '-01'; }
function asgQuarterKey(dateStr) { return dateStr.slice(0, 4) + '-Q' + (Math.floor((+dateStr.slice(5, 7) - 1) / 3) + 1); }
function asgDueKey(task, dateStr) {
  return task.frequency === 'quarterly' ? asgQuarterKey(dateStr) : task.frequency === 'adhoc' ? 'adhoc' : dateStr;
}
function asgFindCompletion(list, task, dateStr) {
  const key = asgDueKey(task, dateStr);
  return list.find((c) => c.task_id === task.id && c.due_key === key);
}
function asgCompletion(task, dateStr) { return asgFindCompletion(asgCompletions, task, dateStr); }
function asgShortDate(dateStr) { return new Date(dateStr + 'T00:00:00').toLocaleDateString('default', { month: 'short', day: 'numeric' }); }

// The shifts a weekday has, and which periods' tasks each one carries.
function asgSlots(dow) {
  const s = scheduleDaySettings.find((x) => x.day_of_week === dow);
  if (!s || s.is_closed) return [];
  const periods = ['morning', 'evening'].filter((p) => s[p + '_start']);
  return periods.length === 1 ? [{ period: periods[0], covers: ['morning', 'evening'] }] : periods.map((p) => ({ period: p, covers: [p] }));
}

// The shift-bound tasks that fall on one shift of one date: daily and
// weekly ones, plus an ad hoc task on its due date. Special
// assignments belong to a person, and quarterly tasks to no one day,
// so neither is here. A task doesn't count against dates before it existed.
function asgTasksOnShift(dateStr, slot) {
  const dow = new Date(dateStr + 'T00:00:00').getDay();
  const single = slot.covers.length > 1;
  return asgTasks.filter((t) => t.is_active && !t.assigned_staff_id && slot.covers.includes(t.period)
    && !(t.category === 'turnover' && single) && toDateStr(new Date(t.created_at)) <= dateStr
    && (t.frequency === 'daily' || (t.frequency === 'weekly' && t.day_of_week === dow) || (t.frequency === 'adhoc' && t.due_date === dateStr)));
}

async function loadAssignments() {
  if (!scheduleDaySettings.length) await loadStaffAndSettings();
  const [tasks, targets, items, styles] = await Promise.all([
    window.supabase.from('assignment_tasks').select('*').order('sort_order').order('title'),
    window.supabase.from('assignment_task_targets').select('*'),
    window.supabase.from('inventory_items').select('id,name,category').order('name'),
    window.supabase.from('inventory_merch_styles').select('id,color,design,inventory_merch_products(name)').eq('status', 'active'),
    invLoadLocations(),
  ]);
  const failed = [tasks, targets, items, styles].find((r) => r.error);
  if (failed) { document.getElementById('asg-body').innerHTML = '<div class="loading">Could not load assignments: ' + escHtml(failed.error.message) + '</div>'; return; }
  asgTasks = tasks.data;
  asgTargets = targets.data;
  asgItems = items.data;
  asgMerchStyles = styles.data.map((s) => ({ id: s.id, label: s.inventory_merch_products.name + ([s.color, s.design].filter(Boolean).length ? ' — ' + [s.color, s.design].filter(Boolean).join(' · ') : '') }))
    .sort((a, b) => a.label.localeCompare(b.label));
  setAssignmentsView(asgView);
}

function setAssignmentsView(view) {
  asgView = view;
  asgFormOpen = false;
  ASG_VIEWS.forEach((v) => document.getElementById('asg-view-' + v).classList.toggle('active', v === view));
  if (view === 'events') loadOffsite(); else loadAssignmentsWeek();
}

function asgRender() {
  if (asgView === 'dashboard') renderAssignmentsDashboard();
  else if (asgView === 'duties') renderAssignmentsDuties();
  else if (asgView !== 'events') renderAssignmentsPlan();
}

function asgTargetLabel(t) {
  if (t.item_id) { const i = asgItems.find((x) => x.id === t.item_id); return i ? i.name : 'Removed item'; }
  const s = asgMerchStyles.find((x) => x.id === t.merch_style_id);
  return (s ? s.label : 'Retired merch') + ' @ ' + invLocationPath(t.location_id);
}

function asgBadge(task) { return '<span class="badge ' + ASG_CATEGORY_BADGE[task.category] + '">' + ASG_CATEGORIES[task.category] + '</span>'; }

// draggable is only set on the Shift Duties lists, where order is the point.
function asgTaskChipHtml(task, metaText, draggable) {
  const n = asgTargets.filter((t) => t.task_id === task.id).length;
  return '<div class="asg-task' + (task.is_active ? '' : ' paused') + '" onclick="openAssignmentForm(\'' + task.id + '\')"'
    + (draggable ? ' draggable="true" data-task-id="' + task.id + '" ondragstart="asgDragStart(event)" ondragover="asgDragOver(event)" ondragleave="asgDragLeave(event)" ondrop="asgDrop(event)" ondragend="asgDragEnd()"' : '') + '>'
    + (draggable ? '<span class="asg-grip" aria-hidden="true">&#8942;&#8942;</span> ' : '')
    + asgBadge(task) + ' <span class="asg-task-title">' + escHtml(task.title) + '</span>'
    + (n ? ' <span class="asg-task-meta">' + n + ' to count</span>' : '')
    + (metaText ? ' <span class="asg-task-meta">' + escHtml(metaText) + '</span>' : '')
    + (task.is_active ? '' : ' <span class="badge badge-muted">Paused</span>') + '</div>';
}

// ── INVENTORY / CLEANING & MAINTENANCE PAGES ─────
function renderAssignmentsPlan() {
  const cats = ASG_PAGES[asgView];
  const shown = asgTasks.filter((t) => cats.includes(t.category));
  const cell = (tasks) => (tasks.length ? tasks.map((t) => asgTaskChipHtml(t)).join('') : '<span class="asg-empty">—</span>');
  const today = toDateStr(new Date());

  let html = '<div class="menu-col-header"><div class="card-sub" style="margin:0;max-width:640px;">'
    + (asgView === 'inventory' ? 'Spread the count across the week: give each shift a few items and one or two pieces of merch. Click a task to change it.'
      : 'Recurring cleaning and maintenance by shift. For a one-off job, add an ad hoc task and name the person to make it a special assignment.')
    + '</div><button class="btn btn-sm btn-primary" onclick="openAssignmentForm(null)">+ Add Task</button></div>'
    + '<div id="asg-form"></div>'
    + '<div class="table-wrap asg-grid"><table><thead><tr><th style="width:140px;"></th><th>AM Bartender</th><th>PM Bartender</th></tr></thead><tbody>'
    + '<tr><td class="asg-day">Every open day</td>' + ['morning', 'evening'].map((p) => '<td>' + cell(shown.filter((t) => t.frequency === 'daily' && t.period === p)) + '</td>').join('') + '</tr>';
  for (let dow = 0; dow < 7; dow++) {
    const slots = asgSlots(dow);
    if (!slots.length) continue;
    const weekly = shown.filter((t) => t.frequency === 'weekly' && t.day_of_week === dow);
    html += '<tr><td class="asg-day">' + ASG_DAYS[dow] + (slots.length === 1 ? '<div class="asg-task-meta">one shift</div>' : '') + '</td>'
      + (slots.length === 1 ? '<td colspan="2">' + cell(weekly) + '</td>' : slots.map((s) => '<td>' + cell(weekly.filter((t) => t.period === s.period)) + '</td>').join('')) + '</tr>';
  }
  html += '</tbody></table></div>';

  const list = (title, tasks, meta) => '<div class="grid2-col"><div class="section-label">' + title + '</div><div class="card">'
    + (tasks.length ? tasks.map((t) => asgTaskChipHtml(t, meta(t))).join('') : '<div class="loading">None yet</div>') + '</div></div>';
  html += '<div class="grid-2">'
    + list('Quarterly', shown.filter((t) => t.frequency === 'quarterly'),
      (t) => ASG_PERIODS[t.period] + (t.day_of_week != null ? ' · ' + ASG_DAYS[t.day_of_week] + 's' : ' · any day') + (asgCompletion(t, today) ? ' · done this quarter' : ' · open this quarter'))
    + list(asgView === 'cleaning' ? 'Ad hoc & Special Assignments' : 'Ad hoc', shown.filter((t) => t.frequency === 'adhoc').sort((a, b) => b.due_date.localeCompare(a.due_date)),
      (t) => (t.assigned_staff_id ? staffName(t.assigned_staff_id) : ASG_PERIODS[t.period] + ' shift') + ' · due ' + asgShortDate(t.due_date) + (asgCompletion(t, today) ? ' · done' : t.due_date < today ? ' · overdue' : ''))
    + '</div>';
  document.getElementById('asg-body').innerHTML = html;
  if (asgFormOpen) renderAssignmentForm();
}

// ── SHIFT DUTIES PAGE ────────────────────────────
function renderAssignmentsDuties() {
  const column = (cat) => {
    const tasks = asgDutyList(cat);
    return '<div class="grid2-col"><div class="menu-col-header"><div><div class="section-label" style="margin:0;">' + ASG_CATEGORIES[cat] + '</div><div class="asg-task-meta">' + ASG_DUTY_NOTE[cat] + '</div></div>'
      + '<button class="btn btn-sm btn-secondary" onclick="openAssignmentForm(null,\'' + cat + '\')">+ Add</button></div><div class="card">'
      + (tasks.length ? tasks.map((t) => asgTaskChipHtml(t, t.frequency === 'daily' ? 'every open day' : ASG_DAYS[t.day_of_week] + 's', true)).join('') : '<div class="loading">Nothing listed yet</div>')
      + '</div></div>';
  };
  document.getElementById('asg-body').innerHTML = '<div class="card-sub" style="margin:0 0 16px;max-width:640px;">What every shift does at each end, in the order it\'s done — drag a duty to move it. Turnover is the AM bartender\'s handoff to the PM shift, so a day with only one shift skips it and that shift does both opening and closing.</div>'
    + '<div id="asg-form"></div><div class="grid-2" style="grid-template-columns:repeat(3,1fr);">' + ASG_PAGES.duties.map(column).join('') + '</div>';
  if (asgFormOpen) renderAssignmentForm();
}

// One duty list in its saved order — the order the phone shows it in.
function asgDutyList(cat) {
  return asgTasks.filter((t) => t.category === cat).sort((a, b) => a.sort_order - b.sort_order || a.title.localeCompare(b.title));
}

// ── DRAG TO REORDER (Shift Duties) ───────────────
let asgDragId = null;

function asgDragStart(e) {
  asgDragId = e.currentTarget.dataset.taskId;
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', asgDragId);
  e.currentTarget.classList.add('dragging');
}

// A duty can only be dropped within its own list (opening / turnover / closing).
function asgDropTarget(e) {
  const dragged = asgTasks.find((t) => t.id === asgDragId);
  const target = asgTasks.find((t) => t.id === e.currentTarget.dataset.taskId);
  return dragged && target && dragged.id !== target.id && dragged.category === target.category ? target : null;
}

function asgDragOver(e) {
  if (!asgDropTarget(e)) return;
  e.preventDefault();
  const rect = e.currentTarget.getBoundingClientRect();
  const after = e.clientY > rect.top + rect.height / 2;
  e.currentTarget.classList.toggle('drop-after', after);
  e.currentTarget.classList.toggle('drop-before', !after);
}

function asgDragLeave(e) { e.currentTarget.classList.remove('drop-before', 'drop-after'); }
function asgDragEnd() { asgDragId = null; document.querySelectorAll('.asg-task.dragging,.asg-task.drop-before,.asg-task.drop-after').forEach((el) => el.classList.remove('dragging', 'drop-before', 'drop-after')); }

async function asgDrop(e) {
  const target = asgDropTarget(e);
  if (!target) return;
  e.preventDefault();
  const after = e.currentTarget.classList.contains('drop-after');
  const ids = asgDutyList(target.category).map((t) => t.id).filter((id) => id !== asgDragId);
  ids.splice(ids.indexOf(target.id) + (after ? 1 : 0), 0, asgDragId);
  asgDragEnd();

  // Renumber the whole list 1..n and save only the rows whose number moved.
  const changed = [];
  ids.forEach((id, i) => { const t = asgTasks.find((x) => x.id === id); if (t.sort_order !== i + 1) { t.sort_order = i + 1; changed.push(t); } });
  renderAssignmentsDuties();
  const results = await Promise.all(changed.map((t) => window.supabase.from('assignment_tasks').update({ sort_order: t.sort_order }).eq('id', t.id)));
  const failed = results.find((r) => r.error);
  if (failed) { toast('Could not save the new order: ' + failed.error.message, true); await loadAssignments(); }
}

// ── DUTIES ON THE SHIFT POPUP (Schedule calendar + My Shifts) ──
// Fills #shift-modal-duties with what each shift on that date is
// responsible for. On My Shifts it's only the shifts you hold; on the
// scheduler's calendar it's every shift that day. Read-only — the work
// is checked off on the phone or the Assignments dashboard.
async function renderShiftModalDuties(dateStr, shifts, context, myIds) {
  const el = document.getElementById('shift-modal-duties');
  if (!el) return;
  el.innerHTML = '';
  const slots = asgSlots(new Date(dateStr + 'T00:00:00').getDay());
  if (!slots.length) return;
  // The popup can open before anyone has visited Assignments.
  const [tasks, completions] = await Promise.all([
    asgTasks.length ? { data: asgTasks } : window.supabase.from('assignment_tasks').select('*').order('sort_order').order('title'),
    window.supabase.from('assignment_completions').select('task_id,due_key,completed_by,credited_to').eq('due_key', dateStr),
  ]);
  if (tasks.error || !tasks.data) return;
  asgTasks = tasks.data;
  const done = completions.data || [];

  let html = '';
  slots.forEach((slot) => {
    const onShift = shifts.filter((s) => s.role === 'bartender' && s.staff_id && (slots.length === 1 || s.period === slot.period));
    if (context === 'myshifts' && !onShift.some((s) => myIds.includes(s.staff_id))) return;
    const duties = asgTasksOnShift(dateStr, slot);
    if (!duties.length) return;
    const who = [...new Set(onShift.map((s) => staffName(s.staff_id)))].join(', ');
    html += '<div class="asg-who" style="margin-top:12px;">' + (slots.length === 1 ? 'Shift' : ASG_PERIODS[slot.period] + ' bartender') + (who ? ' · ' + escHtml(who) : '') + '</div>'
      + Object.keys(ASG_CATEGORIES).map((cat) => duties.filter((t) => t.category === cat).map((t) => {
        const c = done.find((x) => x.task_id === t.id);
        return '<div class="asg-week-task">' + asgBadge(t) + ' <span class="asg-task-title">' + escHtml(t.title) + '</span>'
          + (c ? ' <span class="asg-status done">&#10003; ' + escHtml(staffName(c.credited_to || c.completed_by)) + '</span>' : '') + '</div>';
      }).join('')).join('');
  });
  el.innerHTML = html ? '<div class="section-label">' + (context === 'myshifts' ? 'Your Duties This Shift' : 'Shift Duties') + '</div>' + html : '';
}

// ── TASK FORM ────────────────────────────────────
function openAssignmentForm(taskId, presetCategory) {
  const t = taskId ? asgTasks.find((x) => x.id === taskId) : null;
  // A task opened from the dashboard is edited on the page it lives on.
  const page = Object.keys(ASG_PAGES).find((p) => ASG_PAGES[p].includes(t ? t.category : presetCategory || (ASG_PAGES[asgView] || [])[0])) || 'cleaning';
  if (page !== asgView) { asgView = page; ASG_VIEWS.forEach((v) => document.getElementById('asg-view-' + v).classList.toggle('active', v === page)); }
  asgEditId = t ? t.id : null;
  const category = presetCategory || ASG_PAGES[page][0];
  asgFormDraft = t ? Object.assign({}, t) : { title: '', category, frequency: 'daily', period: ASG_FIXED_PERIOD[category] || 'morning', day_of_week: 1, due_date: toDateStr(new Date()), instructions: '', is_active: true, assigned_staff_id: null };
  asgFormTargets = t ? asgTargets.filter((x) => x.task_id === t.id).map((x) => ({ item_id: x.item_id, merch_style_id: x.merch_style_id, location_id: x.location_id })) : [];
  asgFormOpen = true;
  asgRender();
  document.getElementById('asg-form').scrollIntoView({ block: 'nearest' });
}

function closeAssignmentForm() { asgFormOpen = false; asgEditId = null; asgRender(); }

// Field changes that decide which other fields show re-render the form.
function setAssignmentDraft(field, value) {
  asgFormDraft[field] = value;
  if (field === 'category' && ASG_FIXED_PERIOD[value]) asgFormDraft.period = ASG_FIXED_PERIOD[value];
  if (field === 'frequency' || field === 'category') renderAssignmentForm();
}

function renderAssignmentForm() {
  const d = asgFormDraft;
  const duties = asgView === 'duties';
  const pick = (map, keys) => keys.reduce((o, k) => { o[k] = map[k]; return o; }, {});
  const opts = (map, sel) => Object.keys(map).map((k) => '<option value="' + k + '"' + (String(sel) === k ? ' selected' : '') + '>' + map[k] + '</option>').join('');
  const dayOpts = (sel, withAny) => (withAny ? '<option value="">Any day</option>' : '')
    + ASG_DAYS.map((name, dow) => (asgSlots(dow).length ? '<option value="' + dow + '"' + (sel === dow ? ' selected' : '') + '>' + name + '</option>' : '')).join('');
  const field = (label, inner) => '<div class="form-group"><label class="form-label">' + label + '</label>' + inner + '</div>';
  const categories = pick(ASG_CATEGORIES, ASG_PAGES[asgView]);
  // Shift duties repeat every day or on a weekday; they aren't quarterly or one-off.
  const frequencies = duties ? pick(ASG_FREQUENCIES, ['daily', 'weekly']) : ASG_FREQUENCIES;

  let html = '<div class="card asg-form-card"><div class="menu-col-header"><div class="section-label" style="margin:0;">' + (asgEditId ? 'Edit Task' : 'Add Task') + '</div></div>'
    + '<div class="form-row">'
    + field('Task', '<input class="form-input" type="text" id="asg-f-title" value="' + escHtml(d.title) + '" oninput="setAssignmentDraft(\'title\',this.value)" placeholder="e.g. Wipe down tap handles">')
    + (Object.keys(categories).length > 1 ? field('Type', '<select class="form-select" onchange="setAssignmentDraft(\'category\',this.value)">' + opts(categories, d.category) + '</select>')
      : field('Type', '<input class="form-input" type="text" value="' + ASG_CATEGORIES[d.category] + '" disabled>'))
    + '</div><div class="form-row" style="grid-template-columns:1fr 1fr 1fr;">'
    + field('How Often', '<select class="form-select" onchange="setAssignmentDraft(\'frequency\',this.value)">' + opts(frequencies, d.frequency) + '</select>')
    + (duties ? field('Whose', '<input class="form-input" type="text" value="' + ASG_DUTY_NOTE[d.category] + '" disabled>')
      : field('Shift', '<select class="form-select" onchange="setAssignmentDraft(\'period\',this.value)">' + opts({ morning: 'AM Bartender', evening: 'PM Bartender' }, d.period) + '</select>'))
    + (d.frequency === 'weekly' ? field('Day', '<select class="form-select" onchange="setAssignmentDraft(\'day_of_week\',+this.value)">' + dayOpts(d.day_of_week, false) + '</select>') : '')
    + (d.frequency === 'quarterly' ? field('Only On', '<select class="form-select" onchange="setAssignmentDraft(\'day_of_week\',this.value === \'\' ? null : +this.value)">' + dayOpts(d.day_of_week, true) + '</select>') : '')
    + (d.frequency === 'adhoc' ? field('Due', '<input class="form-input" type="date" value="' + escHtml(d.due_date) + '" onchange="setAssignmentDraft(\'due_date\',this.value)">') : '')
    + (d.frequency === 'daily' ? field('Day', '<input class="form-input" type="text" value="Every open day" disabled>') : '')
    + '</div>'
    + (d.frequency === 'adhoc' ? '<div class="form-group" style="margin-bottom:16px;"><label class="form-label">Assign To</label><select class="form-select" onchange="setAssignmentDraft(\'assigned_staff_id\',this.value || null)">'
      + '<option value="">Whoever is on that shift</option>' + scheduleStaff.map((s) => '<option value="' + s.id + '"' + (s.id === d.assigned_staff_id ? ' selected' : '') + '>' + escHtml(s.name) + ' (special assignment)</option>').join('') + '</select></div>' : '')
    + '<div class="form-group" style="margin-bottom:16px;"><label class="form-label">Instructions</label><textarea class="form-ta" rows="2" oninput="setAssignmentDraft(\'instructions\',this.value)" placeholder="optional — shown to the person doing it">' + escHtml(d.instructions) + '</textarea></div>';

  if (d.category === 'inventory') {
    const byCat = {};
    asgItems.forEach((i) => { (byCat[i.category] = byCat[i.category] || []).push(i); });
    html += '<div class="form-group" style="margin-bottom:16px;"><label class="form-label">What To Count</label>'
      + (asgFormTargets.length ? '<div class="asg-targets">' + asgFormTargets.map((t, i) => '<div class="asg-target">' + escHtml(asgTargetLabel(t)) + ' <button class="merch-link" onclick="removeAssignmentTarget(' + i + ')">remove</button></div>').join('') + '</div>'
        : '<div class="card-sub" style="margin-bottom:8px;">Nothing added yet. Without anything to count this is a plain check-off.</div>')
      + '<div class="asg-target-add"><select class="form-select" id="asg-f-item"><option value="">Add an item…</option>'
      + Object.keys(byCat).map((c) => '<optgroup label="' + escHtml(INV_CATEGORY_LABELS[c] || c) + '">' + byCat[c].map((i) => '<option value="' + i.id + '">' + escHtml(i.name) + '</option>').join('') + '</optgroup>').join('')
      + '</select><button class="btn btn-sm btn-secondary" onclick="addAssignmentItemTarget()">Add Item</button></div>'
      + '<div class="asg-target-add"><select class="form-select" id="asg-f-style"><option value="">Add merch…</option>' + asgMerchStyles.map((s) => '<option value="' + s.id + '">' + escHtml(s.label) + '</option>').join('') + '</select>'
      + '<select class="form-select" id="asg-f-style-loc">' + invLocationOptions(null, 'Count it at…') + '</select>'
      + '<button class="btn btn-sm btn-secondary" onclick="addAssignmentMerchTarget()">Add Merch</button></div></div>';
  }

  html += '<label class="checkbox-row" style="margin-bottom:16px;"><input type="checkbox"' + (d.is_active ? ' checked' : '') + ' onchange="setAssignmentDraft(\'is_active\',this.checked)"> Active (untick to pause without losing its history)</label>'
    + '<div style="display:flex;gap:8px;flex-wrap:wrap;">'
    + '<button class="btn btn-primary" onclick="saveAssignmentTask()">' + (asgEditId ? 'Save Changes' : 'Add Task') + '</button>'
    + '<button class="btn btn-secondary" onclick="closeAssignmentForm()">Cancel</button>'
    + (asgEditId ? '<button class="btn btn-danger" style="margin-left:auto;" onclick="deleteAssignmentTask()">Delete Task</button>' : '')
    + '</div></div>';
  document.getElementById('asg-form').innerHTML = html;
}

function addAssignmentItemTarget() {
  const id = document.getElementById('asg-f-item').value;
  if (!id) return;
  if (asgFormTargets.some((t) => t.item_id === id)) { toast('Already on this task', true); return; }
  asgFormTargets.push({ item_id: id, merch_style_id: null, location_id: null });
  renderAssignmentForm();
}

function addAssignmentMerchTarget() {
  const styleId = document.getElementById('asg-f-style').value;
  const locId = document.getElementById('asg-f-style-loc').value;
  if (!styleId || !locId) { toast('Pick the merch and the location to count it at', true); return; }
  if (asgFormTargets.some((t) => t.merch_style_id === styleId && t.location_id === locId)) { toast('Already on this task', true); return; }
  asgFormTargets.push({ item_id: null, merch_style_id: styleId, location_id: locId });
  renderAssignmentForm();
}

function removeAssignmentTarget(index) { asgFormTargets.splice(index, 1); renderAssignmentForm(); }

async function saveAssignmentTask() {
  const d = asgFormDraft;
  if (!d.title.trim()) { toast('Give the task a name', true); return; }
  const payload = {
    title: d.title.trim(), category: d.category, frequency: d.frequency, period: ASG_FIXED_PERIOD[d.category] || d.period,
    instructions: (d.instructions || '').trim() || null, is_active: !!d.is_active,
    day_of_week: d.frequency === 'weekly' ? d.day_of_week : d.frequency === 'quarterly' ? (d.day_of_week == null ? null : d.day_of_week) : null,
    due_date: d.frequency === 'adhoc' ? d.due_date : null,
    assigned_staff_id: d.frequency === 'adhoc' ? d.assigned_staff_id || null : null,
  };
  if (d.frequency === 'adhoc' && !payload.due_date) { toast('Pick a due date', true); return; }
  const { data: saved, error } = asgEditId
    ? await window.supabase.from('assignment_tasks').update(payload).eq('id', asgEditId).select().single()
    // A new task goes to the end of its type's list (migration_039).
    : await window.supabase.from('assignment_tasks').insert(Object.assign({ created_by: window.currentStaff.id,
      sort_order: Math.max(0, ...asgTasks.filter((t) => t.category === payload.category).map((t) => t.sort_order || 0)) + 1 }, payload)).select().single();
  if (error) { toast(error.message, true); return; }

  // Targets are replaced wholesale — simpler than diffing, and a task only has a handful.
  const { error: delErr } = await window.supabase.from('assignment_task_targets').delete().eq('task_id', saved.id);
  const targets = d.category === 'inventory' ? asgFormTargets.map((t) => Object.assign({ task_id: saved.id }, t)) : [];
  const { error: insErr } = targets.length ? await window.supabase.from('assignment_task_targets').insert(targets) : { error: null };
  if (delErr || insErr) { toast('Task saved, but its count list did not: ' + (delErr || insErr).message, true); }
  else toast(asgEditId ? 'Task updated' : 'Task added');
  asgFormOpen = false;
  asgEditId = null;
  await loadAssignments();
}

async function deleteAssignmentTask() {
  const t = asgTasks.find((x) => x.id === asgEditId);
  if (!t || !confirm('Delete "' + t.title + '" and its completion history? To stop it without losing the history, untick Active instead.')) return;
  const { error } = await window.supabase.from('assignment_tasks').delete().eq('id', t.id);
  if (error) { toast(error.message, true); return; }
  toast('Task deleted');
  asgFormOpen = false;
  asgEditId = null;
  await loadAssignments();
}

// ── DASHBOARD ────────────────────────────────────
function assignmentsWeekNav(delta) {
  asgWeekStart = delta === 0 ? asgSundayOf(new Date()) : new Date(asgWeekStart.getFullYear(), asgWeekStart.getMonth(), asgWeekStart.getDate() + delta * 7);
  loadAssignmentsWeek();
}

// Loads the week on screen. The plan pages call it too, for their
// "done this quarter" notes.
async function loadAssignmentsWeek() {
  const start = toDateStr(asgWeekStart);
  const end = toDateStr(new Date(asgWeekStart.getFullYear(), asgWeekStart.getMonth(), asgWeekStart.getDate() + 6));
  const quarterStart = asgQuarterStart(start);
  // Completions for this week's dates, plus anything that settles a quarterly or ad hoc task.
  const [completions, shifts] = await Promise.all([
    window.supabase.from('assignment_completions').select('*').or('due_key.eq.adhoc,completed_on.gte.' + (quarterStart < start ? quarterStart : start)),
    window.supabase.from('shifts').select('shift_date,period,staff_id,role').gte('shift_date', start).lte('shift_date', end).eq('role', 'bartender'),
  ]);
  if (completions.error) { document.getElementById('asg-body').innerHTML = '<div class="loading">Could not load this week: ' + escHtml(completions.error.message) + '</div>'; return; }
  asgCompletions = completions.data;
  asgWeekShifts = shifts.data || [];
  if (asgView === 'dashboard') await loadAssignmentsMetrics();
  asgRender();
}

function asgStatusHtml(c, dateStr, today) {
  return c ? '<span class="asg-status done">&#10003; ' + escHtml(staffName(c.credited_to || c.completed_by)) + '</span>'
    : dateStr < today ? '<span class="asg-status missed">&#10007; Missed</span>'
      : dateStr === today ? '<span class="asg-status open">Open</span>' : '';
}

function renderAssignmentsDashboard() {
  const today = toDateStr(new Date());
  const days = [];
  for (let i = 0; i < 7; i++) days.push(new Date(asgWeekStart.getFullYear(), asgWeekStart.getMonth(), asgWeekStart.getDate() + i));
  let due = 0, done = 0, missed = 0;

  const taskRow = (t, dateStr, period) => {
    const c = asgCompletion(t, dateStr);
    if (dateStr <= today) { due++; if (c) done++; else if (dateStr < today) missed++; }
    const action = dateStr > today ? '' : c
      ? '<button class="merch-link" onclick="undoAssignmentDone(\'' + c.id + '\')">undo</button>'
      : '<button class="merch-link" onclick="markAssignmentDone(\'' + t.id + '\',\'' + dateStr + '\',\'' + period + '\')">mark done</button>';
    return '<div class="asg-week-task">' + asgBadge(t) + ' <span class="asg-task-title asg-link" onclick="openAssignmentForm(\'' + t.id + '\')">' + escHtml(t.title) + '</span> ' + asgStatusHtml(c, dateStr, today) + ' ' + action + '</div>';
  };

  let rows = '';
  days.forEach((d) => {
    const dateStr = toDateStr(d);
    const slots = asgSlots(d.getDay());
    if (!slots.length) return;
    rows += '<tr' + (dateStr === today ? ' class="asg-today"' : '') + '><td class="asg-day">' + d.toLocaleDateString('default', { weekday: 'long' }) + '<div class="asg-task-meta">' + asgShortDate(dateStr) + '</div></td>';
    slots.forEach((s) => {
      const who = asgWeekShifts.filter((x) => x.shift_date === dateStr && (slots.length === 1 || x.period === s.period)).map((x) => (x.staff_id ? staffName(x.staff_id) : 'Open shift'));
      const tasks = asgTasksOnShift(dateStr, s);
      rows += '<td' + (slots.length === 1 ? ' colspan="2"' : '') + '><div class="asg-who">' + (who.length ? escHtml([...new Set(who)].join(', ')) : 'No one scheduled') + '</div>'
        + (tasks.length ? tasks.map((t) => taskRow(t, dateStr, s.period)).join('') : '<span class="asg-empty">No tasks</span>') + '</td>';
    });
    rows += '</tr>';
  });

  const label = asgShortDate(toDateStr(days[0])) + ' – ' + days[6].toLocaleDateString('default', { month: 'short', day: 'numeric', year: 'numeric' });
  const tile = (title, value, sub) => '<div class="card"><div class="card-title">' + title + '</div><div class="card-value">' + value + '</div><div class="card-sub">' + sub + '</div></div>';
  // Not tied to one shift, so they sit below the grid: quarterly tasks,
  // special assignments, and ad hoc tasks that slipped past their date.
  const quarterly = asgTasks.filter((t) => t.is_active && t.frequency === 'quarterly');
  const special = asgTasks.filter((t) => t.is_active && t.assigned_staff_id && (!asgCompletion(t, today) || asgCompletion(t, today).completed_on >= toDateStr(days[0])));
  const overdue = asgTasks.filter((t) => t.is_active && t.frequency === 'adhoc' && !t.assigned_staff_id && t.due_date < today && !asgCompletion(t, today));
  const loose = (t, note) => { const c = asgCompletion(t, today); return '<div class="asg-week-task">' + asgBadge(t) + ' <span class="asg-task-title asg-link" onclick="openAssignmentForm(\'' + t.id + '\')">' + escHtml(t.title) + '</span> <span class="asg-task-meta">' + escHtml(note) + '</span> '
    + (c ? '<span class="asg-status done">&#10003; ' + escHtml(staffName(c.credited_to || c.completed_by)) + '</span> <button class="merch-link" onclick="undoAssignmentDone(\'' + c.id + '\')">undo</button>'
      : '<span class="asg-status ' + (t.frequency === 'adhoc' && t.due_date < today ? 'missed">Overdue' : 'open">Open') + '</span> <button class="merch-link" onclick="markAssignmentDone(\'' + t.id + '\',\'' + today + '\',\'\')">mark done</button>') + '</div>'; };

  document.getElementById('asg-body').innerHTML = '<div class="menu-col-header"><div style="display:flex;align-items:center;gap:8px;">'
    + '<button class="btn btn-sm btn-secondary" aria-label="Previous week" onclick="assignmentsWeekNav(-1)">&#8249;</button>'
    + '<div class="section-label" style="margin:0;min-width:190px;text-align:center;">' + label + '</div>'
    + '<button class="btn btn-sm btn-secondary" aria-label="Next week" onclick="assignmentsWeekNav(1)">&#8250;</button>'
    + '<button class="btn btn-sm btn-secondary" onclick="assignmentsWeekNav(0)">This Week</button></div></div>'
    + '<div class="grid-4" style="grid-template-columns:repeat(3,1fr);">' + tile('Done', done + ' / ' + due, 'of tasks due so far this week') + tile('Missed', missed, 'past shifts, not checked off')
    + tile('Open Quarterly', quarterly.filter((t) => !asgCompletion(t, today)).length, 'not yet done this quarter') + '</div>'
    + (rows ? '<div class="table-wrap asg-grid"><table><thead><tr><th style="width:140px;"></th><th>AM Bartender</th><th>PM Bartender</th></tr></thead><tbody>' + rows + '</tbody></table></div>' : '<div class="loading">No open days this week.</div>')
    + (quarterly.length || special.length || overdue.length ? '<div class="section-label">Not tied to one shift</div><div class="card">'
      + special.map((t) => loose(t, 'special assignment · ' + staffName(t.assigned_staff_id) + ' · due ' + asgShortDate(t.due_date))).join('')
      + overdue.map((t) => loose(t, 'ad hoc · was due ' + asgShortDate(t.due_date))).join('')
      + quarterly.map((t) => loose(t, 'quarterly · ' + ASG_PERIODS[t.period] + (t.day_of_week != null ? ' · ' + ASG_DAYS[t.day_of_week] + 's' : ''))).join('') + '</div>' : '')
    + (asgTasks.length ? '' : '<div class="card-sub" style="margin-top:16px;">No tasks yet — add them on the Inventory, Cleaning &amp; Maintenance and Shift Duties pages.</div>')
    + assignmentsMetricsHtml();
}

// Credit goes to the person on the shift, even when a manager ticks
// the box here; a special assignment credits its assignee. With two
// bartenders on one shift the first one scheduled gets it.
async function markAssignmentDone(taskId, dateStr, period) {
  const task = asgTasks.find((t) => t.id === taskId);
  const slots = asgSlots(new Date(dateStr + 'T00:00:00').getDay());
  const onShift = period ? asgWeekShifts.find((x) => x.shift_date === dateStr && x.staff_id && (slots.length === 1 || x.period === period)) : null;
  const credited_to = task.assigned_staff_id || (onShift ? onShift.staff_id : period ? null : window.currentStaff.id);
  const { error } = await window.supabase.from('assignment_completions')
    .insert({ task_id: taskId, due_key: asgDueKey(task, dateStr), completed_on: dateStr, completed_by: window.currentStaff.id, credited_to });
  if (error) toast(error.code === '23505' ? 'Already marked done' : error.message, true);
  else if (period && !credited_to) toast('Marked done — no one was scheduled on that shift, so no one is credited');
  await loadAssignmentsWeek();
}

async function undoAssignmentDone(completionId) {
  const { error } = await window.supabase.from('assignment_completions').delete().eq('id', completionId);
  if (error) { toast(error.message, true); return; }
  await loadAssignmentsWeek();
}

// ── METRICS (tasks assigned / completed per employee) ──
function setAssignmentsMetricsMode(mode) { asgMetricsMode = mode; loadAssignmentsMetrics().then(renderAssignmentsDashboard); }

async function loadAssignmentsMetrics() {
  const now = new Date();
  const today = toDateStr(now);
  const start = asgMetricsMode === 'week' ? toDateStr(asgSundayOf(now)) : asgMetricsMode === 'month' ? today.slice(0, 8) + '01' : asgQuarterStart(today);
  const [shifts, completions] = await Promise.all([
    window.supabase.from('shifts').select('shift_date,period,staff_id').eq('role', 'bartender').not('staff_id', 'is', null).gte('shift_date', start).lte('shift_date', today),
    window.supabase.from('assignment_completions').select('*').gte('completed_on', start).lte('completed_on', today),
  ]);
  asgMetrics = shifts.error || completions.error ? null : { shifts: shifts.data, completions: completions.data, start, end: today };
}

// Assigned  = shift-bound tasks that fell on a shift the person was
//             scheduled for, plus special assignments due to them.
// Completed = completions credited to them.
// Missed    = assigned occurrences on past days nobody completed.
// Quarterly tasks aren't "assigned" to anyone (they're offered on many
// shifts) — they only show up as a completion for whoever did one.
function assignmentsMetricsHtml() {
  const pill = (mode, label) => '<div class="badge-pill' + (asgMetricsMode === mode ? ' selected' : '') + '" onclick="setAssignmentsMetricsMode(\'' + mode + '\')">' + label + '</div>';
  const head = '<div class="menu-col-header" style="margin-top:28px;"><div class="section-label" style="margin:0;">Tasks by employee</div>'
    + '<div class="badge-picker">' + pill('week', 'This week') + pill('month', 'This month') + pill('quarter', 'This quarter') + '</div></div>';
  if (!asgMetrics) return head + '<div class="loading">Could not load the task counts.</div>';

  const { shifts, completions, start, end } = asgMetrics;
  const groups = { inventory: ['inventory'], cleaning: ['cleaning', 'maintenance'], opening: ['opening'], turnover: ['turnover'], closing: ['closing'] };
  const groupOf = (cat) => Object.keys(groups).find((g) => groups[g].includes(cat));
  const rows = {};
  const row = (id) => rows[id] = rows[id] || { id, assigned: 0, completed: 0, missed: 0, by: Object.keys(groups).reduce((o, g) => { o[g] = { a: 0, c: 0 }; return o; }, {}) };
  const taskById = {};
  asgTasks.forEach((t) => { taskById[t.id] = t; });

  const seen = new Set(); // one person can't be assigned the same shift twice
  shifts.forEach((sh) => {
    const slots = asgSlots(new Date(sh.shift_date + 'T00:00:00').getDay());
    const slot = slots.length === 1 ? slots[0] : slots.find((s) => s.period === sh.period);
    const key = sh.staff_id + sh.shift_date + (slot ? slot.period : '');
    if (!slot || seen.has(key)) return;
    seen.add(key);
    asgTasksOnShift(sh.shift_date, slot).forEach((t) => {
      const r = row(sh.staff_id);
      r.assigned++;
      r.by[groupOf(t.category)].a++;
      if (sh.shift_date < end && !asgFindCompletion(completions, t, sh.shift_date)) r.missed++;
    });
  });
  asgTasks.filter((t) => t.is_active && t.assigned_staff_id && t.due_date >= start && t.due_date <= end).forEach((t) => {
    const r = row(t.assigned_staff_id);
    r.assigned++;
    r.by[groupOf(t.category)].a++;
    if (t.due_date < end && !asgCompletion(t, end)) r.missed++;
  });
  completions.forEach((c) => {
    const t = taskById[c.task_id];
    const who = c.credited_to || c.completed_by;
    if (!t || !who) return;
    const r = row(who);
    r.completed++;
    r.by[groupOf(t.category)].c++;
  });

  const list = Object.values(rows).sort((a, b) => b.assigned - a.assigned || b.completed - a.completed);
  if (!list.length) return head + '<div class="loading">No tasks were assigned or completed in this period.</div>';
  const cell = (g) => '<td class="merch-num">' + (g.a || g.c ? g.c + ' / ' + g.a : '<span style="color:var(--muted);">—</span>') + '</td>';
  return head + '<div class="table-wrap"><table><thead><tr><th>Employee</th><th class="merch-num">Assigned</th><th class="merch-num">Completed</th><th class="merch-num">Missed</th>'
    + '<th class="merch-num">Inventory</th><th class="merch-num">Cleaning &amp; Maint.</th><th class="merch-num">Opening</th><th class="merch-num">Turnover</th><th class="merch-num">Closing</th></tr></thead><tbody>'
    + list.map((r) => '<tr><td style="font-weight:500;">' + escHtml(staffName(r.id)) + '</td><td class="merch-num">' + r.assigned + '</td><td class="merch-num">' + r.completed + '</td><td class="merch-num">' + r.missed + '</td>'
      + Object.keys(groups).map((g) => cell(r.by[g])).join('') + '</tr>').join('')
    + '</tbody></table></div>'
    + '<div class="card-sub" style="margin-top:10px;">' + asgShortDate(start) + ' – ' + asgShortDate(end) + '. Assigned counts the tasks that fell on shifts the person was scheduled for, plus their special assignments. Completed counts tasks credited to them. The type columns read completed / assigned. Quarterly tasks only count once someone completes one.</div>';
}
