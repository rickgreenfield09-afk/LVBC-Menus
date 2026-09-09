-- ============================================================
-- Migration 007 — Schedule redesign: day templates, MOD,
-- morning/evening periods, bulk scheduling, settings.
-- ============================================================

-- ---------- SHIFT DAY SETTINGS ----------
-- Default morning/evening windows per weekday, editable from the
-- Schedule > Settings sub-page. Closed days (Tuesday) carry no shifts.
create table shift_day_settings (
  day_of_week int primary key check (day_of_week between 0 and 6), -- 0=Sun...6=Sat
  label text not null,
  is_closed boolean not null default false,
  morning_start time,
  morning_end time,
  evening_start time,
  evening_end time
);

insert into shift_day_settings (day_of_week, label, is_closed, morning_start, morning_end, evening_start, evening_end) values
  (0, 'Sunday',    false, '13:00', '18:00', null,     null),
  (1, 'Monday',    false, '09:00', '15:00', '15:00',  '20:00'),
  (2, 'Tuesday',   true,  null,    null,    null,     null),
  (3, 'Wednesday', false, '09:00', '15:00', '15:00',  '20:00'),
  (4, 'Thursday',  false, '09:00', '15:00', '15:00',  '20:00'),
  (5, 'Friday',    false, '09:00', '15:00', '15:00',  '21:00'),
  (6, 'Saturday',  false, '10:00', '16:00', '16:00',  '21:00');

alter table shift_day_settings enable row level security;
create policy "staff read shift_day_settings" on shift_day_settings for select using (is_staff());
create policy "schedulers write shift_day_settings" on shift_day_settings for all
  using (can_schedule()) with check (can_schedule());

-- ---------- SCHEDULE SETTINGS (singleton) ----------
create table schedule_settings (
  id boolean primary key default true check (id),
  coverage_request_timeout_hours int not null default 48,
  email_template_coverage_request text not null default 'A shift needs coverage: {{shift_date}} {{period}}. Reply to claim it.',
  email_template_trade_confirm text not null default 'Your shift trade with {{other_name}} on {{shift_date}} is confirmed.',
  email_template_schedule_sent text not null default 'Your schedule for {{month}} is ready. View it here: {{link}}',
  updated_at timestamptz not null default now()
);
insert into schedule_settings (id) values (true);

create trigger schedule_settings_set_updated_at
  before update on schedule_settings
  for each row execute function set_updated_at();

alter table schedule_settings enable row level security;
create policy "staff read schedule_settings" on schedule_settings for select using (is_staff());
create policy "schedulers write schedule_settings" on schedule_settings for all
  using (can_schedule()) with check (can_schedule());

-- ---------- SHIFTS: add period ----------
-- 'morning'/'evening' for bartender rows; null for a manager-on-duty
-- row (MOD is a day-level assignment, not tied to a specific period).
alter table shifts add column if not exists period text check (period in ('morning','evening'));
