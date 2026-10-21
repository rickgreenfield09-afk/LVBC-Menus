-- ============================================================
-- Migration 046 — Store: one-off events and merch pre-orders
-- ============================================================
-- Things sold once rather than by subscription: a ticketed event, a
-- Maifest stein pre-order, a sports outing. Staff build the catalog in
-- the Payments screen; the catalog lives here, NOT in Stripe. Stripe is
-- only asked to charge at checkout (api/store-checkout.js passes the
-- price inline), so nothing has to be created in the Stripe dashboard.
--
--   * store_items — what is for sale: name, price, whether sales tax
--     applies, an optional quantity cap and sales-close time, and for
--     events a date. Anyone can read active items.
--   * store_orders — one row per purchase. quantity is the number of
--     people (events) or units (merch): 4 tickets for 4 people is one
--     order with quantity 4. fulfilled_qty counts how many have been
--     admitted / handed over. ticket_token is what the ticket QR code
--     carries.
--   * store_settings — the sales tax rate, and the Stripe tax-rate
--     object made from it (created on first use).
--   * tiers.merch_discount_pct — the member discount on merch.
--
-- Selling out: stock is held when checkout starts (a 'pending' order
-- holds its quantity for 35 minutes) and kept once paid, all counted by
-- store_item_sold(). store_reserve_order() locks the item row while it
-- checks, so two people can't both take the last one.
--
-- Nothing writes an order from the browser. api/store-checkout.js and
-- api/stripe-webhook.js use the service role; staff go through
-- store_record_toast_sale(), store_redeem() and store_set_order_status().
-- Members can read their own orders.

-- ---------- TIERS ----------
alter table tiers
  add column merch_discount_pct int not null default 0 check (merch_discount_pct between 0 and 100);
update tiers set merch_discount_pct = 15 where name in ('Mug Club', 'Full Pour');

-- ---------- SETTINGS ----------
create table store_settings (
  id                      int primary key default 1 check (id = 1),
  -- combined state + local rate, as a fraction (0.0825 = 8.25%)
  sales_tax_rate          numeric(6,5) not null default 0.0825 check (sales_tax_rate >= 0 and sales_tax_rate < 1),
  stripe_tax_rate_id      text,
  -- the percentage the cached Stripe tax rate was made for
  stripe_tax_rate_percent numeric(7,3)
);
insert into store_settings (id) values (1);

alter table store_settings enable row level security;
create policy "staff read store_settings" on store_settings for select using (is_staff());
create policy "admin update store_settings" on store_settings for update
  using (is_admin()) with check (is_admin());

-- ---------- ITEMS ----------
create table store_items (
  id              uuid primary key default gen_random_uuid(),
  kind            text not null check (kind in ('event', 'merch')),
  name            text not null,
  description     text,
  price_cents     int  not null check (price_cents > 0),
  taxable         boolean not null default false,
  -- null = unlimited
  quantity_limit  int  check (quantity_limit > 0),
  max_per_order   int  not null default 10 check (max_per_order > 0),
  event_at        timestamptz,
  -- where and when to collect it (merch) or arrive (events)
  pickup_notes    text,
  sales_close_at  timestamptz,
  is_active       boolean not null default true,
  created_at      timestamptz not null default now()
);

alter table store_items enable row level security;
create policy "public read active store_items" on store_items for select using (is_active);
create policy "staff read store_items" on store_items for select using (is_staff());
create policy "admin write store_items" on store_items for all using (is_admin()) with check (is_admin());

-- ---------- ORDERS ----------
create table store_orders (
  id                uuid primary key default gen_random_uuid(),
  item_id           uuid not null references store_items(id),
  member_id         uuid references members(id) on delete set null,
  buyer_name        text not null,
  buyer_email       text not null,
  quantity          int  not null check (quantity > 0),
  -- price per unit after any member discount, before tax
  unit_price_cents  int  not null,
  discount_cents    int  not null default 0,
  tax_cents         int  not null default 0,
  total_cents       int,
  -- 'online' = paid through Stripe; 'toast' = rung up at the register
  source            text not null default 'online' check (source in ('online', 'toast')),
  status            text not null default 'pending' check (status in ('pending', 'paid', 'refunded', 'canceled')),
  -- a pending order only holds its stock until this time
  expires_at        timestamptz,
  stripe_session_id text unique,
  stripe_payment_intent text,
  ticket_token      text not null unique default 'lvbc-t-' || replace(gen_random_uuid()::text, '-', ''),
  fulfilled_qty     int  not null default 0,
  note              text,
  created_at        timestamptz not null default now(),
  paid_at           timestamptz,
  check (fulfilled_qty between 0 and quantity)
);
create index store_orders_item_idx on store_orders (item_id);
create index store_orders_member_idx on store_orders (member_id);

