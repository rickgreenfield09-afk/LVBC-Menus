-- ============================================================
-- Migration 036 — Locations, item photos, merch styles, per-location stock
-- ============================================================
-- Requires migrations 034 + 035. Four related changes:
--
-- 1. LOCATIONS. One self-referencing table, three levels deep:
--    location > sublocation > spot ("Break room > Rack 1 > Box 2").
--    Seeded with the four main locations only; the levels below them
--    get named later from Inventory > Locations. A location's id never
--    changes, so a QR code printed for it stays valid when it's renamed.
--    Staff read, admins manage. A location that still has stock or
--    count history can't be deleted (plain FK, no cascade).
--
-- 2. PHOTOS. inventory_items.photo_url for the percent items, and
--    inventory_merch_styles.photo_url for merch. Files live in the
--    existing public 'assets' bucket under inventory/, which any staff
--    can write to (the rest of the bucket stays admin-only).
--
-- 3. MERCH STYLES. A product's color + design combination ("Tan",
--    "Solid White / Black Logo") becomes its own row instead of two
--    text columns repeated on every size. It is the unit that gets a
--    photo, gets retired, and (later) gets assigned to a shift's count.
--    Shape is now product > style > variant (one per size).
--    Retired/active moves from the variant to the style; a single size
--    was never retired on its own.
--
-- 4. PER-LOCATION STOCK. Merch is kept in more than one place (sold
--    from the Taproom, backstock in the Break room), so a count is now
--    for a variant AT a location:
--      inventory_merch_counts.location_id   which location was counted
--      inventory_merch_stock                current units per variant
--                                           per location
--    A variant's unit_count is always the sum of its stock rows, kept
--    by trigger. location_id null means "not split by location yet" —
--    that's every imported count. The first time a variant is counted
--    at a real location, its unsplit quantity is dropped: a physical
--    count by location replaces the old single total rather than
--    adding to it.
--    Counts are recorded through record_merch_count(), never by
--    writing a variant or a stock row directly.
--
-- inventory_items keeps its free-text location column next to the new
-- location_id until the sublocations are named and items are mapped.

-- ---------- 0. spelling in imported data ----------
update inventory_merch_products set notes = replace(notes, 'colour', 'color') where notes like '%colour%';

-- ---------- 1. LOCATIONS ----------
create table inventory_locations (
  id uuid primary key default gen_random_uuid(),
  parent_id uuid references inventory_locations(id) on delete cascade,
  name text not null check (length(trim(name)) > 0),
  sort_order int not null default 0,
  created_at timestamptz not null default now()
);

