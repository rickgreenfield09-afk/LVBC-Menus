// offsite.js (mobile)
// The "Off-site events" section at the bottom of #screen-tasks — the
// bring-along checklists for events away from the brewery that you've
// been assigned to (js/offsite.js on desktop, migration_038).
//
// Each line has two ticks: packed (going out) and back (returned to
// the brewery). Anyone assigned to the event can tick lines, change
// quantities, and add or remove lines — you're the one standing at the
// van. Creating events, assigning staff and templates stay on the
// desktop panel.
//
// Ticks save straight away and need a signal; unlike inventory counts
// they aren't queued offline.
// Depends on: window.supabase, window.currentStaff, toast(),
// escHtml(), toDateStr() (core.js), mMyStaffIds (schedule.js),
// mOpenSheet(), mCloseSheet() (inventory.js)

const M_OFFSITE_KEEP_DAYS = 14; // an event stays listed this long after it ends, for unpacking

let mOffEvents = [];
let mOffItems = [];
let mOffOpenId = null;

async function loadOffsiteMine() {
  const el = document.getElementById('m-offsite');
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - M_OFFSITE_KEEP_DAYS);
  const { data, error } = await window.supabase.from('offsite_event_staff')
    .select('offsite_events(id,name,venue,start_date,end_date,notes)').in('staff_id', mMyStaffIds);
  if (error) { el.innerHTML = ''; return; }
  mOffEvents = data.map((r) => r.offsite_events).filter((e) => e && e.end_date >= toDateStr(cutoff)).sort((a, b) => a.start_date.localeCompare(b.start_date));
  if (!mOffEvents.length) { mOffItems = []; el.innerHTML = ''; return; }
  const { data: items } = await window.supabase.from('offsite_checklist_items').select('*').in('event_id', mOffEvents.map((e) => e.id)).order('sort_order').order('created_at');
  mOffItems = items || [];
  renderOffsiteMine();
}

function mOffLines(eventId) { return mOffItems.filter((l) => l.event_id === eventId); }
function mOffDates(e) {
  const f = (s) => new Date(s + 'T00:00:00').toLocaleDateString('default', { weekday: 'short', month: 'short', day: 'numeric' });
  return f(e.start_date) + (e.end_date !== e.start_date ? ' – ' + f(e.end_date) : '');
}

function renderOffsiteMine() {
  document.getElementById('m-offsite').innerHTML = '<div class="section-label">Off-site events</div>' + mOffEvents.map((e) => {
    const lines = mOffLines(e.id);
    return '<div class="m-item m-rec"><div class="m-rec-body"><div class="m-item-name">' + escHtml(e.name) + '</div>'
      + '<div class="m-item-sub">' + mOffDates(e) + (e.venue ? ' · ' + escHtml(e.venue) : '') + '</div>'
      + '<div class="m-item-sub">' + (lines.length ? lines.filter((l) => l.packed_at).length + ' / ' + lines.length + ' packed · ' + lines.filter((l) => l.returned_at).length + ' / ' + lines.length + ' back' : 'No checklist yet') + '</div></div>'
      + '<button class="btn btn-sm btn-secondary" onclick="openOffsiteChecklist(\'' + e.id + '\')">Checklist</button></div>';
  }).join('');
}

function openOffsiteChecklist(eventId) { mOffOpenId = eventId; renderOffsiteChecklist(); }
function closeOffsiteChecklist() { mOffOpenId = null; mCloseSheet(); renderOffsiteMine(); }

