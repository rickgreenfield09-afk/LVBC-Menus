// assignments.js
// Screen: #screen-assignments — responsibilities that belong to a
// SHIFT rather than a person: inventory counts, cleaning, opening and
// closing (migration_037). Whoever is scheduled on that shift sees
// them on their phone (mobile/js/tasks.js). This screen is for the
// people who build the schedule (canSchedule()); RLS enforces the same.
//
//   This Week  every open day's AM / PM shift, who is on it, and each
//              task's status: done (and by whom), open, or missed.
//   Plan       the recurring plan — daily and weekly tasks laid out by
//              day and shift, plus the quarterly and ad hoc lists.
//
// Which tasks land on which shift:
//   daily      every open day, on its period's shift
//   weekly     its weekday, on its period's shift
//   quarterly  once per calendar quarter; on the phone it's offered on
//              every matching shift until someone does it
//   ad hoc     its due date; if missed it stays open until done
// A day with a single shift (Sunday) gives that shift both periods'
// tasks; closed days get none — both read off shift_day_settings.
//
// An inventory task lists what to count: percent items, and merch
// styles each at a named location. The phone completes it
// automatically once every one has been counted that day.
// Depends on: window.supabase, window.currentStaff, toast(),
// escHtml() (menu.js), canSchedule/toDateStr/staffName/
// scheduleDaySettings/loadStaffAndSettings (schedule.js),
// invLoadLocations/invLocationPath/invLocationOptions (locations.js)

const ASG_CATEGORIES = { inventory: 'Inventory', cleaning: 'Cleaning', opening: 'Opening', closing: 'Closing' };
const ASG_CATEGORY_BADGE = { inventory: 'badge-teal', cleaning: 'badge-purple', opening: 'badge-amber', closing: 'badge-muted' };
const ASG_FREQUENCIES = { daily: 'Daily', weekly: 'Weekly', quarterly: 'Quarterly', adhoc: 'Ad hoc' };
const ASG_PERIODS = { morning: 'AM', evening: 'PM' };
const ASG_DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

let asgTasks = [];
let asgTargets = [];
let asgCompletions = [];
let asgWeekShifts = [];
let asgItems = [];        // percent items, for target pickers and labels
let asgMerchStyles = [];  // active styles with their product name
let asgView = 'week';
let asgCategoryFilter = 'all';
let asgWeekStart = asgSundayOf(new Date());
let asgEditId = null;
let asgFormTargets = [];  // targets in the open form, saved with the task

function asgSundayOf(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate() - d.getDay()); }
function asgQuarterKey(dateStr) { return dateStr.slice(0, 4) + '-Q' + (Math.floor((+dateStr.slice(5, 7) - 1) / 3) + 1); }
function asgDueKey(task, dateStr) {
  return task.frequency === 'quarterly' ? asgQuarterKey(dateStr) : task.frequency === 'adhoc' ? 'adhoc' : dateStr;
}
function asgCompletion(task, dateStr) {
  const key = asgDueKey(task, dateStr);
  return asgCompletions.find((c) => c.task_id === task.id && c.due_key === key);
}

// The shifts a weekday has, and which periods' tasks each one carries.
function asgSlots(dow) {
  const s = scheduleDaySettings.find((x) => x.day_of_week === dow);
  if (!s || s.is_closed) return [];
  const periods = ['morning', 'evening'].filter((p) => s[p + '_start']);
  return periods.length === 1 ? [{ period: periods[0], covers: ['morning', 'evening'] }] : periods.map((p) => ({ period: p, covers: [p] }));
}

