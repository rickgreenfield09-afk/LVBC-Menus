// offsite.js
// Assignments > Events — planning for events held AWAY from the
// brewery (a festival booth, a market stall), kept as a bring-along
// checklist of equipment and materials (migration_038). This is
// separate from Schedule > Events, which is for in-brewery events and
// drives the calendar and member check-ins.
//
// A checklist starts from a reusable template and is then the event's
// own: applying a template COPIES its lines onto the event, so they can
// be changed, added to or removed for that one event without touching
// the template. Each event line has two ticks — packed (going out) and
// returned (back at the brewery).
//
// Schedulers create events, assign staff and manage templates. Anyone
// assigned to an event can also edit and tick its checklist, here or
// on their phone (mobile/js/offsite.js); RLS enforces both.
// Depends on: window.supabase, window.currentStaff, toast(),
// escHtml() (menu.js), toDateStr/scheduleStaff/staffName (schedule.js),
// asgShortDate (assignments.js)

let offEvents = [];
let offEventStaff = [];
let offTemplates = [];
let offItems = [];      // every line of every event and template; small enough to hold whole
let offSelected = null; // { type: 'event' | 'template', id } — id null while a new event is being drafted

async function loadOffsite() {
  const el = document.getElementById('asg-body');
  const [events, staff, templates, items] = await Promise.all([
    window.supabase.from('offsite_events').select('*').order('start_date'),
    window.supabase.from('offsite_event_staff').select('*'),
    window.supabase.from('offsite_checklist_templates').select('*').order('name'),
    window.supabase.from('offsite_checklist_items').select('*').order('sort_order').order('created_at'),
  ]);
  const failed = [events, staff, templates, items].find((r) => r.error);
  if (failed) { el.innerHTML = '<div class="loading">Could not load off-site events: ' + escHtml(failed.error.message) + '</div>'; return; }
  offEvents = events.data;
  offEventStaff = staff.data;
  offTemplates = templates.data;
  offItems = items.data;
  // Keep the open record open across reloads; otherwise land on the next upcoming event.
  const still = offSelected && (offSelected.type === 'event' ? offEvents : offTemplates).some((x) => x.id === offSelected.id);
  if (!still) { const next = offEvents.find((e) => e.end_date >= toDateStr(new Date())); offSelected = next ? { type: 'event', id: next.id } : null; }
  renderOffsite();
}

function offLinesFor(sel) { return offItems.filter((i) => (sel.type === 'event' ? i.event_id : i.template_id) === sel.id); }
function offDateRange(e) { return asgShortDate(e.start_date) + (e.end_date !== e.start_date ? ' – ' + asgShortDate(e.end_date) : '') + ', ' + e.start_date.slice(0, 4); }
function selectOffsite(type, id) { offSelected = { type, id }; renderOffsite(); }

