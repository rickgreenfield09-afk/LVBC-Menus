-- ============================================================
-- Migration 041 — Demo members (carried over from the first staff panel)
-- ============================================================
-- The 17 test members from lvbc-staff-panel and their history, so
-- the Members screens have something to show: 91 check-ins,
-- 98 ledger lines, 8 free pours and 9 earned badges.
-- All of it is made-up test data (email.com addresses, 555 numbers).
-- Run after migration_040. Skip this file on a real launch.
--
-- Left behind on purpose: kiosk PINs, the two profile photos (they
-- were multi-megabyte data: URIs stored in the row), and the
-- member-app columns this panel doesn't use (taste_profile, comms_*).
--
-- member_number keeps each member's old id, so the "table #" staff
-- already know still works; old QR tokens are kept for the same
-- reason. Dates are the original ones.
--
-- Free pours point at the old tap list. A pour is kept as a
-- free_pours row only if a beer of the same name is on the current
-- list; every one of them lands in the beer journal either way.
--
-- Balances are the old stored balances, not a re-sum of the ledger —
-- the old panel's test data never added up.

insert into members (member_number, name, email, phone, birthday, tier_id, points_balance, points_earned_lifetime, is_active, joined_at) values
  (1, 'Jake Morales', 'jake.morales@email.com', '512-555-0101', '1988-03-22', (select id from tiers where name = 'Mug Club'), 1710, 4320, true, '2025-08-15T18:00:00+00:00'),
  (2, 'Sarah Finch', 'sarah.finch@email.com', '512-555-0102', '1992-07-14', (select id from tiers where name = 'Coffee Club'), 645, 1485, true, '2025-09-01T10:30:00+00:00'),
  (3, 'Marcus Webb', 'marcus.webb@email.com', '512-555-0103', '1985-11-03', (select id from tiers where name = 'Full Pour'), 2750, 6100, true, '2025-08-15T18:00:00+00:00'),
  (4, 'Denise Okafor', 'denise.okafor@email.com', '512-555-0104', '1990-05-30', (select id from tiers where name = 'Mug Club'), 320, 980, true, '2025-10-12T19:00:00+00:00'),
  (5, 'Tyler Krueger', 'tyler.krueger@email.com', '512-555-0105', '1996-01-18', (select id from tiers where name = 'Free'), 150, 475, true, '2025-11-03T20:00:00+00:00'),
  (6, 'Amber Reyes', 'amber.reyes@email.com', '512-555-0106', '1993-08-25', (select id from tiers where name = 'Coffee Club'), 410, 1150, true, '2025-09-20T09:00:00+00:00'),
  (7, 'Brett Callahan', 'brett.callahan@email.com', '512-555-0107', '1987-12-09', (select id from tiers where name = 'Mug Club'), 875, 2640, true, '2025-08-15T18:00:00+00:00'),
  (8, 'Priya Nair', 'priya.nair@email.com', '512-555-0108', '1998-04-11', (select id from tiers where name = 'Free'), 90, 290, true, '2025-12-01T17:00:00+00:00'),
  (9, 'Cody Stanton', 'cody.stanton@email.com', '512-555-0109', '1983-09-27', (select id from tiers where name = 'Full Pour'), 3200, 7400, true, '2025-08-15T18:00:00+00:00'),
  (10, 'Luz Herrera', 'luz.herrera@email.com', '512-555-0110', '1991-02-14', (select id from tiers where name = 'Mug Club'), 560, 1780, true, '2025-09-10T18:30:00+00:00'),
  (11, 'Owen Park', 'owen.park@email.com', '512-555-0111', '1995-06-07', (select id from tiers where name = 'Free'), 200, 610, true, '2025-11-20T19:30:00+00:00'),
  (12, 'Nina Castellano', 'nina.castellano@email.com', '512-555-0112', '1989-10-31', (select id from tiers where name = 'Coffee Club'), 730, 1890, true, '2025-08-15T18:00:00+00:00'),
  (13, 'Derek Simms', 'derek.simms@email.com', '512-555-0113', '1986-03-16', (select id from tiers where name = 'Mug Club'), 440, 1360, true, '2025-10-05T20:00:00+00:00'),
  (14, 'Tasha Goodwin', 'tasha.goodwin@email.com', '512-555-0114', '1984-07-22', (select id from tiers where name = 'Mug Club'), 1675, 4225, true, '2025-08-15T18:00:00+00:00'),
  (15, 'Ryan Flores', 'ryan.flores@email.com', '512-555-0115', '1999-12-03', (select id from tiers where name = 'Free'), 60, 180, true, '2026-01-10T18:00:00+00:00'),
  (16, 'Tait Ralston', 'tait@email.com', null, '1959-04-22', (select id from tiers where name = 'Mug Club'), 65, 65, true, '2026-04-22T21:21:12.969+00:00'),
  (20, 'Amanda Greenfield', 'amanda@email.com', null, '1987-08-11', (select id from tiers where name = 'Mug Club'), 1225, 1225, true, '2026-01-29T19:36:12.341175+00:00');