alter table store_orders enable row level security;
create policy "staff read store_orders" on store_orders for select using (is_staff());
create policy "member reads own store_orders" on store_orders for select using (member_id = my_member_id());

-- A member can read the item behind an order even after it's no longer on sale.
create policy "member reads ordered store_items" on store_items for select
  using (exists (select 1 from store_orders o where o.item_id = store_items.id and o.member_id = my_member_id()));

-- ---------- STOCK ----------
create or replace function store_item_sold(p_item uuid)
returns int as $$
  select coalesce(sum(quantity), 0)::int from store_orders
  where item_id = p_item and (status = 'paid' or (status = 'pending' and expires_at > now()));
$$ language sql stable security definer set search_path = public;

-- What the shop window shows: every item on sale, with how many are gone.
create or replace function store_catalog()
returns jsonb as $$
  select coalesce(jsonb_agg(to_jsonb(i) || jsonb_build_object('sold', store_item_sold(i.id))
                            order by i.event_at nulls last, i.name), '[]'::jsonb)
  from store_items i
  where i.is_active and (i.sales_close_at is null or i.sales_close_at > now());
$$ language sql stable security definer set search_path = public;

revoke all on function store_item_sold(uuid) from public;
revoke all on function store_catalog() from public;
grant execute on function store_item_sold(uuid) to anon, authenticated;
grant execute on function store_catalog() to anon, authenticated;

-- ---------- CHECKOUT ----------
-- Holds stock and prices an order. Service role only (api/store-checkout.js).
-- The member discount applies to merch, from the member's tier.
create or replace function store_reserve_order(
  p_item uuid, p_qty int, p_member uuid, p_name text, p_email text
) returns jsonb as $$
declare
  v_item store_items;
  v_pct int;
  v_unit int;
  v_order uuid;
  v_left int;
begin
  if p_qty is null or p_qty < 1 then raise exception 'Choose at least one.'; end if;

  select * into v_item from store_items where id = p_item for update;
  if not found or not v_item.is_active or (v_item.sales_close_at is not null and v_item.sales_close_at <= now()) then
    raise exception 'This item isn''t available.';
  end if;
  if p_qty > v_item.max_per_order then raise exception 'The limit is % per order.', v_item.max_per_order; end if;
  if v_item.quantity_limit is not null then
    v_left := greatest(v_item.quantity_limit - store_item_sold(p_item), 0);
    if p_qty > v_left then
      raise exception '%', case when v_left = 0 then 'Sold out.' else 'Only ' || v_left || ' left.' end;
    end if;
  end if;

  if p_member is not null and v_item.kind = 'merch' then
    select t.merch_discount_pct into v_pct from members m join tiers t on t.id = m.tier_id where m.id = p_member;
  end if;
  v_pct := coalesce(v_pct, 0);
  v_unit := round(v_item.price_cents * (100 - v_pct) / 100.0);

  insert into store_orders (item_id, member_id, buyer_name, buyer_email, quantity, unit_price_cents, discount_cents, status, expires_at)
  values (p_item, p_member, p_name, p_email, p_qty, v_unit, (v_item.price_cents - v_unit) * p_qty, 'pending', now() + interval '35 minutes')
  returning id into v_order;

  return jsonb_build_object('order_id', v_order, 'unit_cents', v_unit, 'discount_pct', v_pct,
                            'name', v_item.name, 'description', v_item.description, 'taxable', v_item.taxable, 'kind', v_item.kind);
end;
$$ language plpgsql security definer set search_path = public;

-- Marks an order paid once Stripe confirms the charge. Idempotent — the
-- webhook can deliver the same event twice. A payment that arrives after
-- the hold expired is still honoured: the money has been taken.
create or replace function store_complete_order(
  p_order uuid, p_payment_intent text, p_tax_cents int, p_total_cents int
) returns jsonb as $$
declare v_order store_orders;
begin
  update store_orders
     set status = 'paid', paid_at = now(), stripe_payment_intent = p_payment_intent,
         tax_cents = coalesce(p_tax_cents, 0), total_cents = p_total_cents
   where id = p_order and status in ('pending', 'canceled')
   returning * into v_order;
  if not found then return null; end if;  -- already paid, or unknown
  return to_jsonb(v_order);