function renderOffsite() {
  const today = toDateStr(new Date());
  const isSel = (type, id) => offSelected && offSelected.type === type && offSelected.id === id;
  const eventRow = (e) => {
    const lines = offLinesFor({ type: 'event', id: e.id });
    return '<div class="asg-task' + (isSel('event', e.id) ? ' selected' : '') + '" onclick="selectOffsite(\'event\',\'' + e.id + '\')"><div class="asg-task-title">' + escHtml(e.name) + '</div>'
      + '<div class="asg-task-meta">' + offDateRange(e) + (e.venue ? ' · ' + escHtml(e.venue) : '') + '</div>'
      + '<div class="asg-task-meta">' + (lines.length ? lines.filter((l) => l.packed_at).length + ' / ' + lines.length + ' packed · ' + lines.filter((l) => l.returned_at).length + ' / ' + lines.length + ' returned' : 'no checklist yet') + '</div></div>';
  };
  const upcoming = offEvents.filter((e) => e.end_date >= today);
  const past = offEvents.filter((e) => e.end_date < today).reverse();

  const left = '<div class="grid2-col">'
    + '<div class="menu-col-header"><div class="section-label" style="margin:0;">Upcoming</div><button class="btn btn-sm btn-primary" onclick="selectOffsite(\'event\',null)">+ New Event</button></div>'
    + '<div class="card" style="margin-bottom:16px;">' + (upcoming.length ? upcoming.map(eventRow).join('') : '<div class="loading">No off-site events planned</div>') + '</div>'
    + (past.length ? '<div class="section-label">Past</div><div class="card" style="margin-bottom:16px;">' + past.map(eventRow).join('') + '</div>' : '')
    + '<div class="menu-col-header"><div class="section-label" style="margin:0;">Checklist Templates</div><button class="btn btn-sm btn-secondary" onclick="addOffsiteTemplate()">+ New Template</button></div>'
    + '<div class="card">' + (offTemplates.length ? offTemplates.map((t) => '<div class="asg-task' + (isSel('template', t.id) ? ' selected' : '') + '" onclick="selectOffsite(\'template\',\'' + t.id + '\')"><span class="asg-task-title">' + escHtml(t.name) + '</span> <span class="asg-task-meta">'
      + offLinesFor({ type: 'template', id: t.id }).length + ' lines</span></div>').join('') : '<div class="loading">No templates yet — build a list once and reuse it</div>') + '</div></div>';

  const right = '<div class="grid2-col">' + (!offSelected ? '<div class="card"><div class="loading">Pick an event or a template, or start a new one.</div></div>'
    : offSelected.type === 'template' ? offsiteTemplateHtml() : offsiteEventHtml()) + '</div>';
  document.getElementById('asg-body').innerHTML = '<div class="card-sub" style="margin:0 0 16px;max-width:640px;">Events away from the brewery, planned as a list of what to bring. In-brewery events stay under Schedule &gt; Events.</div>'
    + '<div class="grid-2" style="grid-template-columns:340px 1fr;align-items:start;">' + left + right + '</div>';
}

// ── CHECKLIST (shared by events and templates) ───
function offsiteChecklistHtml(sel) {
  const lines = offLinesFor(sel);
  const ticks = sel.type === 'event';
  const tick = (l, field, label) => '<td style="text-align:center;"><input type="checkbox" class="off-tick" aria-label="' + label + ' ' + escHtml(l.label) + '"' + (l[field + '_at'] ? ' checked' : '')
    + ' title="' + (l[field + '_at'] ? label + ' by ' + escHtml(staffName(l[field + '_by'])) : 'Not ' + label.toLowerCase()) + '" onchange="tickOffsiteLine(\'' + l.id + '\',\'' + field + '\',this.checked)"></td>';
  return (lines.length ? '<div class="table-wrap off-list"><table><thead><tr>' + (ticks ? '<th style="width:70px;text-align:center;">Packed</th><th style="width:80px;text-align:center;">Returned</th>' : '')
    + '<th>Item</th><th style="width:80px;">Qty</th><th style="width:1%;"></th></tr></thead><tbody>'
    + lines.map((l) => '<tr>' + (ticks ? tick(l, 'packed', 'Packed') + tick(l, 'returned', 'Returned') : '')
      + '<td><input class="off-input" type="text" value="' + escHtml(l.label) + '" aria-label="Item" onchange="updateOffsiteLine(\'' + l.id + '\',\'label\',this.value)"></td>'
      + '<td><input class="off-input" type="number" min="1" step="1" value="' + l.quantity + '" aria-label="Quantity" onchange="updateOffsiteLine(\'' + l.id + '\',\'quantity\',this.value)"></td>'
      + '<td><button class="merch-link" onclick="removeOffsiteLine(\'' + l.id + '\')">remove</button></td></tr>').join('')
    + '</tbody></table></div>' : '<div class="loading">Nothing on this list yet.</div>')
    + '<form class="asg-target-add" onsubmit="addOffsiteLine(event)"><input class="form-input" style="flex:1;" type="text" id="off-new-label" placeholder="Add a line, e.g. 10x10 tent" required>'
    + '<input class="form-input" style="width:80px;" type="number" min="1" step="1" id="off-new-qty" value="1" aria-label="Quantity"><button class="btn btn-sm btn-secondary" type="submit">Add</button></form>';
}

