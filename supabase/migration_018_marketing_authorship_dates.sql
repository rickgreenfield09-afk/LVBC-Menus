-- ============================================================
-- Migration 018 — Capture topic authorship + campaign run dates
-- ============================================================

alter table email_topics add column created_by uuid references staff_profiles(id) on delete set null;

-- The real-world period a campaign is promoting/running for — distinct
-- from scheduled_for/sent_at, which are about when the EMAIL itself
-- goes out, not how long the promotion it's about actually runs.
alter table email_campaigns add column starts_at date;
alter table email_campaigns add column ends_at date;