function renderOffsiteChecklist() {
  const e = mOffEvents.find((x) => x.id === mOffOpenId);
  const lines = mOffLines(e.id);
  const box = (l, field, label) => '<button class="m-off-tick' + (l[field + '_at'] ? ' on' : '') + '" aria-pressed="' + !!l[field + '_at'] + '" onclick="tickOffsiteLine(\'' + l.id + '\',\'' + field + '\')">'
    + '<span>' + (l[field + '_at'] ? '&#10003;' : '') + '</span>' + label + '</button>';
  mOpenSheet('<div class="m-sheet-body">'
    + '<div class="m-sheet-title">' + escHtml(e.name) + '</div>'
    + '<div class="m-item-sub">' + mOffDates(e) + (e.venue ? ' · ' + escHtml(e.venue) : '') + '</div>'
    + (e.notes ? '<div class="m-task-notes">' + escHtml(e.notes) + '</div>' : '')
    + '<label class="admin-label m-sheet-label">Checklist · ' + lines.filter((l) => l.packed_at).length + ' / ' + lines.length + ' packed · ' + lines.filter((l) => l.returned_at).length + ' / ' + lines.length + ' back</label>'
    + (lines.length ? lines.map((l) => '<div class="m-off-line"><div class="m-off-line-top"><div class="m-task-target-name">' + escHtml(l.label) + '</div>'
      + '<input class="m-off-qty" type="number" inputmode="numeric" pattern="[0-9]*" min="1" step="1" value="' + l.quantity + '" aria-label="Quantity of ' + escHtml(l.label) + '" onchange="setOffsiteQty(\'' + l.id + '\',this.value)">'
      + '<button class="m-off-remove" aria-label="Remove ' + escHtml(l.label) + '" onclick="removeOffsiteLine(\'' + l.id + '\')">&#10005;</button></div>'
      + '<div class="m-off-ticks">' + box(l, 'packed', 'Packed') + box(l, 'returned', 'Back') + '</div></div>').join('') : '<div class="loading">Nothing on this list yet.</div>')
    + '<form class="m-off-add" onsubmit="addOffsiteLine(event)"><input class="admin-input" type="text" id="m-off-new" placeholder="Add something to bring" required><button class="btn btn-secondary" type="submit">Add</button></form>'
    + '</div><div class="m-sheet-actions" style="grid-template-columns:1fr;"><button class="btn btn-primary" onclick="closeOffsiteChecklist()">Done</button></div>');
}

async function mOffUpdate(id, patch) {
  const { data, error } = await window.supabase.from('offsite_checklist_items').update(patch).eq('id', id).select();
  if (error || !data.length) { toast(navigator.onLine ? (error ? error.message : 'You\'re no longer assigned to this event') : 'You\'re offline — try again once you have signal', true); return false; }
  Object.assign(mOffItems.find((l) => l.id === id), patch);
  return true;
}

async function tickOffsiteLine(id, field) {
  const on = !mOffItems.find((l) => l.id === id)[field + '_at'];
  const patch = {};
  patch[field + '_at'] = on ? new Date().toISOString() : null;
  patch[field + '_by'] = on ? window.currentStaff.id : null;
  await mOffUpdate(id, patch);
  renderOffsiteChecklist();
}

async function setOffsiteQty(id, value) {
  await mOffUpdate(id, { quantity: Math.max(1, parseInt(value, 10) || 1) });
  renderOffsiteChecklist();
}

async function addOffsiteLine(e) {
  e.preventDefault();
  const label = document.getElementById('m-off-new').value.trim();
  if (!label) return;
  const { data, error } = await window.supabase.from('offsite_checklist_items')
    .insert({ event_id: mOffOpenId, label, quantity: 1, sort_order: mOffLines(mOffOpenId).length + 1 }).select().single();
  if (error) { toast(navigator.onLine ? error.message : 'You\'re offline — try again once you have signal', true); return; }
  mOffItems.push(data);
  renderOffsiteChecklist();
}

async function removeOffsiteLine(id) {
  const line = mOffItems.find((l) => l.id === id);
  if (!confirm('Remove "' + line.label + '" from this checklist?')) return;
  const { data, error } = await window.supabase.from('offsite_checklist_items').delete().eq('id', id).select();
  if (error || !data.length) { toast(error ? error.message : 'Could not remove that line', true); return; }
  mOffItems = mOffItems.filter((l) => l.id !== id);
  renderOffsiteChecklist();
}
