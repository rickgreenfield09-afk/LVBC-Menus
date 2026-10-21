-- ============================================================
-- Migration 045 — Paid memberships through Stripe
-- ============================================================
-- A member buys a plan in the member app (Stripe Embedded Checkout);
-- Stripe then tells api/stripe-webhook.js what happened and that
-- function calls membership_apply_subscription() below, which is the
-- only thing that moves members.tier_id because of a payment. The
-- existing members_evaluate_badges trigger (migration_040) then awards
-- the tier badge on its own.
--
--   * membership_plans — what is for sale: one row per tier + billing
--     interval (Mug Club annual, Mug Club monthly, ...). Prices live in
--     Stripe; price_cents here is only what the app displays, and
--     stripe_price_id is the link. A plan is shown to members only once
--     it is active AND has a stripe_price_id (scripts/stripe-sync-plans.mjs
--     creates the Stripe prices and fills that in).
--   * member_subscriptions — a copy of each Stripe subscription's state.
--   * members.stripe_customer_id — the member's Stripe customer.
--
-- Members can read their own subscription rows; nothing here is
-- writable from the browser. The webhook uses the service role key.
--
-- A member whose tier staff set by hand (a comp) is only touched when
-- one of their Stripe subscriptions changes.

-- ---------- MEMBERS ----------
alter table members
  add column stripe_customer_id text unique;

-- ---------- PLANS ----------
create table membership_plans (
  id               uuid primary key default gen_random_uuid(),
  tier_id          int  not null references tiers(id),
  billing_interval text not null check (billing_interval in ('year', 'month')),
  price_cents      int  not null check (price_cents > 0),
  stripe_price_id  text unique,
  -- bullet list shown on the plan card
  perks            text[] not null default '{}',
  sort_order       int  not null default 0,
  is_active        boolean not null default true,
  created_at       timestamptz not null default now(),
  unique (tier_id, billing_interval)
);

alter table membership_plans enable row level security;
create policy "public read sellable plans" on membership_plans for select
  using (is_active and stripe_price_id is not null);
create policy "staff manage plans" on membership_plans for all
  using (is_staff()) with check (is_staff());

-- ---------- SUBSCRIPTIONS ----------
create table member_subscriptions (
  id                     uuid primary key default gen_random_uuid(),
  member_id              uuid not null references members(id) on delete cascade,
  plan_id                uuid references membership_plans(id),
  stripe_subscription_id text not null unique,
  stripe_price_id        text,
  -- Stripe's own status: active, trialing, past_due, canceled, unpaid, ...
  status                 text not null,
  current_period_end     timestamptz,
  cancel_at_period_end   boolean not null default false,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);
create index member_subscriptions_member_idx on member_subscriptions (member_id);

alter table member_subscriptions enable row level security;
create policy "member reads own subscriptions" on member_subscriptions for select
  using (member_id = my_member_id());
create policy "staff read subscriptions" on member_subscriptions for select
  using (is_staff());

-- ---------- APPLY A SUBSCRIPTION ----------
-- Records the subscription's current state and sets the member's tier
-- from every subscription of theirs that still entitles them (active,
-- trialing, or past_due while Stripe retries the card): the highest-
-- ranked plan wins, and with none they go back to Free. Called by the
-- webhook with the service role; safe to call repeatedly.
-- Returns the member's tier id.
create or replace function membership_apply_subscription(
  p_member uuid,
  p_subscription_id text,
  p_price_id text,
  p_status text,
  p_period_end timestamptz,
  p_cancel_at_period_end boolean
) returns int as $$
declare
  v_plan uuid;
  v_tier int;
begin
  select id into v_plan from membership_plans where stripe_price_id = p_price_id;

  insert into member_subscriptions
    (member_id, plan_id, stripe_subscription_id, stripe_price_id, status, current_period_end, cancel_at_period_end)
  values
    (p_member, v_plan, p_subscription_id, p_price_id, p_status, p_period_end, p_cancel_at_period_end)
  on conflict (stripe_subscription_id) do update set
    plan_id = excluded.plan_id,
    stripe_price_id = excluded.stripe_price_id,
    status = excluded.status,
    current_period_end = excluded.current_period_end,
    cancel_at_period_end = excluded.cancel_at_period_end,
    updated_at = now();

  select p.tier_id into v_tier
  from member_subscriptions s
  join membership_plans p on p.id = s.plan_id
  join tiers t on t.id = p.tier_id
  where s.member_id = p_member and s.status in ('active', 'trialing', 'past_due')
  order by t.rank desc
  limit 1;

  if v_tier is null then
    select id into v_tier from tiers order by rank limit 1;
  end if;

  update members set tier_id = v_tier where id = p_member and tier_id is distinct from v_tier;
  return v_tier;
end;
$$ language plpgsql security definer set search_path = public;

revoke all on function membership_apply_subscription(uuid, text, text, text, timestamptz, boolean) from public, anon, authenticated;
grant execute on function membership_apply_subscription(uuid, text, text, text, timestamptz, boolean) to service_role;

-- ---------- SEED ----------
-- Mug Club: $200 a year or $20 a month. Each stays hidden from members
-- until scripts/stripe-sync-plans.mjs gives it a stripe_price_id. Add
-- the other plans (Coffee Club, Full Pour) as rows here when their
-- prices are decided.
insert into membership_plans (tier_id, billing_interval, price_cents, perks, sort_order)
select t.id, v.billing_interval, v.price_cents,
  array['Your own 22.5 oz mug', 'Free member-mug pour of every new beer on the tap wall', '15% off merch and to-go beer'],
  1
from tiers t
cross join (values ('year', 20000), ('month', 2000)) as v(billing_interval, price_cents)
where t.name = 'Mug Club';
