// events.js
// Sub-tab: #scheduletab-events — admin/scheduler-only CRUD for both
// one-off events (`events` table) and recurring event patterns
// (`recurring_events`, computed by recurring.js) through a single
// form (toggle One-Time / Recurring), listed together as one
// "Upcoming Events" feed. Gated in the UI by canSchedule() and by
// RLS — see supabase/schema.sql.
// Depends on: window.supabase, toast(), escHtml() (menu.js),
// canSchedule()/logAudit()/toDateStr()/fmtTime() (schedule.js),
// refreshRecurringData()/computeRecurringOccurrences()/recurringEvents (recurring.js)

let eventsList = [];
let eventEditId = null;
let recurringEditId = null;
let eventMode = 'once';
let customEventTypes = [];

const BUILTIN_EVENT_TYPES = { trivia: 'Trivia Night', bingo: 'Music Bingo', karaoke: 'Karaoke', special: 'Special / Performance', market: 'Farmers Market', foodtruck: 'Food Truck', vfw: 'VFW Night' };
const AUTO_EVENT_NAMES = { trivia: 'Trivia Night', bingo: 'Music Bingo', karaoke: 'Karaoke Night', vfw: 'VFW Night' };

// timestamptz columns are stored/interpreted in the DB's timezone
// (UTC on Supabase) — sending a naive "date T time" string lets
// Postgres treat it as UTC, shifting the displayed time by the
// browser's UTC offset. Build the Date from local components and
// serialize with toISOString() so the stored instant matches what
// was actually typed.
function localDateTimeToISOString(dateStr, timeStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const [hh, mm] = timeStr.split(':').map(Number);
  return new Date(y, m - 1, d, hh, mm, 0).toISOString();
}
const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const WEEK_ORDINALS = { 1: '1st', 2: '2nd', 3: '3rd', 4: '4th', 5: 'last' };

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
  await refreshRecurringData();
  document.getElementById('ev-staff').innerHTML = '<option value="">Unassigned</option>' + scheduleStaff.map((s) => '<option value="' + s.id + '">' + escHtml(s.name) + '</option>').join('');

  const { data, error } = await window.supabase.from('events').select('*').gte('event_date', toDateStr(new Date()) + 'T00:00:00').order('event_date');
  if (error) { el.innerHTML = '<div class="loading">Error: ' + escHtml(error.message) + '</div>'; return; }
  eventsList = data || [];
  renderEventsList();
}

function renderEventsList() {
  const el = document.getElementById('events-list');
  const today = new Date();
  const lookAhead = new Date(today); lookAhead.setDate(lookAhead.getDate() + 60);
  const upcomingRecurring = computeRecurringOccurrences(today, lookAhead)
    .map((o) => ({ kind: 'recurring', recurringEventId: o.recurringEventId, sortKey: o.date + 'T' + (o.start_time || '00:00'), date: o.date, start_time: o.start_time, end_time: o.end_time, name: o.name, event_type: o.event_type, staff_id: o.staff_id }));
  const oneOff = eventsList.map((e) => ({ kind: 'event', id: e.id, sortKey: e.event_date, event: e }));
  const combined = oneOff.concat(upcomingRecurring).sort((a, b) => a.sortKey.localeCompare(b.sortKey));

  if (!combined.length) { el.innerHTML = '<div class="loading">No upcoming events</div>'; return; }

  el.innerHTML = combined.map((item) => {
    if (item.kind === 'event') {
      const e = item.event;
      const d = new Date(e.event_date);
      const end = e.event_end ? new Date(e.event_end) : null;
      return '<div class="event-card">'
        + '<div class="event-date-block"><div class="event-date-month">' + d.toLocaleDateString('default', { month: 'short' }) + '</div>'
        + '<div class="event-date-day">' + d.getDate() + '</div>'
        + '<div class="event-date-time">' + d.toLocaleTimeString('default', { hour: 'numeric', minute: '2-digit' }) + (end ? '–' + end.toLocaleTimeString('default', { hour: 'numeric', minute: '2-digit' }) : '') + '</div></div>'
        + '<div class="event-info"><span class="event-type-badge etype-' + escHtml(BUILTIN_EVENT_TYPES[e.event_type] ? e.event_type : 'default') + '">' + escHtml(eventTypeLabel(e.event_type)) + '</span>'
        + '<div class="event-name">' + escHtml(e.event_name) + '</div>'
        + (e.event_type === 'vfw' ? '<div class="event-meta">' + (e.staff_id ? escHtml(staffName(e.staff_id)) : 'Unassigned') + '</div>' : '')
        + (e.notes ? '<div class="event-meta">' + escHtml(e.notes) + '</div>' : '') + '</div>'
        + '<div style="display:flex;gap:6px;">'
        + '<button class="btn btn-sm btn-secondary" onclick="editEvent(\'' + e.id + '\')">Edit</button>'
        + '<button class="btn btn-sm btn-danger" onclick="deleteEvent(\'' + e.id + '\')">Delete</button>'
        + '</div></div>';
    }
    const d = new Date(item.date + 'T00:00:00');
    return '<div class="event-card">'
      + '<div class="event-date-block"><div class="event-date-month">' + d.toLocaleDateString('default', { month: 'short' }) + '</div>'
      + '<div class="event-date-day">' + d.getDate() + '</div>'
      + '<div class="event-date-time">' + (item.start_time ? fmtTime(item.start_time) + (item.end_time ? '–' + fmtTime(item.end_time) : '') : '') + '</div></div>'
      + '<div class="event-info"><span class="event-type-badge etype-' + escHtml(BUILTIN_EVENT_TYPES[item.event_type] ? item.event_type : 'default') + '">' + escHtml(eventTypeLabel(item.event_type)) + '</span> <span class="badge badge-purple">Recurring</span>'
      + '<div class="event-name">' + escHtml(item.name) + '</div>'
      + (item.event_type === 'vfw' ? '<div class="event-meta">' + (item.staff_id ? escHtml(staffName(item.staff_id)) : 'Unassigned') + '</div>' : '') + '</div>'
      + '<div style="display:flex;gap:6px;">'
      + '<button class="btn btn-sm btn-secondary" onclick="editRecurringEvent(\'' + item.recurringEventId + '\')">Edit</button>'
      + '<button class="btn btn-sm btn-danger" onclick="deleteRecurringEvent(\'' + item.recurringEventId + '\')">Delete</button>'
      + '</div></div>';
  }).join('');
}

