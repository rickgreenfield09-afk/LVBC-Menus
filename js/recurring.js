// recurring.js
// Recurring event patterns (weekly / monthly-nth-weekday, e.g. "3rd
// Tuesday") stored in recurring_events, with per-occurrence overrides
// (skip / move / reassign staffer) in recurring_event_overrides so a
// single instance can shift without touching the series. Loaded
// alongside staff/day settings in schedule.js's loadStaffAndSettings();
// rendered on the Schedule calendar, My Shifts, and the day modal.
// Depends on: window.supabase, toast(), escHtml() (menu.js),
// canSchedule()/logAudit()/toDateStr()/staffName() (schedule.js)

function nthWeekdayOfMonth(year, month, dow, n) {
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  if (n === 5) {
    const lastDate = new Date(year, month, daysInMonth);
    const diff = (lastDate.getDay() - dow + 7) % 7;
    return daysInMonth - diff;
  }
  const firstDow = new Date(year, month, 1).getDay();
  const day = 1 + ((dow - firstDow + 7) % 7) + (n - 1) * 7;
  return day <= daysInMonth ? day : null;
}

function isRecurringOccurrenceDate(re, d) {
  if (re.recurrence_type === 'weekly') return d.getDay() === re.day_of_week;
  const nthDay = nthWeekdayOfMonth(d.getFullYear(), d.getMonth(), re.day_of_week, re.week_of_month);
  return nthDay === d.getDate();
}

function buildRecurringOccurrence(re, baseDate, displayDate, override) {
  return {
    recurringEventId: re.id,
    name: re.name,
    event_type: re.event_type,
    date: displayDate,
    baseDate,
    start_time: re.start_time,
    end_time: re.end_time,
    staff_id: (override && override.staff_id) || re.default_staff_id,
    moved: !!(override && override.moved_to_date),
  };
}

// Two passes: (1) normal occurrences landing in [start,end] that
// aren't skipped/moved-away, (2) any override moved INTO [start,end]
// even if its original date falls in a different month.
function computeRecurringOccurrences(startDate, endDate) {
  const startStr = toDateStr(startDate), endStr = toDateStr(endDate);
  const results = [];

  recurringEvents.forEach((re) => {
    for (let d = new Date(startDate); d <= endDate; d.setDate(d.getDate() + 1)) {
      if (!isRecurringOccurrenceDate(re, d)) continue;
      const baseDateStr = toDateStr(d);
      const override = recurringOverrides.find((o) => o.recurring_event_id === re.id && o.occurrence_date === baseDateStr);
      if (override && (override.skipped || override.moved_to_date)) continue;
      results.push(buildRecurringOccurrence(re, baseDateStr, baseDateStr, override));
    }
  });

  recurringOverrides.forEach((o) => {
    if (o.skipped || !o.moved_to_date) return;
    if (o.moved_to_date < startStr || o.moved_to_date > endStr) return;
    const re = recurringEvents.find((x) => x.id === o.recurring_event_id);
    if (re) results.push(buildRecurringOccurrence(re, o.occurrence_date, o.moved_to_date, o));
  });

  return results;
}

function recomputeVisibleRecurring() {
  const { start, end } = getVisibleRange();
  visibleRecurringOccurrences = computeRecurringOccurrences(start, end);
}

async function refreshRecurringData() {
  const [{ data: re }, { data: ro }] = await Promise.all([
    window.supabase.from('recurring_events').select('*').eq('is_active', true),
    window.supabase.from('recurring_event_overrides').select('*'),
  ]);
  recurringEvents = re || [];
  recurringOverrides = ro || [];
}

async function upsertRecurringOverride(recurringEventId, baseDate, patch) {
  const existing = recurringOverrides.find((o) => o.recurring_event_id === recurringEventId && o.occurrence_date === baseDate);
  const payload = Object.assign(
    { recurring_event_id: recurringEventId, occurrence_date: baseDate, skipped: false, moved_to_date: null, staff_id: null },
    existing ? { skipped: existing.skipped, moved_to_date: existing.moved_to_date, staff_id: existing.staff_id } : {},
    patch
  );
  const { data, error } = await window.supabase.from('recurring_event_overrides')
    .upsert(payload, { onConflict: 'recurring_event_id,occurrence_date' }).select().single();
  if (error) { toast('Error: ' + error.message, true); return false; }
  recurringOverrides = recurringOverrides.filter((o) => !(o.recurring_event_id === recurringEventId && o.occurrence_date === baseDate));
  recurringOverrides.push(data);
  logAudit('recurring_override', 'recurring_events', recurringEventId, patch);
  return true;
}

async function assignRecurringStaff(recurringEventId, baseDate, staffId) {
  if (!canEditInModal()) return;
  if (await upsertRecurringOverride(recurringEventId, baseDate, { staff_id: staffId || null })) {
    toast('Updated');
    refreshRecurringOnActiveDate();
  }
}

async function skipRecurringOccurrence(recurringEventId, baseDate) {
  if (!canEditInModal()) return;
  if (await upsertRecurringOverride(recurringEventId, baseDate, { skipped: true })) {
    toast('Occurrence skipped');
    refreshRecurringOnActiveDate();
  }
}

async function moveRecurringOccurrence(recurringEventId, baseDate) {
  if (!canEditInModal()) return;
  const newDate = document.getElementById('rec-move-' + recurringEventId + '-' + baseDate).value;
  if (!newDate) { toast('Pick a new date', true); return; }
  if (await upsertRecurringOverride(recurringEventId, baseDate, { moved_to_date: newDate })) {
    toast('Occurrence moved to ' + newDate);
    refreshRecurringOnActiveDate();
  }
}

function refreshRecurringOnActiveDate() {
  recomputeVisibleRecurring();
  renderScheduleCalendar();
  if (scheduleActiveDate) renderModalEventsList();
}
