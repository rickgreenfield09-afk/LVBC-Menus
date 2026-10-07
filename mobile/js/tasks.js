// tasks.js (mobile)
// Screen: #screen-tasks — what you're responsible for today: the
// tasks on the shift you're scheduled for, any special assignments
// given to you by name, and the checklists of off-site events you're
// working (mobile/js/offsite.js). The plan is built on the desktop
// Assignments screen (js/assignments.js, migration_037 + 038); here
// you only do the work and check it off.
//
// Shift tasks belong to a shift, not a person, so this shows the tasks
// for whichever of today's shifts you hold. If you aren't on today, it
// previews your next shift read-only; schedulers and admins who aren't
// on see all of today's shifts.
//
// Whose a task is:
//   opening    the AM bartender
//   turnover   the AM bartender, before handing off to the PM shift
//   closing    the closing (PM) bartender
//   the rest   the AM or PM bartender, whichever the task names
// A day with a single shift (Sunday) gives that shift both periods'
// tasks and has no turnover.
//
// How often: daily (every open day), weekly (its weekday), quarterly
// (offered on every matching shift until someone does it that
// quarter), ad hoc (from its due date until done).
//
// A plain task is checked off by hand. An inventory task lists what to
// count; each Count button opens the same edit sheet as the Inventory
// tab, and the task completes itself once every one has been counted
// today.
//
// Credit goes to the person on the shift. If a manager who isn't on
// the shift ticks a task here, the scheduled bartender is credited.
// Depends on: window.supabase, window.currentStaff, toast(),
// escHtml(), toDateStr() (core.js), mDaySettings, mMyStaffIds,
// resolveMyStaffIds(), shiftSlotLabel() (schedule.js), mInvItems,
// mInvCountedToday(), mLocationPath(), mPhotoHtml(), openItemEdit(),
// loadInventoryCount() (inventory.js), mMerchProducts, mMerchStyles,
// mMerchVariantsFor(), mMerchStock, mMerchStyleLabel(), openMerchEdit(),
// loadMerchCount() (merch.js), loadOffsiteMine() (offsite.js)

// In the order a shift meets them.
const M_TASK_CATEGORIES = { opening: 'Opening', inventory: 'Inventory', cleaning: 'Cleaning', maintenance: 'Maintenance', turnover: 'Turnover', closing: 'Closing' };
const M_TASK_BADGE = { inventory: 'badge-teal', cleaning: 'badge-purple', maintenance: 'badge-purple', opening: 'badge-amber', turnover: 'badge-amber', closing: 'badge-amber' };

let mTasks = [];
let mTaskTargets = [];
let mTaskCompletions = [];
let mTaskView = null;            // { dateStr, slots: [{ period, covers, shifts }], preview, note }
let mTaskAutoDone = new Set();   // inventory tasks already auto-completed this session

function mTaskQuarterKey(dateStr) { return dateStr.slice(0, 4) + '-Q' + (Math.floor((+dateStr.slice(5, 7) - 1) / 3) + 1); }
function mTaskDueKey(task, dateStr) {
  return task.frequency === 'quarterly' ? mTaskQuarterKey(dateStr) : task.frequency === 'adhoc' ? 'adhoc' : dateStr;
}
function mTaskCompletion(task, dateStr) {
  const key = mTaskDueKey(task, dateStr);
  return mTaskCompletions.find((c) => c.task_id === task.id && c.due_key === key);
}

// The shifts a weekday has, and which periods' tasks each one carries.
function mTaskSlots(dow) {
  const s = mDaySettings.find((x) => x.day_of_week === dow);
  if (!s || s.is_closed) return [];
  const periods = ['morning', 'evening'].filter((p) => s[p + '_start']);
  return periods.length === 1 ? [{ period: periods[0], covers: ['morning', 'evening'] }] : periods.map((p) => ({ period: p, covers: [p] }));
}