select setval(pg_get_serial_sequence('members', 'member_number'), (select max(member_number) from members));

-- the insert trigger gave each member a fresh token; put the old ones back
update qr_tokens q set token = v.token
from (values
  (1, 'lvbc-tok-j4k3m0r4l3s-a1b2'),
  (2, 'lvbc-tok-s4r4hf1nch-c3d4'),
  (3, 'lvbc-tok-m4rcusw3bb-e5f6'),
  (4, 'lvbc-tok-d3n1s3ok4f-g7h8'),
  (5, 'lvbc-tok-tylrkrug3r-i9j0'),
  (6, 'lvbc-tok-4mb3rr3y3s-k1l2'),
  (7, 'lvbc-tok-br3ttc4ll-m3n4'),
  (8, 'lvbc-tok-pr1y4n41r-o5p6'),
  (9, 'lvbc-tok-c0dyst4nt-q7r8'),
  (10, 'lvbc-tok-luzh3rr3r-s9t0'),
  (11, 'lvbc-tok-0w3np4rkk-u1v2'),
  (12, 'lvbc-tok-n1n4c4st-w3x4'),
  (13, 'lvbc-tok-d3r3ks1mm-y5z6'),
  (14, 'lvbc-tok-t4sh4g00d-a7b8'),
  (15, 'lvbc-tok-ry4nfl0r3-c9d0'),
  (1, 'LVBC-d27d5399-f3e9-4e35-a3fd-f1a5e8a1546c'),
  (20, 'AMANDA-aca843ff-4d13-4757-8d6f-998acbf26ec0')
) as v(member_number, token)
join members m on m.member_number = v.member_number
where q.member_id = m.id;

