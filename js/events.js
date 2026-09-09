// events.js
// Sub-tab: #scheduletab-events — admin/scheduler-only CRUD for
// one-off events (`events` table) and recurring event patterns
// (`recurring_events`, computed/rendered by recurring.js). Gated in
// the UI by canSchedule() and by RLS — see supabase/schema.sql.
// Depends on: window.supabase, toast(), escHtml() (menu.js),
// canSchedule()/logAudit()/toDateStr()/scheduleStaff (schedule.js),
// refreshRecurringData()/recurringEvents (recurring.js)

let eventsList = [];
let eventEditId = null;
let customEventTypes = [];

const BUILTIN_EVENT_TYPES = { trivia: 'Trivia', bingo: 'Music Bingo', karaoke: 'Karaoke', special: 'Special / Performance', market: 'Farmers Market', foodtruck: 'Food Truck' };
const AUTO_EVENT_NAMES = { trivia: 'Trivia Night', bingo: 'Music Bingo' };

function eventTypeLabel(key) {
  if (BUILTIN_EVENT_TYPES[key]) return BUILTIN_EVENT_TYPES[key];
  const custom = customEventTypes.find((t) => t.key === key);
  return custom ? custom.label : (key || 'Event');
}

function slugifyEventType(text) {
  return text.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 40) || 'custom';
}

async function loadEventTypes() {
  const { data } = await window.supabase.from('event_types').select('*').order('label');
  customEventTypes = data || [];
}

async function loadEventsList() {
  const el = document.getElementById('events-list');
  el.innerHTML = '<div class="loading">Loading...</div>';
  await loadEventTypes();
  document.getElementById('rec-staff').innerHTML = '<option value="">No default staffer</option>' + scheduleStaff.map((s) => '<option value="' + s.id + '">' + escHtml(s.name) + '</option>').join('');
  const { data, error } = await window.supabase.from('events').select('*').gte('event_date', toDateStr(new Date()) + 'T00:00:00').order('event_date');
  if (error) { el.innerHTML = '<div class="loading">Error: ' + escHtml(error.message) + '</div>'; return; }
  eventsList = data || [];
  renderEventsList();
  await loadRecurringEventsList();
}

function renderEventsList() {
  const el = document.getElementById('events-list');
  if (!eventsList.length) { el.innerHTML = '<div class="loading">No upcoming events</div>'; return; }
  el.innerHTML = eventsList.map((e) => {
    const d = new Date(e.event_date);
    const end = e.event_end ? new Date(e.event_end) : null;
    return '<div class="event-card">'
      + '<div class="event-date-block"><div class="event-date-month">' + d.toLocaleDateString('default', { month: 'short' }) + '</div>'
      + '<div class="event-date-day">' + d.getDate() + '</div>'
      + '<div class="event-date-time">' + d.toLocaleTimeString('default', { hour: 'numeric', minute: '2-digit' }) + (end ? '–' + end.toLocaleTimeString('default', { hour: 'numeric', minute: '2-digit' }) : '') + '</div></div>'
      + '<div class="event-info"><span class="event-type-badge etype-' + escHtml(BUILTIN_EVENT_TYPES[e.event_type] ? e.event_type : 'default') + '">' + escHtml(eventTypeLabel(e.event_type)) + '</span>'
      + '<div class="event-name">' + escHtml(e.event_name) + '</div>'
      + (e.notes ? '<div class="event-meta">' + escHtml(e.notes) + '</div>' : '') + '</div>'
      + '<div style="display:flex;gap:6px;">'
      + '<button class="btn btn-sm btn-secondary" onclick="editEvent(\'' + e.id + '\')">Edit</button>'
      + '<button class="btn btn-sm btn-danger" onclick="deleteEvent(\'' + e.id + '\')">Delete</button>'
      + '</div></div>';
  }).join('');
}

function onEventTypeChange() {
  const val = document.getElementById('ev-type').value;
  document.getElementById('ev-other-wrap').style.display = val === '__other__' ? '' : 'none';
  const nameEl = document.getElementById('ev-name');
  const isAutoOrEmpty = !nameEl.value || Object.values(AUTO_EVENT_NAMES).includes(nameEl.value);
  if (AUTO_EVENT_NAMES[val] && isAutoOrEmpty) nameEl.value = AUTO_EVENT_NAMES[val];
}