async function addOffsiteLine(e) {
  e.preventDefault();
  const label = document.getElementById('off-new-label').value.trim();
  const quantity = Math.max(1, parseInt(document.getElementById('off-new-qty').value, 10) || 1);
  if (!label) return;
  const owner = offSelected.type === 'event' ? { event_id: offSelected.id } : { template_id: offSelected.id };
  const { error } = await window.supabase.from('offsite_checklist_items').insert(Object.assign({ label, quantity, sort_order: offLinesFor(offSelected).length + 1 }, owner));
  if (error) { toast(error.message, true); return; }
  await loadOffsite();
  document.getElementById('off-new-label').focus();
}

async function updateOffsiteLine(id, field, value) {
  const patch = field === 'quantity' ? { quantity: Math.max(1, parseInt(value, 10) || 1) } : { label: value.trim() };
  if (field === 'label' && !patch.label) { toast('A line needs a name — use remove to delete it', true); renderOffsite(); return; }
  const { error } = await window.supabase.from('offsite_checklist_items').update(patch).eq('id', id);
  if (error) { toast(error.message, true); return; }
  Object.assign(offItems.find((l) => l.id === id), patch);
}

async function tickOffsiteLine(id, field, checked) {
  const patch = {};
  patch[field + '_at'] = checked ? new Date().toISOString() : null;
  patch[field + '_by'] = checked ? window.currentStaff.id : null;
  const { error } = await window.supabase.from('offsite_checklist_items').update(patch).eq('id', id);
  if (error) toast(error.message, true); else Object.assign(offItems.find((l) => l.id === id), patch);
  renderOffsite();
}

async function removeOffsiteLine(id) {
  const { error } = await window.supabase.from('offsite_checklist_items').delete().eq('id', id);
  if (error) { toast(error.message, true); return; }
  offItems = offItems.filter((l) => l.id !== id);
  renderOffsite();
}

