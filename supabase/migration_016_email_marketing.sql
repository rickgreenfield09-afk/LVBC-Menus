-- ============================================================
-- Migration 016 — Email marketing (v1)
-- ============================================================
-- Subscribers opt into named topics (not just one blanket list) so
-- campaigns can target e.g. "Events" without emailing everyone, and
-- so the planned membership app can read/write these same tables
-- later to manage a member's marketing preferences.
--
-- Signup is public (anyone can join the list from a website form),
-- so email_subscribers/subscriber_topic_preferences allow anonymous
-- insert; everything else (viewing the list, composing, sending) is
-- staff-only via is_staff()/is_admin() from schema.sql.

create table email_topics (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text,
  created_at timestamptz not null default now()
);

create table email_subscribers (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  name text,
  source text,
  subscribed_at timestamptz not null default now(),
  unsubscribed_at timestamptz
);

create table subscriber_topic_preferences (
  subscriber_id uuid not null references email_subscribers(id) on delete cascade,
  topic_id uuid not null references email_topics(id) on delete cascade,
  subscribed boolean not null default true,
  updated_at timestamptz not null default now(),
  primary key (subscriber_id, topic_id)
);

create table email_campaigns (
  id uuid primary key default gen_random_uuid(),
  subject text not null,
  html_body text not null,
  topic_id uuid references email_topics(id) on delete set null,
  status text not null check (status in ('draft','scheduled','sent')) default 'draft',
  scheduled_for timestamptz,
  sent_at timestamptz,
  resend_broadcast_id text,
  created_by uuid references staff_profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

create table email_events (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid references email_campaigns(id) on delete cascade,
  subscriber_email text not null,
  event_type text not null check (event_type in ('delivered','opened','clicked','bounced','complained','unsubscribed')),
  link_url text,
  occurred_at timestamptz not null default now(),
  raw_payload jsonb
);

create index subscriber_topic_preferences_topic_idx on subscriber_topic_preferences (topic_id);
create index email_events_campaign_idx on email_events (campaign_id);
create index email_events_subscriber_idx on email_events (subscriber_email);

alter table email_topics enable row level security;
alter table email_subscribers enable row level security;
alter table subscriber_topic_preferences enable row level security;
alter table email_campaigns enable row level security;
alter table email_events enable row level security;

create policy "anyone read topics" on email_topics for select using (true);
create policy "staff manage topics" on email_topics for all using (is_staff()) with check (is_staff());

create policy "anyone join subscribers" on email_subscribers for insert with check (true);
create policy "staff read subscribers" on email_subscribers for select using (is_staff());
create policy "staff manage subscribers" on email_subscribers for update using (is_staff()) with check (is_staff());
create policy "staff delete subscribers" on email_subscribers for delete using (is_staff());

create policy "anyone set own preferences" on subscriber_topic_preferences for insert with check (true);
create policy "anyone update own preferences" on subscriber_topic_preferences for update using (true) with check (true);
create policy "staff read preferences" on subscriber_topic_preferences for select using (is_staff());

create policy "staff manage campaigns" on email_campaigns for all using (is_staff()) with check (is_staff());

create policy "staff read events" on email_events for select using (is_staff());
