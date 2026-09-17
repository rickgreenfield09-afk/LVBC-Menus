-- ============================================================
-- Migration 020 — Inventory tracking (v1)
-- ============================================================
-- Brewery inventory isn't counted precisely — staff log a rough
-- percent remaining in the box/location (or, for wine, an actual
-- bottle count) so the dashboard can flag what's running low.
-- Color thresholds: <= critical_threshold = red, <= low_threshold =
-- yellow, above = green. Per-row threshold columns let an individual
-- item loosen/tighten the default without a settings table.
--
-- inventory_items covers the four percent-based categories
-- (consumables/snacks/coffee/merchandise) in one table — they're
-- shaped identically and only differ by the free-text category tag,
-- same as how beers uses one table with a category column.
--
-- "Already ordered, awaiting arrival" isn't a status column on the
-- item — it's derived from whether an open (received_at is null) row
-- exists for it in inventory_order_log, so there's one source of
-- truth instead of two fields that can drift out of sync.
--
-- inventory_order_log is polymorphic (item_type + item_id, no FK)
-- since it points at either inventory_items or inventory_wine —
-- app code is responsible for querying the right table by item_type.
--
-- Vendors are read-only for regular staff (they need the contact +
-- SKU info to reorder) but only admins manage vendor records, same
-- split as beers/wine_menu/coffee_menu (public read, admin write).

create table inventory_vendors (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  contact_name text,
  phone text,
  email text,
  notes text,
  created_at timestamptz not null default now()
);

create table inventory_vendor_items (
  id uuid primary key default gen_random_uuid(),
  vendor_id uuid not null references inventory_vendors(id) on delete cascade,
  item_name text not null,
  sku_or_item_number text,
  category text check (category in ('consumables','snacks','coffee','wine','merchandise')),
  unit_cost numeric(8,2),
  notes text,
  created_at timestamptz not null default now()
);

create table inventory_items (
  id uuid primary key default gen_random_uuid(),
  category text not null check (category in ('consumables','snacks','coffee','merchandise')),
  subcategory text,
  name text not null,
  location text,
  percent_remaining int not null default 100 check (percent_remaining between 0 and 100),
  low_threshold int not null default 50 check (low_threshold between 0 and 100),
  critical_threshold int not null default 25 check (critical_threshold between 0 and 100),
  vendor_item_id uuid references inventory_vendor_items(id) on delete set null,
  last_checked_at timestamptz,
  last_checked_by uuid references staff_profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index inventory_items_category_idx on inventory_items (category);

create trigger inventory_items_set_updated_at
  before update on inventory_items
  for each row execute function set_updated_at();

-- Wine is a real count (bottles on hand), not a percent estimate —
-- kept in its own table since its shape (count vs. percent) differs
-- from inventory_items.
create table inventory_wine (
  id uuid primary key default gen_random_uuid(),
  label text not null,
  vintage text,
  location text,
  bottle_count int not null default 0 check (bottle_count >= 0),
  low_count_threshold int not null default 6 check (low_count_threshold >= 0),
  critical_count_threshold int not null default 3 check (critical_count_threshold >= 0),
  vendor_item_id uuid references inventory_vendor_items(id) on delete set null,
  last_checked_at timestamptz,
  last_checked_by uuid references staff_profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger inventory_wine_set_updated_at
  before update on inventory_wine
  for each row execute function set_updated_at();

create table inventory_order_log (
  id uuid primary key default gen_random_uuid(),
  item_type text not null check (item_type in ('item','wine')),
  item_id uuid not null,
  vendor_item_id uuid references inventory_vendor_items(id) on delete set null,
  ordered_by uuid references staff_profiles(id) on delete set null,
  ordered_at timestamptz not null default now(),
  quantity_note text,
  received_at timestamptz,
  received_by uuid references staff_profiles(id) on delete set null
);

create index inventory_order_log_item_idx on inventory_order_log (item_type, item_id);

alter table inventory_vendors enable row level security;
alter table inventory_vendor_items enable row level security;
alter table inventory_items enable row level security;
alter table inventory_wine enable row level security;
alter table inventory_order_log enable row level security;

create policy "staff read inventory_vendors" on inventory_vendors for select using (is_staff());
create policy "admin write inventory_vendors" on inventory_vendors for all
  using (is_admin()) with check (is_admin());

create policy "staff read inventory_vendor_items" on inventory_vendor_items for select using (is_staff());
create policy "admin write inventory_vendor_items" on inventory_vendor_items for all
  using (is_admin()) with check (is_admin());

create policy "staff all inventory_items" on inventory_items for all
  using (is_staff()) with check (is_staff());

create policy "staff all inventory_wine" on inventory_wine for all
  using (is_staff()) with check (is_staff());

create policy "staff all inventory_order_log" on inventory_order_log for all
  using (is_staff()) with check (is_staff());