insert into check_ins (member_id, checked_in_at, kind, new_release_poured, free_pour_beer, points_awarded)
select m.id, v.at::timestamptz, v.kind, v.poured, v.beer, v.pts
from (values
  (1, '2025-08-15T18:30:00+00:00', 'standard', false, null, 50),
  (1, '2025-08-20T19:00:00+00:00', 'standard', false, null, 15),
  (1, '2025-08-27T19:30:00+00:00', 'standard', true, null, 15),
  (1, '2025-09-03T18:00:00+00:00', 'standard', false, null, 25),
  (1, '2025-09-10T19:00:00+00:00', 'standard', false, null, 15),
  (2, '2025-09-01T10:45:00+00:00', 'standard', false, null, 50),
  (2, '2025-09-08T09:30:00+00:00', 'standard', false, null, 15),
  (2, '2025-09-15T10:00:00+00:00', 'standard', false, null, 15),
  (2, '2025-09-22T09:45:00+00:00', 'standard', false, null, 25),
  (3, '2025-08-15T18:30:00+00:00', 'standard', true, null, 50),
  (3, '2025-08-20T19:00:00+00:00', 'standard', false, null, 25),
  (3, '2025-08-27T20:00:00+00:00', 'standard', true, null, 15),
  (3, '2025-09-03T19:30:00+00:00', 'standard', false, null, 15),
  (3, '2025-09-10T18:00:00+00:00', 'standard', false, null, 25),
  (3, '2025-09-17T19:00:00+00:00', 'standard', false, null, 15),
  (4, '2025-10-12T19:30:00+00:00', 'standard', false, null, 50),
  (4, '2025-10-15T20:00:00+00:00', 'standard', false, null, 15),
  (4, '2025-10-22T19:00:00+00:00', 'standard', false, null, 25),
  (4, '2025-10-29T19:30:00+00:00', 'standard', false, null, 15),
  (5, '2025-11-03T20:30:00+00:00', 'standard', false, null, 50),
  (5, '2025-11-10T19:00:00+00:00', 'standard', false, null, 15),
  (5, '2025-11-19T20:00:00+00:00', 'standard', false, null, 25),
  (6, '2025-09-20T09:15:00+00:00', 'standard', false, null, 50),
  (6, '2025-09-24T09:00:00+00:00', 'standard', false, null, 15),
  (6, '2025-10-01T10:00:00+00:00', 'standard', false, null, 15),
  (7, '2025-08-15T18:30:00+00:00', 'standard', true, null, 50),
  (7, '2025-08-20T19:00:00+00:00', 'standard', false, null, 25),
  (7, '2025-08-27T19:00:00+00:00', 'standard', false, null, 15),
  (7, '2025-09-03T18:30:00+00:00', 'standard', false, null, 15),
  (7, '2025-09-10T19:00:00+00:00', 'standard', true, null, 15),
  (8, '2025-12-01T17:30:00+00:00', 'standard', false, null, 50),
  (8, '2025-12-08T18:00:00+00:00', 'standard', false, null, 15),
  (9, '2025-08-15T18:30:00+00:00', 'standard', true, null, 50),
  (9, '2025-08-20T19:30:00+00:00', 'standard', false, null, 25),
  (9, '2025-08-27T20:00:00+00:00', 'standard', false, null, 15),
  (9, '2025-09-03T19:00:00+00:00', 'standard', true, null, 15),
  (9, '2025-09-10T18:30:00+00:00', 'standard', false, null, 25),
  (9, '2025-09-17T19:00:00+00:00', 'standard', false, null, 15),
  (9, '2025-09-24T18:00:00+00:00', 'standard', false, null, 15),
  (10, '2025-09-10T18:45:00+00:00', 'standard', false, null, 50),
  (10, '2025-09-17T19:00:00+00:00', 'standard', false, null, 15),
  (10, '2025-09-24T19:30:00+00:00', 'standard', false, null, 25),
  (10, '2025-10-01T18:00:00+00:00', 'standard', false, null, 15),
  (11, '2025-11-20T19:45:00+00:00', 'standard', false, null, 50),
  (11, '2025-11-26T20:00:00+00:00', 'standard', false, null, 15),
  (11, '2025-12-03T19:00:00+00:00', 'standard', false, null, 25),
  (12, '2025-08-15T18:30:00+00:00', 'standard', false, null, 50),
  (12, '2025-08-22T09:00:00+00:00', 'standard', false, null, 15),
  (12, '2025-09-05T09:30:00+00:00', 'standard', false, null, 25),
  (13, '2025-10-05T20:15:00+00:00', 'standard', false, null, 50),
  (13, '2025-10-12T19:30:00+00:00', 'standard', false, null, 15),
  (13, '2025-10-22T20:00:00+00:00', 'standard', false, null, 25),
  (14, '2025-08-15T18:30:00+00:00', 'standard', true, null, 50),
  (14, '2025-08-20T19:00:00+00:00', 'standard', false, null, 25),
  (14, '2025-08-27T19:30:00+00:00', 'standard', false, null, 15),
  (14, '2025-09-03T18:00:00+00:00', 'standard', true, null, 15),
  (14, '2025-09-10T19:00:00+00:00', 'standard', false, null, 25),
  (14, '2025-09-17T18:30:00+00:00', 'standard', false, null, 15),
  (15, '2026-01-10T18:30:00+00:00', 'standard', false, null, 50),
  (15, '2026-01-17T19:00:00+00:00', 'standard', false, null, 15),
  (1, '2026-04-21T21:43:40.355+00:00', 'standard', true, null, 15),
  (1, '2026-04-22T04:37:56.453+00:00', 'standard', false, null, 15),
  (1, '2026-04-22T19:12:58.017+00:00', 'standard', false, null, 15),
  (2, '2026-04-22T19:14:14.364+00:00', 'standard', false, null, 15),
  (1, '2026-04-22T19:15:22.813+00:00', 'standard', false, null, 15),
  (1, '2026-04-22T20:28:33.316+00:00', 'standard', false, null, 25),
  (1, '2026-04-22T20:51:11.915+00:00', 'standard', false, null, 25),
  (14, '2026-04-22T21:17:15.438+00:00', 'standard', false, null, 25),
  (1, '2026-04-22T21:22:19.381+00:00', 'standard', false, null, 25),
  (16, '2026-04-22T21:29:01.401+00:00', 'standard', false, null, 50),
  (1, '2026-04-23T20:53:02.29+00:00', 'standard', false, null, 25),
  (1, '2026-04-23T21:59:08.341+00:00', 'standard', false, null, 25),
  (2, '2026-04-23T22:01:01.172+00:00', 'standard', false, null, 25),
  (1, '2026-04-24T16:53:27.039+00:00', 'standard', false, null, 15),
  (16, '2026-04-24T17:06:05.755+00:00', 'dd', false, null, 15),
  (1, '2026-04-24T23:09:39.589+00:00', 'standard', false, null, 15),
  (20, '2026-02-04T19:36:12.341175+00:00', 'standard', false, null, 25),
  (20, '2026-02-25T19:36:12.341175+00:00', 'standard', false, null, 25),
  (20, '2026-03-18T19:36:12.341175+00:00', 'standard', false, null, 25),
  (20, '2026-04-15T19:36:12.341175+00:00', 'standard', false, null, 25),
  (20, '2026-03-05T19:36:12.341175+00:00', 'standard', false, null, 30),
  (20, '2026-04-01T19:36:12.341175+00:00', 'standard', false, null, 30),
  (20, '2026-04-29T20:06:46.784+00:00', 'standard', false, null, 25),
  (2, '2026-04-30T22:40:02.046+00:00', 'standard', false, null, 25),
  (1, '2026-05-10T03:41:52.53+00:00', 'standard', false, null, 15),
  (1, '2026-05-10T03:43:50.474+00:00', 'standard', false, null, 15),
  (1, '2026-05-13T16:04:15.435+00:00', 'standard', false, null, 25),
  (1, '2026-06-05T04:25:38.893+00:00', 'standard', false, null, 25),
  (1, '2026-07-23T19:41:54.714+00:00', 'standard', false, null, 25),
  (1, '2026-07-23T20:36:14.285+00:00', 'standard', false, null, 25),
  (1, '2026-08-21T16:45:38.255+00:00', 'standard', false, null, 15)
) as v(member_number, at, kind, poured, beer, pts)
join members m on m.member_number = v.member_number;