// ── FORM: mode + type ──────────────────────────────────────
function setEventMode(mode) {
  eventMode = mode;
  document.getElementById('ev-mode-btn-once').classList.toggle('active', mode === 'once');
  document.getElementById('ev-mode-btn-recurring').classList.toggle('active', mode === 'recurring');
  document.getElementById('ev-once-fields').style.display = mode === 'once' ? '' : 'none';
  document.getElementById('ev-recurring-fields').style.display = mode === 'recurring' ? '' : 'none';
  const saving = eventEditId || recurringEditId;
  document.getElementById('btn-save-event').textContent = saving ? 'Save Changes' : (mode === 'once' ? 'Add Event' : 'Add Recurring Event');
}

function onRecurrenceTypeChange() {
  document.getElementById('rec-week-of-month-wrap').style.display = document.getElementById('rec-type').value === 'monthly_nth_weekday' ? '' : 'none';
}

function onEventTypeChange() {
  const val = document.getElementById('ev-type').value;
  document.getElementById('ev-other-wrap').style.display = val === '__other__' ? '' : 'none';
  document.getElementById('ev-staff-wrap').style.display = val === 'vfw' ? '' : 'none';
  const nameEl = document.getElementById('ev-name');
  const isAutoOrEmpty = !nameEl.value || Object.values(AUTO_EVENT_NAMES).includes(nameEl.value);
  if (AUTO_EVENT_NAMES[val] && isAutoOrEmpty) nameEl.value = AUTO_EVENT_NAMES[val];
}

// ── ONE-OFF EVENTS ─────────────────────────────────────────
function editEvent(id) {
  const e = eventsList.find((x) => x.id === id);
  if (!e) return;
  cancelEventEdit();
  eventEditId = id;
  setEventMode('once');
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
  document.getElementById('ev-staff-wrap').style.display = e.event_type === 'vfw' ? '' : 'none';
  document.getElementById('ev-staff').value = e.staff_id || '';
  document.getElementById('btn-save-event').textContent = 'Save Changes';
}

function cancelEventEdit() {
  eventEditId = null;
  recurringEditId = null;
  document.getElementById('ev-form-label').textContent = 'Add Event';
  document.getElementById('ev-cancel-edit').style.visibility = 'hidden';
  document.getElementById('ev-name').value = '';
  document.getElementById('ev-type').value = 'trivia';
  document.getElementById('ev-other-wrap').style.display = 'none';
  document.getElementById('ev-other-text').value = '';
  document.getElementById('ev-other-save').checked = false;
  document.getElementById('ev-staff-wrap').style.display = 'none';
  document.getElementById('ev-staff').value = '';
  document.getElementById('ev-date').value = '';
  document.getElementById('ev-start-time').value = '';
  document.getElementById('ev-end-time').value = '';
  document.getElementById('rec-type').value = 'weekly';
  document.getElementById('rec-weekday').value = '0';
  onRecurrenceTypeChange();
  document.getElementById('rec-start-time').value = '';
  document.getElementById('rec-end-time').value = '';
  document.getElementById('ev-notes').value = '';
  setEventMode('once');
}