function editEvent(id) {
  const e = eventsList.find((x) => x.id === id);
  if (!e) return;
  eventEditId = id;
  document.getElementById('ev-form-label').textContent = 'Edit Event';
  document.getElementById('ev-cancel-edit').style.visibility = 'visible';
  document.getElementById('ev-name').value = e.event_name;
  document.getElementById('ev-other-wrap').style.display = 'none';
  if (BUILTIN_EVENT_TYPES[e.event_type]) {
    document.getElementById('ev-type').value = e.event_type;
  } else {
    document.getElementById('ev-type').value = '__other__';
    document.getElementById('ev-other-wrap').style.display = '';
    document.getElementById('ev-other-text').value = eventTypeLabel(e.event_type);
    document.getElementById('ev-other-save').checked = false;
  }
  const d = new Date(e.event_date);
  document.getElementById('ev-date').value = toDateStr(d);
  document.getElementById('ev-start-time').value = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  document.getElementById('ev-end-time').value = e.event_end ? (() => { const t = new Date(e.event_end); return String(t.getHours()).padStart(2, '0') + ':' + String(t.getMinutes()).padStart(2, '0'); })() : '';
  document.getElementById('ev-notes').value = e.notes || '';
  document.getElementById('btn-save-event').textContent = 'Save Changes';
}

function cancelEventEdit() {
  eventEditId = null;
  document.getElementById('ev-form-label').textContent = 'Add Event';
  document.getElementById('ev-cancel-edit').style.visibility = 'hidden';
  document.getElementById('ev-name').value = '';
  document.getElementById('ev-type').value = 'trivia';
  document.getElementById('ev-other-wrap').style.display = 'none';
  document.getElementById('ev-other-text').value = '';
  document.getElementById('ev-other-save').checked = false;
  document.getElementById('ev-date').value = '';
  document.getElementById('ev-start-time').value = '';
  document.getElementById('ev-end-time').value = '';
  document.getElementById('ev-notes').value = '';
  document.getElementById('btn-save-event').textContent = 'Add Event';
}

async function saveEvent() {
  if (!canSchedule()) return;
  const alertEl = document.getElementById('event-alert');
  alertEl.style.display = 'none';
  const name = document.getElementById('ev-name').value.trim();
  const dateVal = document.getElementById('ev-date').value;
  const startVal = document.getElementById('ev-start-time').value;
  if (!name || !dateVal || !startVal) { toast('Name, date, and start time are required', true); return; }

  let eventType = document.getElementById('ev-type').value;
  if (eventType === '__other__') {
    const customText = document.getElementById('ev-other-text').value.trim();
    if (!customText) { toast('Enter a custom type name', true); return; }
    eventType = slugifyEventType(customText);
    if (document.getElementById('ev-other-save').checked) {
      const { error: typeErr } = await window.supabase.from('event_types').upsert({ key: eventType, label: customText }, { onConflict: 'key' });
      if (!typeErr) await loadEventTypes();
    } else if (!customEventTypes.some((t) => t.key === eventType)) {
      customEventTypes.push({ key: eventType, label: customText });
    }
  }

  const endVal = document.getElementById('ev-end-time').value;
  const payload = {
    event_name: name,
    event_type: eventType,
    event_date: dateVal + 'T' + startVal + ':00',
    event_end: endVal ? dateVal + 'T' + endVal + ':00' : null,
    notes: document.getElementById('ev-notes').value.trim() || null,
  };

  if (eventEditId) {
    const { error } = await window.supabase.from('events').update(payload).eq('id', eventEditId);
    if (error) { toast('Error: ' + error.message, true); return; }
    logAudit('edit_event', 'events', eventEditId, payload);
    toast('Event updated');
  } else {
    const { data, error } = await window.supabase.from('events').insert(payload).select().single();
    if (error) { toast('Error: ' + error.message, true); return; }
    logAudit('add_event', 'events', data.id, payload);
    toast('Event added');
  }
  cancelEventEdit();
  loadEventsList();
  loadScheduleRange();
}

async function deleteEvent(id) {
  if (!canSchedule()) return;
  const { error } = await window.supabase.from('events').delete().eq('id', id);
  if (error) { toast('Error: ' + error.message, true); return; }
  logAudit('delete_event', 'events', id, null);
  eventsList = eventsList.filter((e) => e.id !== id);
  renderEventsList();
  loadScheduleRange();
  toast('Event removed');
}

// ── RECURRING EVENTS (admin CRUD) ─────────────────────────
let recurringEditId = null;

function onRecurrenceTypeChange() {
  document.getElementById('rec-week-of-month-wrap').style.display = document.getElementById('rec-type').value === 'monthly_nth_weekday' ? '' : 'none';
}

async function loadRecurringEventsList() {
  await refreshRecurringData();
  renderRecurringEventsList();
}

const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const WEEK_ORDINALS = { 1: '1st', 2: '2nd', 3: '3rd', 4: '4th', 5: 'last' };