insert into points_transactions (member_id, transaction_type, points, notes, processed_by, created_at)
select m.id, v.type, v.pts, v.notes, v.by, v.at::timestamptz
from (values
  (3, 'checkin_standard', 15, null, null, '2026-04-19T19:29:19.5062+00:00'),
  (4, 'checkin_standard', 15, null, null, '2026-04-19T19:29:19.5062+00:00'),
  (5, 'checkin_standard', 15, null, null, '2026-04-19T19:29:19.5062+00:00'),
  (6, 'checkin_standard', 15, null, null, '2026-04-19T19:29:19.5062+00:00'),
  (7, 'checkin_standard', 15, null, null, '2026-04-19T19:29:19.5062+00:00'),
  (8, 'checkin_standard', 15, null, null, '2026-04-19T19:29:19.5062+00:00'),
  (9, 'checkin_standard', 15, null, null, '2026-04-19T19:29:19.5062+00:00'),
  (10, 'checkin_standard', 15, null, null, '2026-04-19T19:29:19.5062+00:00'),
  (11, 'checkin_standard', 15, null, null, '2026-04-19T19:29:19.5062+00:00'),
  (12, 'checkin_standard', 15, null, null, '2026-04-19T19:29:19.5062+00:00'),
  (13, 'checkin_standard', 15, null, null, '2026-04-19T19:29:19.5062+00:00'),
  (14, 'checkin_standard', 15, null, null, '2026-04-19T19:29:19.5062+00:00'),
  (15, 'checkin_standard', 15, null, null, '2026-04-19T19:29:19.5062+00:00'),
  (2, 'checkin_standard', 15, null, null, '2026-04-19T19:29:19.5062+00:00'),
  (1, 'checkin_standard', 15, null, null, '2026-04-19T19:29:19.5062+00:00'),
  (3, 'checkin_thursday', 25, null, null, '2026-04-16T19:29:19.5062+00:00'),
  (4, 'checkin_thursday', 25, null, null, '2026-04-16T19:29:19.5062+00:00'),
  (5, 'checkin_thursday', 25, null, null, '2026-04-16T19:29:19.5062+00:00'),
  (6, 'checkin_thursday', 25, null, null, '2026-04-16T19:29:19.5062+00:00'),
  (7, 'checkin_thursday', 25, null, null, '2026-04-16T19:29:19.5062+00:00'),
  (8, 'checkin_thursday', 25, null, null, '2026-04-16T19:29:19.5062+00:00'),
  (9, 'checkin_thursday', 25, null, null, '2026-04-16T19:29:19.5062+00:00'),
  (10, 'checkin_thursday', 25, null, null, '2026-04-16T19:29:19.5062+00:00'),
  (11, 'checkin_thursday', 25, null, null, '2026-04-16T19:29:19.5062+00:00'),
  (12, 'checkin_thursday', 25, null, null, '2026-04-16T19:29:19.5062+00:00'),
  (13, 'checkin_thursday', 25, null, null, '2026-04-16T19:29:19.5062+00:00'),
  (14, 'checkin_thursday', 25, null, null, '2026-04-16T19:29:19.5062+00:00'),
  (15, 'checkin_thursday', 25, null, null, '2026-04-16T19:29:19.5062+00:00'),
  (2, 'checkin_thursday', 25, null, null, '2026-04-16T19:29:19.5062+00:00'),
  (1, 'checkin_thursday', 25, null, null, '2026-04-16T19:29:19.5062+00:00'),
  (3, 'checkin_wednesday', 25, null, null, '2026-04-09T19:29:19.5062+00:00'),
  (4, 'checkin_wednesday', 25, null, null, '2026-04-09T19:29:19.5062+00:00'),
  (5, 'checkin_wednesday', 25, null, null, '2026-04-09T19:29:19.5062+00:00'),
  (6, 'checkin_wednesday', 25, null, null, '2026-04-09T19:29:19.5062+00:00'),
  (7, 'checkin_wednesday', 25, null, null, '2026-04-09T19:29:19.5062+00:00'),
  (8, 'checkin_wednesday', 25, null, null, '2026-04-09T19:29:19.5062+00:00'),
  (9, 'checkin_wednesday', 25, null, null, '2026-04-09T19:29:19.5062+00:00'),
  (10, 'checkin_wednesday', 25, null, null, '2026-04-09T19:29:19.5062+00:00'),
  (11, 'checkin_wednesday', 25, null, null, '2026-04-09T19:29:19.5062+00:00'),
  (12, 'checkin_wednesday', 25, null, null, '2026-04-09T19:29:19.5062+00:00'),
  (13, 'checkin_wednesday', 25, null, null, '2026-04-09T19:29:19.5062+00:00'),
  (14, 'checkin_wednesday', 25, null, null, '2026-04-09T19:29:19.5062+00:00'),
  (15, 'checkin_wednesday', 25, null, null, '2026-04-09T19:29:19.5062+00:00'),
  (2, 'checkin_wednesday', 25, null, null, '2026-04-09T19:29:19.5062+00:00'),
  (1, 'checkin_wednesday', 25, null, null, '2026-04-09T19:29:19.5062+00:00'),
  (3, 'event_attendance', 30, 'Music Bingo', null, '2026-04-16T19:29:19.5062+00:00'),
  (4, 'event_attendance', 30, 'Music Bingo', null, '2026-04-16T19:29:19.5062+00:00'),
  (5, 'event_attendance', 30, 'Music Bingo', null, '2026-04-16T19:29:19.5062+00:00'),
  (6, 'event_attendance', 30, 'Music Bingo', null, '2026-04-16T19:29:19.5062+00:00'),
  (7, 'event_attendance', 30, 'Music Bingo', null, '2026-04-16T19:29:19.5062+00:00'),
  (8, 'event_attendance', 30, 'Music Bingo', null, '2026-04-16T19:29:19.5062+00:00'),
  (9, 'event_attendance', 30, 'Music Bingo', null, '2026-04-16T19:29:19.5062+00:00'),
  (10, 'event_attendance', 30, 'Music Bingo', null, '2026-04-16T19:29:19.5062+00:00'),
  (11, 'event_attendance', 30, 'Music Bingo', null, '2026-04-16T19:29:19.5062+00:00'),
  (12, 'event_attendance', 30, 'Music Bingo', null, '2026-04-16T19:29:19.5062+00:00'),
  (13, 'event_attendance', 30, 'Music Bingo', null, '2026-04-16T19:29:19.5062+00:00'),
  (14, 'event_attendance', 30, 'Music Bingo', null, '2026-04-16T19:29:19.5062+00:00'),
  (15, 'event_attendance', 30, 'Music Bingo', null, '2026-04-16T19:29:19.5062+00:00'),
  (2, 'event_attendance', 30, 'Music Bingo', null, '2026-04-16T19:29:19.5062+00:00'),
  (1, 'event_attendance', 30, 'Music Bingo', null, '2026-04-16T19:29:19.5062+00:00'),
  (3, 'checkin_standard', 15, null, null, '2026-04-12T19:29:19.5062+00:00'),
  (4, 'checkin_standard', 15, null, null, '2026-04-12T19:29:19.5062+00:00'),
  (5, 'checkin_standard', 15, null, null, '2026-04-12T19:29:19.5062+00:00'),
  (6, 'checkin_standard', 15, null, null, '2026-04-12T19:29:19.5062+00:00'),
  (7, 'checkin_standard', 15, null, null, '2026-04-12T19:29:19.5062+00:00'),
  (8, 'checkin_standard', 15, null, null, '2026-04-12T19:29:19.5062+00:00'),
  (9, 'checkin_standard', 15, null, null, '2026-04-12T19:29:19.5062+00:00'),
  (10, 'checkin_standard', 15, null, null, '2026-04-12T19:29:19.5062+00:00'),
  (11, 'checkin_standard', 15, null, null, '2026-04-12T19:29:19.5062+00:00'),
  (12, 'checkin_standard', 15, null, null, '2026-04-12T19:29:19.5062+00:00'),
  (13, 'checkin_standard', 15, null, null, '2026-04-12T19:29:19.5062+00:00'),
  (14, 'checkin_standard', 15, null, null, '2026-04-12T19:29:19.5062+00:00'),
  (15, 'checkin_standard', 15, null, null, '2026-04-12T19:29:19.5062+00:00'),
  (2, 'checkin_standard', 15, null, null, '2026-04-12T19:29:19.5062+00:00'),
  (1, 'checkin_standard', 15, null, null, '2026-04-12T19:29:19.5062+00:00'),
  (1, 'event_win_bingo', 25, 'Bingo round 2 winner', 'Tait', '2026-04-16T19:29:28.531722+00:00'),
  (2, 'checkin_dd', 15, 'Designated driver', null, '2026-04-19T19:29:28.531722+00:00'),
  (1, 'event_win_trivia_overall', 50, 'Trivia night overall winner', 'Tait', '2026-04-12T19:29:28.531722+00:00'),
  (1, 'checkin_wednesday', 25, null, null, '2026-04-22T20:28:33.602562+00:00'),
  (1, 'checkin_wednesday', 25, null, null, '2026-04-22T20:51:12.142975+00:00'),
  (14, 'checkin_wednesday', 25, null, null, '2026-04-22T21:17:15.673933+00:00'),
  (1, 'checkin_wednesday', 25, null, null, '2026-04-22T21:22:19.541302+00:00'),
  (16, 'checkin_first_visit', 50, null, null, '2026-04-22T21:29:01.66994+00:00'),
  (1, 'checkin_thursday', 25, null, null, '2026-04-23T20:53:02.569789+00:00'),
  (1, 'checkin_thursday', 25, null, null, '2026-04-23T21:59:08.60272+00:00'),
  (2, 'checkin_thursday', 25, null, null, '2026-04-23T22:01:01.333011+00:00'),
  (1, 'checkin_standard', 15, null, null, '2026-04-24T16:53:27.360011+00:00'),
  (16, 'checkin_dd', 15, 'Designated driver', null, '2026-04-24T17:06:06.017527+00:00'),
  (1, 'checkin_standard', 15, null, null, '2026-04-24T23:09:39.819807+00:00'),
  (20, 'checkin_wednesday', 25, null, null, '2026-04-29T20:06:47.145826+00:00'),
  (2, 'checkin_thursday', 25, null, null, '2026-04-30T22:40:02.462692+00:00'),
  (1, 'checkin_standard', 15, null, null, '2026-05-10T03:41:52.703761+00:00'),
  (1, 'checkin_standard', 15, null, null, '2026-05-10T03:43:50.698855+00:00'),
  (1, 'checkin_wednesday', 25, null, null, '2026-05-13T16:04:15.823805+00:00'),
  (1, 'checkin_thursday', 25, null, null, '2026-06-05T04:25:39.048377+00:00'),
  (1, 'checkin_thursday', 25, null, null, '2026-07-23T19:41:55.102425+00:00'),
  (1, 'checkin_thursday', 25, null, null, '2026-07-23T20:36:14.498348+00:00'),
  (1, 'checkin_standard', 15, null, null, '2026-08-21T16:45:38.566884+00:00')
) as v(member_number, type, pts, notes, by, at)
join members m on m.member_number = v.member_number;