async function loadAssignments() {
  if (!scheduleDaySettings.length) await loadStaffAndSettings();
  const [tasks, targets, items, styles] = await Promise.all([
    window.supabase.from('assignment_tasks').select('*').order('title'),
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
  ['week', 'plan'].forEach((v) => document.getElementById('asg-view-' + v).classList.toggle('active', v === view));
  loadAssignmentsWeek();
}

function asgTargetLabel(t) {
  if (t.item_id) { const i = asgItems.find((x) => x.id === t.item_id); return i ? i.name : 'Removed item'; }
  const s = asgMerchStyles.find((x) => x.id === t.merch_style_id);
  return (s ? s.label : 'Retired merch') + ' @ ' + invLocationPath(t.location_id);
}

function asgTaskChipHtml(task, extraHtml) {
  const n = asgTargets.filter((t) => t.task_id === task.id).length;
  return '<div class="asg-task' + (task.is_active ? '' : ' paused') + '" onclick="openAssignmentForm(\'' + task.id + '\')">'
    + '<span class="badge ' + ASG_CATEGORY_BADGE[task.category] + '">' + ASG_CATEGORIES[task.category] + '</span> '
    + '<span class="asg-task-title">' + escHtml(task.title) + '</span>'
    + (n ? ' <span class="asg-task-meta">' + n + ' to count</span>' : '')
    + (task.is_active ? '' : ' <span class="badge badge-muted">Paused</span>') + (extraHtml || '') + '</div>';
}

// ── PLAN ─────────────────────────────────────────
function setAssignmentsCategory(cat) { asgCategoryFilter = cat; renderAssignmentsPlan(); }

function renderAssignmentsPlan() {
  const shown = asgTasks.filter((t) => asgCategoryFilter === 'all' || t.category === asgCategoryFilter);
  const pill = (value, label) => '<div class="badge-pill' + (asgCategoryFilter === value ? ' selected' : '') + '" onclick="setAssignmentsCategory(\'' + value + '\')">' + label + '</div>';
  const cell = (tasks) => (tasks.length ? tasks.map((t) => asgTaskChipHtml(t)).join('') : '<span class="asg-empty">—</span>');

  let html = '<div class="menu-col-header"><div class="badge-picker">' + pill('all', 'All') + Object.keys(ASG_CATEGORIES).map((c) => pill(c, ASG_CATEGORIES[c])).join('') + '</div>'
    + '<button class="btn btn-sm btn-primary" onclick="openAssignmentForm(null)">+ Add Task</button></div>'
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
    + (tasks.length ? tasks.map((t) => asgTaskChipHtml(t, ' <span class="asg-task-meta">' + meta(t) + '</span>')).join('') : '<div class="loading">None yet</div>') + '</div></div>';
  const today = toDateStr(new Date());
  html += '<div class="grid-2">'
    + list('Quarterly', shown.filter((t) => t.frequency === 'quarterly'),
      (t) => ASG_PERIODS[t.period] + (t.day_of_week != null ? ' · ' + ASG_DAYS[t.day_of_week] + 's' : ' · any day') + (asgCompletion(t, today) ? ' · done this quarter' : ' · open this quarter'))
    + list('Ad hoc', shown.filter((t) => t.frequency === 'adhoc').sort((a, b) => b.due_date.localeCompare(a.due_date)),
      (t) => ASG_PERIODS[t.period] + ' · due ' + new Date(t.due_date + 'T00:00:00').toLocaleDateString('default', { month: 'short', day: 'numeric' }) + (asgCompletion(t, today) ? ' · done' : t.due_date < today ? ' · overdue' : ''))
    + '</div>';
  document.getElementById('asg-body').innerHTML = html;
  if (asgFormOpen) renderAssignmentForm();
}

// ── TASK FORM ────────────────────────────────────
let asgFormOpen = false;
let asgFormDraft = null;

function openAssignmentForm(taskId) {
  if (asgView !== 'plan') { asgView = 'plan'; ['week', 'plan'].forEach((v) => document.getElementById('asg-view-' + v).classList.toggle('active', v === 'plan')); }
  const t = taskId ? asgTasks.find((x) => x.id === taskId) : null;
  asgEditId = t ? t.id : null;
  asgFormDraft = t ? Object.assign({}, t) : { title: '', category: 'cleaning', frequency: 'daily', period: 'morning', day_of_week: 1, due_date: toDateStr(new Date()), instructions: '', is_active: true };
  asgFormTargets = t ? asgTargets.filter((x) => x.task_id === t.id).map((x) => ({ item_id: x.item_id, merch_style_id: x.merch_style_id, location_id: x.location_id })) : [];
  asgFormOpen = true;
  renderAssignmentsPlan();
  document.getElementById('asg-form').scrollIntoView({ block: 'nearest' });
}

function closeAssignmentForm() { asgFormOpen = false; asgEditId = null; renderAssignmentsPlan(); }

// Field changes re-render the form, since frequency and category decide which fields show.
function setAssignmentDraft(field, value) {
  asgFormDraft[field] = value;
  if (field === 'frequency' || field === 'category') renderAssignmentForm();
}

function renderAssignmentForm() {
  const d = asgFormDraft;
  const opts = (map, sel) => Object.keys(map).map((k) => '<option value="' + k + '"' + (String(sel) === k ? ' selected' : '') + '>' + map[k] + '</option>').join('');
  const dayOpts = (sel, withAny) => (withAny ? '<option value="">Any day</option>' : '')
    + ASG_DAYS.map((name, dow) => (asgSlots(dow).length ? '<option value="' + dow + '"' + (sel === dow ? ' selected' : '') + '>' + name + '</option>' : '')).join('');
  const field = (label, inner) => '<div class="form-group"><label class="form-label">' + label + '</label>' + inner + '</div>';

  let html = '<div class="card asg-form-card"><div class="menu-col-header"><div class="section-label" style="margin:0;">' + (asgEditId ? 'Edit Task' : 'Add Task') + '</div></div>'
    + '<div class="form-row">'
    + field('Task', '<input class="form-input" type="text" id="asg-f-title" value="' + escHtml(d.title) + '" oninput="setAssignmentDraft(\'title\',this.value)" placeholder="e.g. Wipe down tap handles">')
    + field('Category', '<select class="form-select" onchange="setAssignmentDraft(\'category\',this.value)">' + opts(ASG_CATEGORIES, d.category) + '</select>')
    + '</div><div class="form-row" style="grid-template-columns:1fr 1fr 1fr;">'
    + field('How Often', '<select class="form-select" onchange="setAssignmentDraft(\'frequency\',this.value)">' + opts(ASG_FREQUENCIES, d.frequency) + '</select>')
    + field('Shift', '<select class="form-select" onchange="setAssignmentDraft(\'period\',this.value)">' + opts({ morning: 'AM Bartender', evening: 'PM Bartender' }, d.period) + '</select>')
    + (d.frequency === 'weekly' ? field('Day', '<select class="form-select" onchange="setAssignmentDraft(\'day_of_week\',+this.value)">' + dayOpts(d.day_of_week, false) + '</select>') : '')
    + (d.frequency === 'quarterly' ? field('Only On', '<select class="form-select" onchange="setAssignmentDraft(\'day_of_week\',this.value === \'\' ? null : +this.value)">' + dayOpts(d.day_of_week, true) + '</select>') : '')
    + (d.frequency === 'adhoc' ? field('Due', '<input class="form-input" type="date" value="' + escHtml(d.due_date) + '" onchange="setAssignmentDraft(\'due_date\',this.value)">') : '')
    + (d.frequency === 'daily' ? field('Day', '<input class="form-input" type="text" value="Every open day" disabled>') : '')
    + '</div>'
    + '<div class="form-group" style="margin-bottom:16px;"><label class="form-label">Instructions</label><textarea class="form-ta" rows="2" oninput="setAssignmentDraft(\'instructions\',this.value)" placeholder="optional — shown to the person on shift">' + escHtml(d.instructions) + '</textarea></div>';

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
    title: d.title.trim(), category: d.category, frequency: d.frequency, period: d.period,
    instructions: (d.instructions || '').trim() || null, is_active: !!d.is_active,
    day_of_week: d.frequency === 'weekly' ? d.day_of_week : d.frequency === 'quarterly' ? (d.day_of_week == null ? null : d.day_of_week) : null,
    due_date: d.frequency === 'adhoc' ? d.due_date : null,
  };
  if (d.frequency === 'adhoc' && !payload.due_date) { toast('Pick a due date', true); return; }
  const { data: saved, error } = asgEditId
    ? await window.supabase.from('assignment_tasks').update(payload).eq('id', asgEditId).select().single()
    : await window.supabase.from('assignment_tasks').insert(Object.assign({ created_by: window.currentStaff.id }, payload)).select().single();
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

// ── THIS WEEK ────────────────────────────────────
function assignmentsWeekNav(delta) {
  asgWeekStart = delta === 0 ? asgSundayOf(new Date()) : new Date(asgWeekStart.getFullYear(), asgWeekStart.getMonth(), asgWeekStart.getDate() + delta * 7);
  loadAssignmentsWeek();
}

async function loadAssignmentsWeek() {
  const start = toDateStr(asgWeekStart);
  const end = toDateStr(new Date(asgWeekStart.getFullYear(), asgWeekStart.getMonth(), asgWeekStart.getDate() + 6));
  // Completions for this week's dates, plus anything that settles a quarterly or ad hoc task.
  const quarterStart = start.slice(0, 5) + String(Math.floor((+start.slice(5, 7) - 1) / 3) * 3 + 1).padStart(2, '0') + '-01';
  const [completions, shifts] = await Promise.all([
    window.supabase.from('assignment_completions').select('*').or('due_key.eq.adhoc,completed_on.gte.' + (quarterStart < start ? quarterStart : start)),
    window.supabase.from('shifts').select('shift_date,period,staff_id,role').gte('shift_date', start).lte('shift_date', end).eq('role', 'bartender'),
  ]);
  if (completions.error) { document.getElementById('asg-body').innerHTML = '<div class="loading">Could not load this week: ' + escHtml(completions.error.message) + '</div>'; return; }
  asgCompletions = completions.data;
  asgWeekShifts = shifts.data || [];
  // The Plan tab reads the same completions for its "done this quarter" notes.
  if (asgView === 'week') renderAssignmentsWeek(); else renderAssignmentsPlan();
}

// Daily and weekly tasks for a shift, plus an ad hoc task on its due date.
function asgGridTasks(dateStr, dow, covers) {
  return asgTasks.filter((t) => t.is_active && covers.includes(t.period) && (
    t.frequency === 'daily' || (t.frequency === 'weekly' && t.day_of_week === dow) || (t.frequency === 'adhoc' && t.due_date === dateStr)));
}

function renderAssignmentsWeek() {
  const today = toDateStr(new Date());
  const days = [];
  for (let i = 0; i < 7; i++) days.push(new Date(asgWeekStart.getFullYear(), asgWeekStart.getMonth(), asgWeekStart.getDate() + i));
  let due = 0, done = 0, missed = 0;

  const taskRow = (t, dateStr) => {
    const c = asgCompletion(t, dateStr);
    const past = dateStr < today;
    if (dateStr <= today) { due++; if (c) done++; else if (past) missed++; }
    const status = c ? '<span class="asg-status done">&#10003; ' + escHtml(staffName(c.completed_by)) + '</span>'
      : past ? '<span class="asg-status missed">&#10007; Missed</span>'
        : dateStr === today ? '<span class="asg-status open">Open</span>' : '';
    const action = dateStr > today ? '' : c
      ? '<button class="merch-link" onclick="undoAssignmentDone(\'' + c.id + '\')">undo</button>'
      : '<button class="merch-link" onclick="markAssignmentDone(\'' + t.id + '\',\'' + dateStr + '\')">mark done</button>';
    return '<div class="asg-week-task"><span class="badge ' + ASG_CATEGORY_BADGE[t.category] + '">' + ASG_CATEGORIES[t.category] + '</span> <span class="asg-task-title">' + escHtml(t.title) + '</span> ' + status + ' ' + action + '</div>';
  };

  let rows = '';
  days.forEach((d) => {
    const dateStr = toDateStr(d);
    const slots = asgSlots(d.getDay());
    if (!slots.length) return;
    rows += '<tr' + (dateStr === today ? ' class="asg-today"' : '') + '><td class="asg-day">' + d.toLocaleDateString('default', { weekday: 'long' }) + '<div class="asg-task-meta">' + d.toLocaleDateString('default', { month: 'short', day: 'numeric' }) + '</div></td>';
    slots.forEach((s) => {
      const who = asgWeekShifts.filter((x) => x.shift_date === dateStr && (slots.length === 1 || x.period === s.period)).map((x) => (x.staff_id ? staffName(x.staff_id) : 'Open shift'));
      const tasks = asgGridTasks(dateStr, d.getDay(), s.covers);
      rows += '<td' + (slots.length === 1 ? ' colspan="2"' : '') + '><div class="asg-who">' + (who.length ? escHtml([...new Set(who)].join(', ')) : 'No one scheduled') + '</div>'
        + (tasks.length ? tasks.map((t) => taskRow(t, dateStr)).join('') : '<span class="asg-empty">No tasks</span>') + '</td>';
    });
    rows += '</tr>';
  });

  const lastDay = days[6];
  const label = asgWeekStart.toLocaleDateString('default', { month: 'short', day: 'numeric' }) + ' – ' + lastDay.toLocaleDateString('default', { month: 'short', day: 'numeric', year: 'numeric' });
  const tile = (title, value, sub) => '<div class="card"><div class="card-title">' + title + '</div><div class="card-value">' + value + '</div><div class="card-sub">' + sub + '</div></div>';
  // Quarterly and overdue ad hoc aren't tied to one shift, so they sit below the grid.
  const quarterly = asgTasks.filter((t) => t.is_active && t.frequency === 'quarterly');
  const overdue = asgTasks.filter((t) => t.is_active && t.frequency === 'adhoc' && t.due_date < today && !asgCompletion(t, today));
  const loose = (t, note) => { const c = asgCompletion(t, today); return '<div class="asg-week-task"><span class="badge ' + ASG_CATEGORY_BADGE[t.category] + '">' + ASG_CATEGORIES[t.category] + '</span> <span class="asg-task-title">' + escHtml(t.title) + '</span> <span class="asg-task-meta">' + note + '</span> '
    + (c ? '<span class="asg-status done">&#10003; ' + escHtml(staffName(c.completed_by)) + '</span> <button class="merch-link" onclick="undoAssignmentDone(\'' + c.id + '\')">undo</button>'
      : '<span class="asg-status open">Open</span> <button class="merch-link" onclick="markAssignmentDone(\'' + t.id + '\',\'' + today + '\')">mark done</button>') + '</div>'; };

  document.getElementById('asg-body').innerHTML = '<div class="menu-col-header"><div style="display:flex;align-items:center;gap:8px;">'
    + '<button class="btn btn-sm btn-secondary" aria-label="Previous week" onclick="assignmentsWeekNav(-1)">&#8249;</button>'
    + '<div class="section-label" style="margin:0;min-width:190px;text-align:center;">' + label + '</div>'
    + '<button class="btn btn-sm btn-secondary" aria-label="Next week" onclick="assignmentsWeekNav(1)">&#8250;</button>'
    + '<button class="btn btn-sm btn-secondary" onclick="assignmentsWeekNav(0)">This Week</button></div></div>'
    + '<div class="grid-4" style="grid-template-columns:repeat(3,1fr);">' + tile('Done', done + ' / ' + due, 'of tasks due so far this week') + tile('Missed', missed, 'past shifts, not checked off')
    + tile('Open Quarterly', quarterly.filter((t) => !asgCompletion(t, today)).length, 'not yet done this quarter') + '</div>'
    + (rows ? '<div class="table-wrap asg-grid"><table><thead><tr><th style="width:140px;"></th><th>AM Bartender</th><th>PM Bartender</th></tr></thead><tbody>' + rows + '</tbody></table></div>' : '<div class="loading">No open days this week.</div>')
    + (quarterly.length || overdue.length ? '<div class="section-label">Not tied to one day</div><div class="card">'
      + overdue.map((t) => loose(t, 'ad hoc · was due ' + new Date(t.due_date + 'T00:00:00').toLocaleDateString('default', { month: 'short', day: 'numeric' }))).join('')
      + quarterly.map((t) => loose(t, 'quarterly · ' + ASG_PERIODS[t.period] + (t.day_of_week != null ? ' · ' + ASG_DAYS[t.day_of_week] + 's' : ''))).join('') + '</div>' : '')
    + (asgTasks.length ? '' : '<div class="card-sub" style="margin-top:16px;">No tasks yet — build the plan on the Plan tab.</div>');
}

async function markAssignmentDone(taskId, dateStr) {
  const task = asgTasks.find((t) => t.id === taskId);
  const { error } = await window.supabase.from('assignment_completions')
    .insert({ task_id: taskId, due_key: asgDueKey(task, dateStr), completed_on: dateStr, completed_by: window.currentStaff.id });
  if (error) { toast(error.code === '23505' ? 'Already marked done' : error.message, true); }
  await loadAssignmentsWeek();
}

async function undoAssignmentDone(completionId) {
  const { error } = await window.supabase.from('assignment_completions').delete().eq('id', completionId);
  if (error) { toast(error.message, true); return; }
  await loadAssignmentsWeek();
}
