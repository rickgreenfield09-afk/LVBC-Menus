// events.js
// Sub-tab: #scheduletab-events — admin/scheduler-only CRUD for the
// `events` table (gated in the UI by canSchedule() and by RLS — see
// supabase/schema.sql). Feeds the event pills shown on the Schedule
// calendar, My Shifts, and the day modal.
// Depends on: window.supabase, toast(), escHtml() (menu.js),
// canSchedule()/logAudit() (schedule.js)

let eventsList = [];
let eventEditId = null;

const EVENT_TYPE_LABELS = { trivia: 'Trivia', bingo: 'Music Bingo', karaoke: 'Karaoke', special: 'Special / Performance', market: 'Farmers Market', default: 'Other' };

async function loadEventsList() {
  const el = document.getElementById('events-list');
  el.innerHTML = '<div class="loading">Loading...</div>';
  const { data, error } = await window.supabase.from('events').select('*').gte('event_date', toDateStr(new Date()) + 'T00:00:00').order('event_date');
  if (error) { el.innerHTML = '<div class="loading">Error: ' + escHtml(error.message) + '</div>'; return; }
  eventsList = data || [];
  renderEventsList();
}

function renderEventsList() {
  const el = document.getElementById('events-list');
  if (!eventsList.length) { el.innerHTML = '<div class="loading">No upcoming events</div>'; return; }
  el.innerHTML = eventsList.map((e) => {
    const d = new Date(e.event_date);
    return '<div class="event-card">'
      + '<div class="event-date-block"><div class="event-date-month">' + d.toLocaleDateString('default', { month: 'short' }) + '</div>'
      + '<div class="event-date-day">' + d.getDate() + '</div>'
      + '<div class="event-date-time">' + d.toLocaleTimeString('default', { hour: 'numeric', minute: '2-digit' }) + '</div></div>'
      + '<div class="event-info"><span class="event-type-badge etype-' + escHtml(e.event_type || 'default') + '">' + escHtml(EVENT_TYPE_LABELS[e.event_type] || e.event_type || 'Event') + '</span>'
      + '<div class="event-name">' + escHtml(e.event_name) + '</div>'
      + (e.notes ? '<div class="event-meta">' + escHtml(e.notes) + '</div>' : '') + '</div>'
      + '<div style="display:flex;gap:6px;">'
      + '<button class="btn btn-sm btn-secondary" onclick="editEvent(\'' + e.id + '\')">Edit</button>'
      + '<button class="btn btn-sm btn-danger" onclick="deleteEvent(\'' + e.id + '\')">Delete</button>'
      + '</div></div>';
  }).join('');
}

function editEvent(id) {
  const e = eventsList.find((x) => x.id === id);
  if (!e) return;
  eventEditId = id;
  document.getElementById('ev-form-label').textContent = 'Edit Event';
  document.getElementById('ev-cancel-edit').style.visibility = 'visible';
  document.getElementById('ev-name').value = e.event_name;
  document.getElementById('ev-type').value = e.event_type || 'default';
  const d = new Date(e.event_date);
  document.getElementById('ev-date').value = toDateStr(d) + 'T' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  document.getElementById('ev-notes').value = e.notes || '';
  document.getElementById('btn-save-event').textContent = 'Save Changes';
}

function cancelEventEdit() {
  eventEditId = null;
  document.getElementById('ev-form-label').textContent = 'Add Event';
  document.getElementById('ev-cancel-edit').style.visibility = 'hidden';
  document.getElementById('ev-name').value = '';
  document.getElementById('ev-type').value = 'trivia';
  document.getElementById('ev-date').value = '';
  document.getElementById('ev-notes').value = '';
  document.getElementById('btn-save-event').textContent = 'Add Event';
}

async function saveEvent() {
  if (!canSchedule()) return;
  const alertEl = document.getElementById('event-alert');
  alertEl.style.display = 'none';
  const name = document.getElementById('ev-name').value.trim();
  const dateVal = document.getElementById('ev-date').value;
  if (!name || !dateVal) { toast('Name and date/time are required', true); return; }

  const payload = {
    event_name: name,
    event_type: document.getElementById('ev-type').value,
    event_date: dateVal,
    notes: document.getElementById('ev-notes').value.trim() || null,
  };

  if (eventEditId) {
    const { data, error } = await window.supabase.from('events').update(payload).eq('id', eventEditId).select().single();
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