insert into member_beers (member_id, beer_id, beer_name, beer_style, tried_at)
select m.id, b.id, v.name, v.style, v.at::timestamptz
from (values
  (1, 'MMM Berliner', 'Berliner Weisse', '2026-04-21T21:41:30.936+00:00'),
  (1, 'Double Quad Dare', 'Belgian Quad', '2026-04-21T21:43:40.355+00:00'),
  (4, 'MMM Berliner', 'Berliner Weisse', '2026-04-22T19:30:03.755+00:00'),
  (14, 'MMM Berliner', 'Berliner Weisse', '2026-04-22T21:17:15.293+00:00'),
  (16, 'Double Quad Dare', 'Belgian Quad', '2026-04-22T21:29:01.273+00:00'),
  (2, 'MMM Berliner', 'Berliner Weisse', '2026-04-23T22:01:01.043+00:00'),
  (20, 'MMM Berliner', 'Berliner Weisse', '2026-04-29T20:06:46.595+00:00'),
  (2, 'Double Quad Dare', 'Belgian Quad', '2026-04-30T22:40:01.786+00:00')
) as v(member_number, name, style, at)
join members m on m.member_number = v.member_number
left join beers b on lower(b.name) = lower(v.name);

insert into free_pours (member_id, beer_id, poured_at)
select m.id, b.id, v.at::timestamptz
from (values
  (1, 'MMM Berliner', 'Berliner Weisse', '2026-04-21T21:41:30.936+00:00'),
  (1, 'Double Quad Dare', 'Belgian Quad', '2026-04-21T21:43:40.355+00:00'),
  (4, 'MMM Berliner', 'Berliner Weisse', '2026-04-22T19:30:03.755+00:00'),
  (14, 'MMM Berliner', 'Berliner Weisse', '2026-04-22T21:17:15.293+00:00'),
  (16, 'Double Quad Dare', 'Belgian Quad', '2026-04-22T21:29:01.273+00:00'),
  (2, 'MMM Berliner', 'Berliner Weisse', '2026-04-23T22:01:01.043+00:00'),
  (20, 'MMM Berliner', 'Berliner Weisse', '2026-04-29T20:06:46.595+00:00'),
  (2, 'Double Quad Dare', 'Belgian Quad', '2026-04-30T22:40:01.786+00:00')
) as v(member_number, name, style, at)
join members m on m.member_number = v.member_number
join beers b on lower(b.name) = lower(v.name);

insert into member_badges (member_id, badge_id, earned_at)
select m.id, b.id, v.at::timestamptz
from (values
  (1, 'Hop Head', '2026-04-15T16:15:03.158177+00:00'),
  (1, 'Dark Side', '2026-04-08T16:15:03.158177+00:00'),
  (1, 'Lager Loyalist', '2026-04-01T16:15:03.158177+00:00'),
  (1, 'Sour Power', '2026-03-25T16:15:03.158177+00:00'),
  (1, 'Spring Sipper', '2026-03-18T16:15:03.158177+00:00'),
  (1, 'Fall Faithful', '2026-03-11T16:15:03.158177+00:00'),
  (20, 'Hop Head', '2026-03-10T19:36:12.341175+00:00'),
  (20, 'Winter Warmer', '2026-02-23T19:36:12.341175+00:00'),
  (20, 'Spring Sipper', '2026-04-19T19:36:12.341175+00:00')
) as v(member_number, badge, at)
join members m on m.member_number = v.member_number
join badges b on b.name = v.badge
on conflict (member_id, badge_id) do update set earned_at = excluded.earned_at;

-- anything the history has earned that the old panel never awarded
select count(*) as members_evaluated from (select _evaluate_member_badges(id) from members) x;