// ── EVENT ────────────────────────────────────────
function offsiteEventHtml() {
  const e = offEvents.find((x) => x.id === offSelected.id) || { name: '', venue: '', start_date: toDateStr(new Date()), end_date: toDateStr(new Date()), notes: '' };
  const isNew = !offSelected.id;
  const assigned = offEventStaff.filter((s) => s.event_id === e.id).map((s) => s.staff_id);
  const field = (label, inner) => '<div class="form-group"><label class="form-label">' + label + '</label>' + inner + '</div>';
  let html = '<div class="card off-detail"><div class="section-label" style="margin-top:0;">' + (isNew ? 'New Off-site Event' : 'Event') + '</div>'
    + '<div class="form-row">' + field('Name', '<input class="form-input" type="text" id="off-e-name" value="' + escHtml(e.name) + '" placeholder="e.g. Harvest Festival booth">')
    + field('Where', '<input class="form-input" type="text" id="off-e-venue" value="' + escHtml(e.venue) + '" placeholder="optional">') + '</div>'
    + '<div class="form-row">' + field('Starts', '<input class="form-input" type="date" id="off-e-start" value="' + e.start_date + '">') + field('Ends', '<input class="form-input" type="date" id="off-e-end" value="' + e.end_date + '">') + '</div>'
    + '<div class="form-group" style="margin-bottom:16px;"><label class="form-label">Notes</label><textarea class="form-ta" rows="2" id="off-e-notes" placeholder="optional — load-in time, contact, parking">' + escHtml(e.notes) + '</textarea></div>'
    + '<div style="display:flex;gap:8px;flex-wrap:wrap;"><button class="btn btn-primary" onclick="saveOffsiteEvent()">' + (isNew ? 'Create Event' : 'Save Changes') + '</button>'
    + (isNew ? '' : '<button class="btn btn-danger" style="margin-left:auto;" onclick="deleteOffsiteEvent()">Delete Event</button>') + '</div></div>';
  if (isNew) return html;

  html += '<div class="card off-detail"><div class="section-label" style="margin-top:0;">Who\'s Working It</div><div class="card-sub" style="margin-bottom:10px;">Anyone ticked here can open and edit this checklist on their phone.</div><div class="badge-picker">'
    + scheduleStaff.map((s) => '<div class="badge-pill' + (assigned.includes(s.id) ? ' selected' : '') + '" onclick="toggleOffsiteStaff(\'' + s.id + '\')">' + escHtml(s.name) + '</div>').join('') + '</div></div>';

  const lines = offLinesFor(offSelected);
  html += '<div class="card off-detail"><div class="menu-col-header"><div><div class="section-label" style="margin:0;">Checklist</div>'
    + (lines.length ? '<div class="asg-task-meta">' + lines.filter((l) => l.packed_at).length + ' / ' + lines.length + ' packed · ' + lines.filter((l) => l.returned_at).length + ' / ' + lines.length + ' returned</div>' : '') + '</div>'
    + '<div style="display:flex;gap:8px;flex-wrap:wrap;">'
    + (offTemplates.length ? '<select class="form-select merch-count-at" style="max-width:200px;" aria-label="Add lines from a template" onchange="applyOffsiteTemplate(this.value)"><option value="">Add from template…</option>'
      + offTemplates.map((t) => '<option value="' + t.id + '">' + escHtml(t.name) + '</option>').join('') + '</select>' : '')
    + (lines.length ? '<button class="btn btn-sm btn-secondary" onclick="saveOffsiteAsTemplate()">Save as Template</button>' : '') + '</div></div>'
    + offsiteChecklistHtml(offSelected) + '</div>';
  return html;
}

async function saveOffsiteEvent() {
  const payload = {
    name: document.getElementById('off-e-name').value.trim(),
    venue: document.getElementById('off-e-venue').value.trim() || null,
    start_date: document.getElementById('off-e-start').value,
    end_date: document.getElementById('off-e-end').value || document.getElementById('off-e-start').value,
    notes: document.getElementById('off-e-notes').value.trim() || null,
  };
  if (!payload.name || !payload.start_date) { toast('An event needs a name and a start date', true); return; }
  if (payload.end_date < payload.start_date) { toast('The end date is before the start date', true); return; }
  const { data, error } = offSelected.id
    ? await window.supabase.from('offsite_events').update(payload).eq('id', offSelected.id).select().single()
    : await window.supabase.from('offsite_events').insert(Object.assign({ created_by: window.currentStaff.id }, payload)).select().single();
  if (error) { toast(error.message, true); return; }
  toast(offSelected.id ? 'Event saved' : 'Event created — now assign staff and build the checklist');
  offSelected = { type: 'event', id: data.id };
  await loadOffsite();
}

async function deleteOffsiteEvent() {
  const e = offEvents.find((x) => x.id === offSelected.id);
  if (!confirm('Delete "' + e.name + '" and its checklist? This can\'t be undone.')) return;
  const { error } = await window.supabase.from('offsite_events').delete().eq('id', e.id);
  if (error) { toast(error.message, true); return; }
  offSelected = null;
  toast('Event deleted');
  await loadOffsite();
}

async function toggleOffsiteStaff(staffId) {
  const on = offEventStaff.some((s) => s.event_id === offSelected.id && s.staff_id === staffId);
  const { error } = on
    ? await window.supabase.from('offsite_event_staff').delete().eq('event_id', offSelected.id).eq('staff_id', staffId)
    : await window.supabase.from('offsite_event_staff').insert({ event_id: offSelected.id, staff_id: staffId });
  if (error) { toast(error.message, true); return; }
  await loadOffsite();
}