// Shift-bound tasks for one shift. Special assignments (named to a
// person) are listed separately. A quarterly or ad hoc task that was
// finished on an earlier day drops off; one finished today stays,
// ticked, so it can still be undone.
function mTasksFor(dateStr, covers) {
  const dow = new Date(dateStr + 'T00:00:00').getDay();
  return mTasks.filter((t) => {
    if (t.assigned_staff_id || !covers.includes(t.period)) return false;
    if (t.category === 'turnover' && covers.length > 1) return false;
    if (t.frequency === 'daily') return true;
    if (t.frequency === 'weekly') return t.day_of_week === dow;
    if (t.frequency === 'quarterly' && t.day_of_week != null && t.day_of_week !== dow) return false;
    if (t.frequency === 'adhoc' && t.due_date > dateStr) return false;
    const c = mTaskCompletion(t, dateStr);
    return !c || c.completed_on === dateStr;
  });
}

async function loadTasks() {
  const el = document.getElementById('m-tasks');
  el.innerHTML = '<div class="loading">Loading...</div>';
  if (!mDaySettings.length) {
    const { data } = await window.supabase.from('shift_day_settings').select('*').order('day_of_week');
    mDaySettings = data || [];
  }
  mMyStaffIds = await resolveMyStaffIds();
  const today = toDateStr(new Date());
  const quarterStart = today.slice(0, 5) + String(Math.floor((+today.slice(5, 7) - 1) / 3) * 3 + 1).padStart(2, '0') + '-01';
  const [tasks, targets, completions, shifts, next] = await Promise.all([
    window.supabase.from('assignment_tasks').select('*').eq('is_active', true).order('title'),
    window.supabase.from('assignment_task_targets').select('*'),
    window.supabase.from('assignment_completions').select('*').or('due_key.eq.adhoc,completed_on.gte.' + quarterStart),
    window.supabase.from('shifts').select('shift_date,period,staff_id,role,staff:staff_id(name)').eq('shift_date', today).eq('role', 'bartender'),
    window.supabase.from('shifts').select('shift_date,period').in('staff_id', mMyStaffIds).eq('role', 'bartender').gt('shift_date', today).order('shift_date').limit(1),
    // The count buttons need the inventory records behind them.
    loadInventoryCount(), loadMerchCount(),
  ]);
  loadOffsiteMine();
  const failed = [tasks, targets, completions, shifts].find((r) => r.error);
  if (failed) { el.innerHTML = '<div class="loading">Could not load tasks: ' + escHtml(failed.error.message) + '</div>'; return; }
  mTasks = tasks.data;
  mTaskTargets = targets.data;
  mTaskCompletions = completions.data;

  const dow = new Date(today + 'T00:00:00').getDay();
  const todaySlots = mTaskSlots(dow).map((s, _, all) => Object.assign({}, s, {
    shifts: shifts.data.filter((x) => all.length === 1 || x.period === s.period),
  }));
  const mine = todaySlots.filter((s) => s.shifts.some((x) => mMyStaffIds.includes(x.staff_id)));
  const manager = window.currentStaff.role === 'admin' || window.currentStaff.can_schedule;
  if (mine.length) mTaskView = { dateStr: today, slots: mine };
  else if (manager && todaySlots.length) mTaskView = { dateStr: today, slots: todaySlots, note: 'You\'re not on the schedule today — showing every shift.' };
  else if (next.data && next.data.length) {
    const n = next.data[0];
    const slots = mTaskSlots(new Date(n.shift_date + 'T00:00:00').getDay());
    mTaskView = { dateStr: n.shift_date, slots: slots.filter((s) => slots.length === 1 || s.period === n.period).map((s) => Object.assign({ shifts: [] }, s)), preview: true,
      note: 'You\'re not on the schedule today. This is what your next shift is responsible for.' };
  } else mTaskView = { dateStr: today, slots: [], note: 'You have no upcoming shifts on the schedule.' };
  renderTasks();
}

// Re-draws after a count is saved from the edit sheet, if this screen is the one showing.
function mTasksRefresh() {
  if (mTaskView && document.getElementById('screen-tasks').classList.contains('active')) renderTasks();
}

