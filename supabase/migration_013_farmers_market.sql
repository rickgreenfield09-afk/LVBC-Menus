-- ============================================================
-- Migration 013 — Farmers Market as a standing recurring event
-- ============================================================
-- Every Saturday, 10am-2pm. Nobody should have to re-create this
-- monthly — cancel a specific Saturday from the Calendar day view
-- (Skip) if it's not happening that week.

insert into recurring_events (name, event_type, recurrence_type, day_of_week, start_time, end_time, notes)
values ('Farmers Market', 'market', 'weekly', 6, '10:00', '14:00', 'Skip a specific Saturday from the day view if it is not happening that week.');