async function resolveCustomTypeIfNeeded() {
  let eventType = document.getElementById('ev-type').value;
  if (eventType !== '__other__') return eventType;
  const customText = document.getElementById('ev-other-text').value.trim();
  if (!customText) { toast('Enter a custom type name', true); return null; }
  eventType = slugifyEventType(customText);
  if (document.getElementById('ev-other-save').checked) {
    const { error: typeErr } = await window.supabase.from('event_types').upsert({ key: eventType, label: customText }, { onConflict: 'key' });
    if (!typeErr) await loadEventTypes();
  } else if (!customEventTypes.some((t) => t.key === eventType)) {
    customEventTypes.push({ key: eventType, label: customText });
  }
  return eventType;
}

async function saveEventOrRecurring() {
  if (!canSchedule()) return;
  const name = document.getElementById('ev-name').value.trim();
  if (!name) { toast('Enter an event name', true); return; }
  const eventType = await resolveCustomTypeIfNeeded();
  if (!eventType) return;

  if (eventMode === 'once') {
    await saveOneOffEvent(name, eventType);
  } else {
    await saveRecurringEvent(name, eventType);
  }
}

async function saveOneOffEvent(name, eventType) {
  const alertEl = document.getElementById('event-alert');
  alertEl.style.display = 'none';
  const dateVal = document.getElementById('ev-date').value;
  const startVal = document.getElementById('ev-start-time').value;
  if (!dateVal || !startVal) { toast('Date and start time are required', true); return; }
  const endVal = document.getElementById('ev-end-time').value;
  const payload = {
    event_name: name,
    event_type: eventType,
    event_date: localDateTimeToISOString(dateVal, startVal),
    event_end: endVal ? localDateTimeToISOString(dateVal, endVal) : null,
    staff_id: eventType === 'vfw' ? (document.getElementById('ev-staff').value || null) : null,
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

// ── RECURRING EVENTS ───────────────────────────────────────
function editRecurringEvent(id) {
  const re = recurringEvents.find((x) => x.id === id);
  if (!re) return;
  cancelEventEdit();
  recurringEditId = id;
  setEventMode('recurring');
  document.getElementById('ev-form-label').textContent = 'Edit Recurring Event';
  document.getElementById('ev-cancel-edit').style.visibility = 'visible';
  document.getElementById('ev-name').value = re.name;
  document.getElementById('ev-other-wrap').style.display = 'none';
  document.getElementById('ev-type').value = BUILTIN_EVENT_TYPES[re.event_type] ? re.event_type : 'trivia';
  document.getElementById('rec-type').value = re.recurrence_type;
  document.getElementById('rec-weekday').value = re.day_of_week;
  document.getElementById('rec-week-of-month').value = re.week_of_month || 3;
  onRecurrenceTypeChange();
  document.getElementById('rec-start-time').value = (re.start_time || '').slice(0, 5);
  document.getElementById('rec-end-time').value = (re.end_time || '').slice(0, 5);
  document.getElementById('ev-notes').value = re.notes || '';
  document.getElementById('ev-staff-wrap').style.display = re.event_type === 'vfw' ? '' : 'none';
  document.getElementById('ev-staff').value = re.default_staff_id || '';
  document.getElementById('btn-save-event').textContent = 'Save Changes';
}

async function saveRecurringEvent(name, eventType) {
  const alertEl = document.getElementById('event-alert');
  alertEl.style.display = 'none';
  const recurrenceType = document.getElementById('rec-type').value;
  const payload = {
    name,
    event_type: eventType,
    recurrence_type: recurrenceType,
    day_of_week: parseInt(document.getElementById('rec-weekday').value, 10),
    week_of_month: recurrenceType === 'monthly_nth_weekday' ? parseInt(document.getElementById('rec-week-of-month').value, 10) : null,
    start_time: document.getElementById('rec-start-time').value || null,
    end_time: document.getElementById('rec-end-time').value || null,
    default_staff_id: eventType === 'vfw' ? (document.getElementById('ev-staff').value || null) : null,
    notes: document.getElementById('ev-notes').value.trim() || null,
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
  cancelEventEdit();
  await refreshRecurringData();
  recomputeVisibleRecurring();
  renderScheduleCalendar();
  loadEventsList();
}

async function deleteRecurringEvent(id) {
  if (!canSchedule()) return;
  if (!confirm('Delete this whole recurring event series? This cannot be undone.')) return;
  const { error } = await window.supabase.from('recurring_events').delete().eq('id', id);
  if (error) { toast('Error: ' + error.message, true); return; }
  logAudit('delete_recurring_event', 'recurring_events', id, null);
  await refreshRecurringData();
  recomputeVisibleRecurring();
  renderScheduleCalendar();
  loadEventsList();
  toast('Recurring event removed');
}
