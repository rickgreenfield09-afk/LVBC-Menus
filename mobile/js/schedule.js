// schedule.js (mobile)
// Screen: #screen-schedule — the light version of My Shifts
// (js/myshifts.js): the signed-in staffer's upcoming shifts as a list,
// plus open shifts anyone can claim. Building or editing the schedule
// stays on the desktop panel.
// Depends on: window.supabase, window.currentStaff, toast(),
// escHtml(), toDateStr(), fmtTime() (core.js)

let mDaySettings = [];
let mMyStaffIds = [];

// Same rule as js/schedule.js — a "morning" slot that starts at noon
// or later (Sunday) reads as Afternoon.
function shiftSlotLabel(setting, period) {
  if (period === 'evening') return 'Evening';
  const h = setting && setting.morning_start ? parseInt(setting.morning_start.split(':')[0], 10) : 9;
  return h >= 12 ? 'Afternoon' : 'Morning';
}

// A shift assigned to a duplicate/placeholder profile (same email,
// different id — see migration_008/014) won't match the session's own
// id, so resolve every staff_profiles row sharing this email.
async function resolveMyStaffIds() {
  const selfId = window.currentStaff.id;
  const email = window.currentStaff.email;
  if (!email) return [selfId];
  const { data, error } = await window.supabase.from('staff_profiles').select('id').eq('email', email);
  if (error || !data || !data.length) return [selfId];
  const ids = data.map((r) => r.id);
  if (!ids.includes(selfId)) ids.push(selfId);
  return ids;
}

async function loadSchedule() {
  if (!mDaySettings.length) {
    const { data } = await window.supabase.from('shift_day_settings').select('*').order('day_of_week');
    mDaySettings = data || [];
  }
  mMyStaffIds = await resolveMyStaffIds();
  await Promise.all([loadMyUpcomingShifts(), loadOpenShifts()]);
}

function shiftRowHtml(s, actionHtml) {
  const d = new Date(s.shift_date + 'T00:00:00');
  const setting = mDaySettings.find((x) => x.day_of_week === d.getDay()) || {};
  const label = s.role === 'manager' ? 'Manager on Duty' : shiftSlotLabel(setting, s.period);
  const isToday = s.shift_date === toDateStr(new Date());
  return '<div class="shift-row"><div>'
    + '<div class="shift-row-name">' + d.toLocaleDateString('default', { weekday: 'short', month: 'short', day: 'numeric' }) + ' · ' + escHtml(label)
    + (isToday ? ' <span class="badge badge-teal">Today</span>' : '') + '</div>'
    + '<div class="shift-row-meta">' + (s.start_time ? fmtTime(s.start_time) + (s.end_time ? '–' + fmtTime(s.end_time) : '') : '') + '</div>'
    + '</div>' + (actionHtml || '') + '</div>';
}

// ── MY UPCOMING SHIFTS ────────────────────────────────────
async function loadMyUpcomingShifts() {
  const el = document.getElementById('m-my-shifts');
  const { data, error } = await window.supabase.from('shifts').select('*')
    .in('staff_id', mMyStaffIds).gte('shift_date', toDateStr(new Date())).order('shift_date').order('start_time');
  if (error) { el.innerHTML = '<div class="loading">Error: ' + escHtml(error.message) + '</div>'; return; }
  if (!data || !data.length) { el.innerHTML = '<div class="loading">No upcoming shifts</div>'; return; }
  el.innerHTML = data.map((s) => shiftRowHtml(s)).join('');
}

// ── OPEN SHIFTS (never assigned, anyone can claim) ────────
async function loadOpenShifts() {
  const el = document.getElementById('m-open-shifts');
  const { data, error } = await window.supabase.from('shifts').select('*')
    .is('staff_id', null).gte('shift_date', toDateStr(new Date())).order('shift_date').order('start_time');
  if (error) { el.innerHTML = '<div class="loading">Error: ' + escHtml(error.message) + '</div>'; return; }
  if (!data || !data.length) { el.innerHTML = '<div class="loading">No open shifts right now</div>'; return; }
  el.innerHTML = data.map((s) => shiftRowHtml(s, '<button class="btn btn-sm btn-primary" onclick="claimOpenShift(\'' + s.id + '\')">Claim</button>')).join('');
}

// Filters the update to rows still unassigned (staff_id is null) so
// two people tapping "Claim" on the same shift can't both win it.
async function claimOpenShift(shiftId) {
  const { data, error } = await window.supabase.from('shifts')
    .update({ staff_id: window.currentStaff.id, claimed_by: window.currentStaff.id, claimed_at: new Date().toISOString() })
    .eq('id', shiftId).is('staff_id', null).select();
  if (error) { toast('Error: ' + error.message, true); return; }
  if (!data || !data.length) { toast('Someone already claimed that shift', true); loadOpenShifts(); return; }
  toast('Shift claimed — it\'s yours now');
  loadMyUpcomingShifts();
  loadOpenShifts();
}