end;
$$ language plpgsql security definer set search_path = public;

revoke all on function store_reserve_order(uuid, int, uuid, text, text) from public, anon, authenticated;
revoke all on function store_complete_order(uuid, text, int, int) from public, anon, authenticated;
grant execute on function store_reserve_order(uuid, int, uuid, text, text) to service_role;
grant execute on function store_complete_order(uuid, text, int, int) to service_role;

-- ---------- STAFF ----------
-- A sale rung up at the register (Toast) that should still count against
-- the item's stock and produce a ticket.
create or replace function store_record_toast_sale(
  p_item uuid, p_qty int, p_name text, p_email text, p_member uuid, p_total_cents int, p_note text
) returns jsonb as $$
declare
  v_item store_items;
  v_left int;
  v_order store_orders;
begin
  if not is_staff() then raise exception 'Staff only'; end if;
  if p_qty is null or p_qty < 1 then raise exception 'Choose at least one.'; end if;
  if coalesce(trim(p_name), '') = '' then raise exception 'Enter the buyer''s name.'; end if;

  select * into v_item from store_items where id = p_item for update;
  if not found then raise exception 'Unknown item.'; end if;
  if v_item.quantity_limit is not null then
    v_left := greatest(v_item.quantity_limit - store_item_sold(p_item), 0);
    if p_qty > v_left then raise exception '%', case when v_left = 0 then 'Sold out.' else 'Only ' || v_left || ' left.' end; end if;
  end if;

  insert into store_orders (item_id, member_id, buyer_name, buyer_email, quantity, unit_price_cents, total_cents,
                            source, status, paid_at, note)
  values (p_item, p_member, trim(p_name), coalesce(trim(p_email), ''), p_qty,
          round(coalesce(p_total_cents, v_item.price_cents * p_qty) / p_qty::numeric),
          coalesce(p_total_cents, v_item.price_cents * p_qty), 'toast', 'paid', now(), p_note)
  returning * into v_order;
  return to_jsonb(v_order);
end;
$$ language plpgsql security definer set search_path = public;

-- Admits people / hands over units: adds p_qty to fulfilled_qty.
create or replace function store_redeem(p_order uuid, p_qty int default 1)
returns jsonb as $$
declare v_order store_orders;
begin
  if not is_staff() then raise exception 'Staff only'; end if;
  select * into v_order from store_orders where id = p_order for update;
  if not found then raise exception 'Order not found.'; end if;
  if v_order.status <> 'paid' then raise exception 'This order is %.', v_order.status; end if;
  if p_qty < 1 or v_order.fulfilled_qty + p_qty > v_order.quantity then
    raise exception 'Only % left on this order.', v_order.quantity - v_order.fulfilled_qty;
  end if;
  update store_orders set fulfilled_qty = fulfilled_qty + p_qty where id = p_order returning * into v_order;
  return to_jsonb(v_order);
end;
$$ language plpgsql security definer set search_path = public;

-- Admin: mark an order refunded or canceled (frees its stock). The
-- money itself is refunded in the Stripe dashboard.
create or replace function store_set_order_status(p_order uuid, p_status text)
returns jsonb as $$
declare v_order store_orders;
begin
  if not is_admin() then raise exception 'Admins only'; end if;
  if p_status not in ('paid', 'refunded', 'canceled') then raise exception 'Bad status.'; end if;
  update store_orders set status = p_status where id = p_order returning * into v_order;
  if not found then raise exception 'Order not found.'; end if;
  return to_jsonb(v_order);
end;
$$ language plpgsql security definer set search_path = public;

revoke all on function store_record_toast_sale(uuid, int, text, text, uuid, int, text) from public, anon;
revoke all on function store_redeem(uuid, int) from public, anon;
revoke all on function store_set_order_status(uuid, text) from public, anon;
grant execute on function store_record_toast_sale(uuid, int, text, text, uuid, int, text) to authenticated;
grant execute on function store_redeem(uuid, int) to authenticated;
grant execute on function store_set_order_status(uuid, text) to authenticated;