// ── WHAT AN INVENTORY TASK COUNTS ────────────────
function mTaskTargetInfo(t) {
  if (t.item_id) {
    const i = mInvItems.find((x) => x.id === t.item_id);
    if (!i) return null;
    return { photo: i.photo_url, name: i.name, sub: mLocationPath(i.location_id) || i.location || '', level: i.percent_remaining + '%', done: mInvCountedToday(i), open: 'openItemEdit(\'' + i.id + '\')' };
  }
  const s = mMerchStyles.find((x) => x.id === t.merch_style_id);
  const p = s && mMerchProducts.find((x) => x.id === s.product_id);
  if (!s || !p) return null;
  const variants = mMerchVariantsFor(s.id);
  const rows = variants.map((v) => mMerchStock.find((r) => r.variant_id === v.id && r.location_id === t.location_id));
  return { photo: s.photo_url, name: p.name, sub: [mMerchStyleLabel(s), mLocationPath(t.location_id)].filter(Boolean).join(' · '),
    level: rows.reduce((a, r) => a + (r ? r.unit_count : 0), 0) + ' units here',
    done: variants.length > 0 && rows.every((r) => r && mInvCountedToday(r)), open: 'openMerchEdit(\'' + s.id + '\',\'' + t.location_id + '\')' };
}

// ── RENDER ───────────────────────────────────────
// creditId is who the task counts for: you if you're on that shift,
// otherwise whoever is.
function mTaskCardHtml(t, dateStr, creditId, preview, tag) {
  const targets = mTaskTargets.filter((x) => x.task_id === t.id).map(mTaskTargetInfo).filter(Boolean);
  const c = mTaskCompletion(t, dateStr);
  const counted = targets.filter((x) => x.done).length;
  // An inventory task with a count list finishes itself; everything else is a manual check.
  const auto = targets.length > 0;
  if (auto && !c && !preview && counted === targets.length && !mTaskAutoDone.has(t.id + dateStr)) { mTaskAutoDone.add(t.id + dateStr); completeTask(t.id, creditId, true); }
  return '<div class="m-item m-task' + (c ? ' counted' : '') + '"><div class="m-task-head">'
    + (preview ? '' : auto
      ? '<div class="m-task-check' + (c ? ' on' : '') + '" aria-label="' + (c ? 'Done' : counted + ' of ' + targets.length + ' counted') + '">' + (c ? '&#10003;' : counted + '/' + targets.length) + '</div>'
      : '<button class="m-task-check' + (c ? ' on' : '') + '" aria-label="' + (c ? 'Mark not done' : 'Mark done') + '" onclick="' + (c ? 'undoTask(\'' + c.id + '\')' : 'completeTask(\'' + t.id + '\',\'' + (creditId || '') + '\')') + '">' + (c ? '&#10003;' : '') + '</button>')
    + '<div class="m-rec-body"><div class="m-item-name">' + escHtml(t.title) + '</div>'
    + '<div class="m-item-sub"><span class="badge ' + M_TASK_BADGE[t.category] + '">' + M_TASK_CATEGORIES[t.category] + '</span>' + (tag ? ' <span class="badge badge-muted">' + escHtml(tag) + '</span>' : '') + '</div>'
    + (t.instructions ? '<div class="m-task-notes">' + escHtml(t.instructions) + '</div>' : '') + '</div></div>'
    + targets.map((x) => '<div class="m-task-target">' + mPhotoHtml(x.photo, x.name)
      + '<div class="m-rec-body"><div class="m-task-target-name">' + escHtml(x.name) + '</div>' + (x.sub ? '<div class="m-item-sub">' + escHtml(x.sub) + '</div>' : '')
      + '<div class="m-item-sub">' + (x.done ? '<span class="m-rec-done">&#10003; counted today</span> · ' : '') + escHtml(x.level) + '</div></div>'
      + (preview ? '' : '<button class="btn btn-sm ' + (x.done ? 'btn-secondary' : 'btn-primary') + '" onclick="' + x.open + '">' + (x.done ? 'Recount' : 'Count') + '</button>') + '</div>').join('')
    + '</div>';
}