function renderRecurringEventsList() {
  const el = document.getElementById('recurring-events-list');
  if (!recurringEvents.length) { el.innerHTML = '<div class="loading">No recurring events</div>'; return; }
  el.innerHTML = recurringEvents.map((re) => {
    const when = re.recurrence_type === 'weekly'
      ? 'Every ' + WEEKDAY_NAMES[re.day_of_week]
      : 'The ' + WEEK_ORDINALS[re.week_of_month] + ' ' + WEEKDAY_NAMES[re.day_of_week] + ' of the month';
    return '<div class="event-card">'
      + '<div class="event-info"><span class="event-type-badge etype-default">' + escHtml(eventTypeLabel(re.event_type)) + '</span>'
      + '<div class="event-name">' + escHtml(re.name) + '</div>'
      + '<div class="event-meta">' + when + (re.start_time ? ' · ' + fmtTime(re.start_time) + (re.end_time ? '–' + fmtTime(re.end_time) : '') : '') + '</div>'
      + (re.default_staff_id ? '<div class="event-meta">Default: ' + escHtml(staffName(re.default_staff_id)) + '</div>' : '') + '</div>'
      + '<div style="display:flex;gap:6px;">'
      + '<button class="btn btn-sm btn-secondary" onclick="editRecurringEvent(\'' + re.id + '\')">Edit</button>'
      + '<button class="btn btn-sm btn-danger" onclick="deleteRecurringEvent(\'' + re.id + '\')">Delete</button>'
      + '</div></div>';
  }).join('');
}

function editRecurringEvent(id) {
  const re = recurringEvents.find((x) => x.id === id);
  if (!re) return;
  recurringEditId = id;
  document.getElementById('rec-form-label').textContent = 'Edit Recurring Event';
  document.getElementById('rec-cancel-edit').style.visibility = 'visible';
  document.getElementById('rec-name').value = re.name;
  document.getElementById('rec-type').value = re.recurrence_type;
  document.getElementById('rec-weekday').value = re.day_of_week;
  document.getElementById('rec-week-of-month').value = re.week_of_month || 3;
  onRecurrenceTypeChange();
  document.getElementById('rec-start-time').value = (re.start_time || '').slice(0, 5);
  document.getElementById('rec-end-time').value = (re.end_time || '').slice(0, 5);
  document.getElementById('rec-staff').value = re.default_staff_id || '';
  document.getElementById('rec-notes').value = re.notes || '';
  document.getElementById('btn-save-recurring').textContent = 'Save Changes';
}

function cancelRecurringEventEdit() {
  recurringEditId = null;
  document.getElementById('rec-form-label').textContent = 'Add Recurring Event';
  document.getElementById('rec-cancel-edit').style.visibility = 'hidden';
  document.getElementById('rec-name').value = '';
  document.getElementById('rec-type').value = 'weekly';
  document.getElementById('rec-weekday').value = '0';
  onRecurrenceTypeChange();
  document.getElementById('rec-start-time').value = '';
  document.getElementById('rec-end-time').value = '';
  document.getElementById('rec-staff').value = '';
  document.getElementById('rec-notes').value = '';
  document.getElementById('btn-save-recurring').textContent = 'Add Recurring Event';
}

async function saveRecurringEvent() {
  if (!canSchedule()) return;
  const alertEl = document.getElementById('recurring-alert');
  alertEl.style.display = 'none';
  const name = document.getElementById('rec-name').value.trim();
  if (!name) { toast('Enter a name', true); return; }
  const recurrenceType = document.getElementById('rec-type').value;
  const payload = {
    name,
    recurrence_type: recurrenceType,
    day_of_week: parseInt(document.getElementById('rec-weekday').value, 10),
    week_of_month: recurrenceType === 'monthly_nth_weekday' ? parseInt(document.getElementById('rec-week-of-month').value, 10) : null,
    start_time: document.getElementById('rec-start-time').value || null,
    end_time: document.getElementById('rec-end-time').value || null,
    default_staff_id: document.getElementById('rec-staff').value || null,
    notes: document.getElementById('rec-notes').value.trim() || null,
  };

  if (recurringEditId) {
    const { error } = await window.supabase.from('recurring_events').update(payload).eq('id', recurringEditId);
    if (error) { toast('Error: ' + error.message, true); return; }
    logAudit('edit_recurring_event', 'recurring_events', recurringEditId, payload);
    toast('Recurring event updated');
  } else {
    const { data, error } = await window.supabase.from('recurring_events').insert(payload).select().single();
    if (error) { toast('Error: ' + error.message, true); return; }
    logAudit('add_recurring_event', 'recurring_events', data.id, payload);
    toast('Recurring event added');
  }
  cancelRecurringEventEdit();
  await loadRecurringEventsList();
  recomputeVisibleRecurring();
  renderScheduleCalendar();
}

async function deleteRecurringEvent(id) {
  if (!canSchedule()) return;
  const { error } = await window.supabase.from('recurring_events').delete().eq('id', id);
  if (error) { toast('Error: ' + error.message, true); return; }
  logAudit('delete_recurring_event', 'recurring_events', id, null);
  await loadRecurringEventsList();
  recomputeVisibleRecurring();
  renderScheduleCalendar();
  toast('Recurring event removed');
}