// Copies the template's lines onto this event. Lines the event already
// has (same name) are skipped, so applying twice doesn't double the list.
async function applyOffsiteTemplate(templateId) {
  if (!templateId) return;
  const have = offLinesFor(offSelected).map((l) => l.label.toLowerCase());
  const add = offLinesFor({ type: 'template', id: templateId }).filter((l) => !have.includes(l.label.toLowerCase()));
  if (!add.length) { toast('Everything on that template is already on this list'); renderOffsite(); return; }
  const { error } = await window.supabase.from('offsite_checklist_items')
    .insert(add.map((l, i) => ({ event_id: offSelected.id, label: l.label, quantity: l.quantity, sort_order: have.length + i + 1 })));
  if (error) { toast(error.message, true); return; }
  toast(add.length + ' line' + (add.length === 1 ? '' : 's') + ' added');
  await loadOffsite();
}

async function saveOffsiteAsTemplate() {
  const e = offEvents.find((x) => x.id === offSelected.id);
  const name = (prompt('Save this checklist as a template named:', e.name + ' kit') || '').trim();
  if (!name) return;
  const { data: tpl, error } = await window.supabase.from('offsite_checklist_templates').insert({ name }).select().single();
  if (error) { toast(error.code === '23505' ? 'There is already a template called "' + name + '"' : error.message, true); return; }
  const { error: lineErr } = await window.supabase.from('offsite_checklist_items')
    .insert(offLinesFor(offSelected).map((l, i) => ({ template_id: tpl.id, label: l.label, quantity: l.quantity, sort_order: i + 1 })));
  if (lineErr) { toast(lineErr.message, true); return; }
  toast('Saved as a template');
  await loadOffsite();
}

// ── TEMPLATE ─────────────────────────────────────
function offsiteTemplateHtml() {
  const t = offTemplates.find((x) => x.id === offSelected.id);
  return '<div class="card off-detail"><div class="menu-col-header"><div><div class="section-label" style="margin:0;">Template</div><div class="asg-task-meta">Changing this does not change events that already used it</div></div>'
    + '<button class="btn btn-sm btn-danger" onclick="deleteOffsiteTemplate()">Delete Template</button></div>'
    + '<div class="form-group" style="margin-bottom:16px;"><label class="form-label">Name</label><input class="form-input" style="width:100%;" type="text" value="' + escHtml(t.name) + '" onchange="renameOffsiteTemplate(this.value)"></div>'
    + offsiteChecklistHtml(offSelected) + '</div>';
}

async function addOffsiteTemplate() {
  const name = (prompt('Name for the new template (e.g. Festival booth kit):') || '').trim();
  if (!name) return;
  const { data, error } = await window.supabase.from('offsite_checklist_templates').insert({ name }).select().single();
  if (error) { toast(error.code === '23505' ? 'There is already a template called "' + name + '"' : error.message, true); return; }
  offSelected = { type: 'template', id: data.id };
  await loadOffsite();
}

async function renameOffsiteTemplate(value) {
  const name = value.trim();
  if (!name) { renderOffsite(); return; }
  const { error } = await window.supabase.from('offsite_checklist_templates').update({ name }).eq('id', offSelected.id);
  if (error) { toast(error.code === '23505' ? 'There is already a template called "' + name + '"' : error.message, true); renderOffsite(); return; }
  await loadOffsite();
}

async function deleteOffsiteTemplate() {
  const t = offTemplates.find((x) => x.id === offSelected.id);
  if (!confirm('Delete the template "' + t.name + '"? Events that already used it keep their lists.')) return;
  const { error } = await window.supabase.from('offsite_checklist_templates').delete().eq('id', t.id);
  if (error) { toast(error.message, true); return; }
  offSelected = null;
  await loadOffsite();
}