function renderTasks() {
  const el = document.getElementById('m-tasks');
  const { dateStr, slots, preview, note } = mTaskView;
  const today = toDateStr(new Date());
  const d = new Date(dateStr + 'T00:00:00');
  const setting = mDaySettings.find((x) => x.day_of_week === d.getDay()) || {};
  let html = note ? '<div class="m-sheet-note" style="margin:0 0 16px;">' + escHtml(note) + '</div>' : '';
  let total = 0, doneCount = 0;
  const tally = (t, on) => { total++; if (mTaskCompletion(t, on)) doneCount++; };

  // Special assignments are yours whatever shift you're on, so they come first.
  const special = mTasks.filter((t) => mMyStaffIds.includes(t.assigned_staff_id)).filter((t) => { const c = mTaskCompletion(t, today); return !c || c.completed_on === today; })
    .sort((a, b) => a.due_date.localeCompare(b.due_date));
  if (special.length) {
    html += '<div class="section-label" style="margin-top:0;">Assigned to you</div>';
    special.forEach((t) => {
      tally(t, today);
      html += mTaskCardHtml(t, today, t.assigned_staff_id, false,
        t.due_date < today ? 'Overdue' : t.due_date === today ? 'Due today' : 'Due ' + new Date(t.due_date + 'T00:00:00').toLocaleDateString('default', { month: 'short', day: 'numeric' }));
    });
    html += '<div style="height:12px;"></div>';
  }

  slots.forEach((slot) => {
    const tasks = mTasksFor(dateStr, slot.covers);
    const who = [...new Set(slot.shifts.map((x) => (x.staff ? x.staff.name : 'Open shift')))];
    const mineHere = slot.shifts.find((x) => mMyStaffIds.includes(x.staff_id));
    const onShift = mineHere || slot.shifts.find((x) => x.staff_id);
    const creditId = onShift ? onShift.staff_id : null;
    html += '<div class="section-label" style="margin-top:0;">' + (dateStr === today ? 'Today' : d.toLocaleDateString('default', { weekday: 'long', month: 'short', day: 'numeric' }))
      + ' · ' + escHtml(shiftSlotLabel(setting, slot.period)) + ' shift' + (who.length ? ' · ' + escHtml(who.join(', ')) : '') + '</div>';
    if (!tasks.length) { html += '<div class="card" style="margin-bottom:20px;"><div class="loading">Nothing assigned to this shift.</div></div>'; return; }
    Object.keys(M_TASK_CATEGORIES).forEach((cat) => {
      tasks.filter((t) => t.category === cat).forEach((t) => {
        if (!preview) tally(t, dateStr);
        html += mTaskCardHtml(t, dateStr, creditId, preview, t.frequency === 'quarterly' ? 'Quarterly' : t.frequency === 'adhoc' ? (t.due_date < dateStr ? 'Overdue' : 'One-off') : '');
      });
    });
    html += '<div style="height:12px;"></div>';
  });

  document.getElementById('m-tasks-progress').textContent = total ? doneCount + ' / ' + total + ' done' : '';
  el.innerHTML = html || '<div class="loading">Nothing to show.</div>';
}

// ── CHECK OFF ────────────────────────────────────
async function completeTask(taskId, creditId, silent) {
  const task = mTasks.find((t) => t.id === taskId);
  const dateStr = task.assigned_staff_id ? toDateStr(new Date()) : mTaskView.dateStr;
  const { data, error } = await window.supabase.from('assignment_completions')
    .insert({ task_id: taskId, due_key: mTaskDueKey(task, dateStr), completed_on: dateStr, completed_by: window.currentStaff.id, credited_to: creditId || window.currentStaff.id }).select().single();
  if (error) {
    mTaskAutoDone.delete(taskId + dateStr);
    // 23505 = someone else on the shift already checked it off
    if (error.code === '23505') { loadTasks(); return; }
    if (!silent) toast(navigator.onLine ? error.message : 'You\'re offline — check this off once you have signal', true);
    return;
  }
  mTaskCompletions.push(data);
  if (silent) toast('"' + task.title + '" complete');
  renderTasks();
}

async function undoTask(completionId) {
  const { data, error } = await window.supabase.from('assignment_completions').delete().eq('id', completionId).select();
  if (error) { toast(error.message, true); return; }
  // RLS only lets you undo your own check (or any, if you build the schedule) — a refusal comes back as zero rows, not an error.
  if (!data.length) { toast('Only the person who checked this off, or a manager, can undo it', true); return; }
  mTaskCompletions = mTaskCompletions.filter((c) => c.id !== completionId);
  renderTasks();
}
