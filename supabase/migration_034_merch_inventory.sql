-- ============================================================
-- Migration 034 — Merchandise inventory (unit counts + history)
-- ============================================================
-- Merch doesn't fit inventory_items: it's counted in actual units, not
-- a rough percent, and one product fans out into color / design /
-- size combinations. It gets its own three tables:
--
--   inventory_merch_products  the thing you'd reorder ("Next Level
--                             Triblend Crew Tee"), with its vendor
--                             style number.
--   inventory_merch_variants  one row per color + design + size of a
--                             product, holding the units on hand.
--   inventory_merch_counts    every count ever taken, one row per
--                             variant per day — the history the rest
--                             of inventory doesn't keep.
--
-- inventory_merch_counts is the source of truth. A variant's
-- unit_count / last_checked_* are never written directly: the trigger
-- below copies them from that variant's most recent count, so the
-- "on hand" number can't drift from the log. Recording a count is
-- always an insert (or same-day upsert) into inventory_merch_counts.
--
-- status and needs_verification are separate on purpose — a variant
-- can be both retired and still have a question hanging over it.
--   status 'retired'      no longer carried; kept for its history.
--   needs_verification    the record itself is in doubt (see
--                         verification_note) until someone checks it
--                         on site.
--
-- A variant's own style_number is only set when it differs from its
-- product's.
--
-- RLS matches inventory_items: any staff can read and write.

create table inventory_merch_products (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) > 0),
  product_type text not null default 'other'
    check (product_type in ('shirt','tank','long_sleeve','sweatshirt','outerwear','hat','visor','drinkware','accessory','other')),
  style_number text,
  status text not null default 'active' check (status in ('active','retired')),
  vendor_item_id uuid references inventory_vendor_items(id) on delete set null,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger inventory_merch_products_set_updated_at
  before update on inventory_merch_products
  for each row execute function set_updated_at();

create table inventory_merch_variants (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references inventory_merch_products(id) on delete cascade,
  color text,
  design text,
  size text,
  -- display order within a product (X-Small = 1 ... 3X-Large = 7)
  size_sort int not null default 0,
  style_number text,
  unit_count int not null default 0 check (unit_count >= 0),
  status text not null default 'active' check (status in ('active','retired')),
  needs_verification boolean not null default false,
  verification_note text,
  last_checked_at timestamptz,
  last_checked_by uuid references staff_profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index inventory_merch_variants_uq on inventory_merch_variants
  (product_id, lower(coalesce(color, '')), lower(coalesce(design, '')), lower(coalesce(size, '')));

create trigger inventory_merch_variants_set_updated_at
  before update on inventory_merch_variants
  for each row execute function set_updated_at();

create table inventory_merch_counts (
  id uuid primary key default gen_random_uuid(),
  variant_id uuid not null references inventory_merch_variants(id) on delete cascade,
  counted_on date not null default current_date,
  counted_at timestamptz not null default now(),
  unit_count int not null check (unit_count >= 0),
  counted_by uuid references staff_profiles(id) on delete set null,
  -- 'import' = carried over from the pre-app spreadsheet (migration_035)
  source text not null default 'app' check (source in ('app','import')),
  -- one count per variant per day; a recount the same day replaces it
  unique (variant_id, counted_on)
);

create index inventory_merch_counts_date_idx on inventory_merch_counts (counted_on);

create or replace function sync_merch_variant_from_count()
returns trigger as $$
begin
  update inventory_merch_variants v
  set unit_count = new.unit_count,
      last_checked_at = new.counted_at,
      last_checked_by = new.counted_by
  where v.id = new.variant_id
    and not exists (
      select 1 from inventory_merch_counts c
      where c.variant_id = new.variant_id and c.counted_on > new.counted_on
    );
  return new;
end;
$$ language plpgsql security definer;

create trigger inventory_merch_counts_sync_variant
  after insert or update on inventory_merch_counts
  for each row execute function sync_merch_variant_from_count();

alter table inventory_merch_products enable row level security;
alter table inventory_merch_variants enable row level security;
alter table inventory_merch_counts enable row level security;

create policy "staff all inventory_merch_products" on inventory_merch_products for all
  using (is_staff()) with check (is_staff());

create policy "staff all inventory_merch_variants" on inventory_merch_variants for all
  using (is_staff()) with check (is_staff());

create policy "staff all inventory_merch_counts" on inventory_merch_counts for all
  using (is_staff()) with check (is_staff());
