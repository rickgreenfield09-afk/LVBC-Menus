-- ============================================================
-- Migration 048 — Push notifications
-- ============================================================
-- Web push to the installed member app (/member/) and staff mobile app
-- (/mobile/). Staff compose and send from Marketing > Push.
--
--   * push_subscriptions — one row per browser/device that opted in.
--     audience says which app it came from ('member' or 'staff'); the
--     member_id / staff_id column says who. Written only by
--     api/push-subscribe.js (service role); a person can read their own.
--   * push_notifications — a log of what was sent, for the history list.
--     Written by api/send-push.js (service role); staff can read it.
--
-- Members are only pushed when their comms_opt_in master toggle is on.

create table push_subscriptions (
  id          uuid primary key default gen_random_uuid(),
  endpoint    text not null unique,
  p256dh      text not null,
  auth        text not null,
  audience    text not null check (audience in ('member', 'staff')),
  member_id   uuid references members(id) on delete cascade,
  staff_id    uuid references staff_profiles(id) on delete cascade,
  user_agent  text,
  created_at  timestamptz not null default now(),
  check ((audience = 'member' and member_id is not null) or (audience = 'staff' and staff_id is not null))
);
create index push_subscriptions_audience_idx on push_subscriptions (audience);

alter table push_subscriptions enable row level security;
create policy "staff read push_subscriptions" on push_subscriptions for select using (is_staff());
create policy "member reads own push_subscriptions" on push_subscriptions for select using (member_id = my_member_id());

create table push_notifications (
  id            uuid primary key default gen_random_uuid(),
  title         text not null,
  body          text not null,
  url           text,
  audience      text not null check (audience in ('members', 'staff', 'both')),
  sent_count    int not null default 0,
  failed_count  int not null default 0,
  sent_by       uuid references staff_profiles(id) on delete set null,
  created_at    timestamptz not null default now()
);

alter table push_notifications enable row level security;
create policy "staff read push_notifications" on push_notifications for select using (is_staff());