-- no two siblings with the same name
create unique index inventory_locations_sibling_name_uq on inventory_locations
  (coalesce(parent_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(trim(name)));

create or replace function inventory_locations_check_depth()
returns trigger as $$
declare
  depth int := 1;
  cur uuid := new.parent_id;
begin
  while cur is not null loop
    if cur = new.id then raise exception 'A location cannot sit inside itself'; end if;
    depth := depth + 1;
    if depth > 3 then raise exception 'Locations go three levels deep at most (location > sublocation > spot)'; end if;
    select parent_id into cur from inventory_locations where id = cur;
  end loop;
  return new;
end;
$$ language plpgsql;

create trigger inventory_locations_depth
  before insert or update of parent_id on inventory_locations
  for each row execute function inventory_locations_check_depth();

insert into inventory_locations (name, sort_order) values
  ('Taproom', 1), ('Brewhouse', 2), ('Break room', 3), ('Cleaning rack', 4);

alter table inventory_locations enable row level security;
create policy "staff read inventory_locations" on inventory_locations for select using (is_staff());
create policy "admin write inventory_locations" on inventory_locations for all
  using (is_admin()) with check (is_admin());

-- ---------- 2. PERCENT ITEMS: location + photo ----------
alter table inventory_items add column location_id uuid references inventory_locations(id);
alter table inventory_items add column photo_url text;
create index inventory_items_location_idx on inventory_items (location_id);

create policy "staff insert inventory photos" on storage.objects for insert
  with check (bucket_id = 'assets' and (storage.foldername(name))[1] = 'inventory' and is_staff());
create policy "staff update inventory photos" on storage.objects for update
  using (bucket_id = 'assets' and (storage.foldername(name))[1] = 'inventory' and is_staff())
  with check (bucket_id = 'assets' and (storage.foldername(name))[1] = 'inventory' and is_staff());
create policy "staff delete inventory photos" on storage.objects for delete
  using (bucket_id = 'assets' and (storage.foldername(name))[1] = 'inventory' and is_staff());

-- ---------- 3. MERCH STYLES ----------
create table inventory_merch_styles (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references inventory_merch_products(id) on delete cascade,
  color text,
  design text,
  photo_url text,
  status text not null default 'active' check (status in ('active','retired')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index inventory_merch_styles_uq on inventory_merch_styles
  (product_id, lower(coalesce(color, '')), lower(coalesce(design, '')));

create trigger inventory_merch_styles_set_updated_at
  before update on inventory_merch_styles
  for each row execute function set_updated_at();

insert into inventory_merch_styles (product_id, color, design, status)
select product_id, color, design,
       case when bool_and(status = 'retired') then 'retired' else 'active' end
from inventory_merch_variants
group by product_id, color, design;

alter table inventory_merch_variants add column style_id uuid references inventory_merch_styles(id) on delete cascade;

update inventory_merch_variants v
set style_id = s.id
from inventory_merch_styles s
where s.product_id = v.product_id
  and s.color is not distinct from v.color
  and s.design is not distinct from v.design;

alter table inventory_merch_variants alter column style_id set not null;

drop index inventory_merch_variants_uq;
alter table inventory_merch_variants drop column product_id;
alter table inventory_merch_variants drop column color;
alter table inventory_merch_variants drop column design;
alter table inventory_merch_variants drop column status;

create unique index inventory_merch_variants_uq on inventory_merch_variants (style_id, lower(coalesce(size, '')));

alter table inventory_merch_styles enable row level security;
create policy "staff all inventory_merch_styles" on inventory_merch_styles for all
  using (is_staff()) with check (is_staff());

-- ---------- 4. PER-LOCATION STOCK ----------
create table inventory_merch_stock (
  id uuid primary key default gen_random_uuid(),
  variant_id uuid not null references inventory_merch_variants(id) on delete cascade,
  -- null = not split by location yet
  location_id uuid references inventory_locations(id),
  unit_count int not null default 0 check (unit_count >= 0),
  last_checked_at timestamptz,
  last_checked_by uuid references staff_profiles(id) on delete set null,
  constraint inventory_merch_stock_uq unique nulls not distinct (variant_id, location_id)
);

create index inventory_merch_stock_location_idx on inventory_merch_stock (location_id);

insert into inventory_merch_stock (variant_id, location_id, unit_count, last_checked_at, last_checked_by)
select id, null, unit_count, last_checked_at, last_checked_by from inventory_merch_variants;

alter table inventory_merch_counts add column location_id uuid references inventory_locations(id);
alter table inventory_merch_counts drop constraint inventory_merch_counts_variant_id_counted_on_key;
-- one count per variant per location per day; a recount the same day replaces it
alter table inventory_merch_counts add constraint inventory_merch_counts_uq
  unique nulls not distinct (variant_id, location_id, counted_on);

-- counts -> stock: the latest count for a variant at a location is its stock there.
create or replace function sync_merch_variant_from_count()
returns trigger as $$
begin
  if not exists (
    select 1 from inventory_merch_counts c
    where c.variant_id = new.variant_id
      and c.location_id is not distinct from new.location_id
      and c.counted_on > new.counted_on
  ) then
    insert into inventory_merch_stock (variant_id, location_id, unit_count, last_checked_at, last_checked_by)
    values (new.variant_id, new.location_id, new.unit_count, new.counted_at, new.counted_by)
    on conflict on constraint inventory_merch_stock_uq do update
      set unit_count = excluded.unit_count,
          last_checked_at = excluded.last_checked_at,
          last_checked_by = excluded.last_checked_by;
  end if;
  -- a count at a real location supersedes the old unsplit total
  if new.location_id is not null then
    delete from inventory_merch_stock where variant_id = new.variant_id and location_id is null;
  end if;
  return new;
end;
$$ language plpgsql security definer;

-- stock -> variant: unit_count is the sum across locations.
create or replace function sync_merch_variant_from_stock()
returns trigger as $$
declare
  vid uuid := coalesce(new.variant_id, old.variant_id);
begin
  update inventory_merch_variants v
  set unit_count = coalesce((select sum(s.unit_count) from inventory_merch_stock s where s.variant_id = vid), 0),
      last_checked_at = (select max(s.last_checked_at) from inventory_merch_stock s where s.variant_id = vid),
      last_checked_by = (select s.last_checked_by from inventory_merch_stock s where s.variant_id = vid
                         order by s.last_checked_at desc nulls last limit 1)
  where v.id = vid;
  return null;
end;
$$ language plpgsql security definer;

create trigger inventory_merch_stock_sync_variant
  after insert or update or delete on inventory_merch_stock
  for each row execute function sync_merch_variant_from_stock();

-- The one way the apps record a count. p_counted_on is the device's
-- local date, so a count taken late in the evening lands on the day
-- the person counting thinks it is.
create or replace function record_merch_count(
  p_variant_id uuid,
  p_location_id uuid,
  p_unit_count int,
  p_counted_on date default current_date,
  p_counted_at timestamptz default now()
) returns void as $$
  insert into inventory_merch_counts (variant_id, location_id, counted_on, counted_at, unit_count, counted_by, source)
  values (p_variant_id, p_location_id, p_counted_on, p_counted_at, p_unit_count, auth.uid(), 'app')
  on conflict on constraint inventory_merch_counts_uq do update
    set unit_count = excluded.unit_count,
        counted_at = excluded.counted_at,
        counted_by = excluded.counted_by,
        source = 'app';
$$ language sql;

alter table inventory_merch_stock enable row level security;
create policy "staff all inventory_merch_stock" on inventory_merch_stock for all
  using (is_staff()) with check (is_staff());
