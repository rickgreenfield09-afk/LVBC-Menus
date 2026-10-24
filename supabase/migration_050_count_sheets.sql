-- ============================================================
-- Migration 050 — Inventory count sheets
-- ============================================================
-- Inventory > Run Inventory on the desktop builds a one-off count
-- sheet (whole categories and/or hand-picked items and merch), assigns
-- it to an employee, and it appears on that person's phone. They count
-- each line and submit; the counts are then applied to live inventory.
-- Separate from Assignments (migration_037), which hands recurring
-- shift counts to whoever is working.
--
--   inventory_count_sheets       one row per sheet
--     status  assigned   out with the employee, being counted
--             submitted  counts applied to inventory
--             cancelled  withdrawn before it was submitted
--
--   inventory_count_sheet_lines  one row per thing to count. The name,
--     photo and heading are copied onto the line when the sheet is built,
--     so a sheet keeps reading the same even if the item is later renamed
--     or removed.
--     kind 'percent'  a percent item (inventory_items), counted 0-100
--     kind 'units'    one merch size at one location, counted in units
--     counted_value is staged on the line while the employee works
--     (nothing in inventory changes yet); before_value is the level
--     inventory had at the moment of submit, so the desktop can show
--     before -> counted.
--
-- submit_count_sheet() applies every counted line in one transaction.
-- Lines nobody counted are left alone. Merch goes through
-- record_merch_count() (migration_036) like every other merch count.
-- Requires migrations 020, 034 and 036.

create table inventory_count_sheets (
  id uuid primary key default gen_random_uuid(),
  title text not null check (length(trim(title)) > 0),
  notes text,
  assigned_to uuid references staff_profiles(id) on delete set null,
  status text not null default 'assigned' check (status in ('assigned','submitted','cancelled')),
  created_by uuid references staff_profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  assigned_at timestamptz not null default now(),
  submitted_at timestamptz,
  submitted_by uuid references staff_profiles(id) on delete set null
);

create index inventory_count_sheets_assigned_idx on inventory_count_sheets (assigned_to, status);

create table inventory_count_sheet_lines (
  id uuid primary key default gen_random_uuid(),
  sheet_id uuid not null references inventory_count_sheets(id) on delete cascade,
  kind text not null check (kind in ('percent','units')),
  item_id uuid references inventory_items(id) on delete set null,
  variant_id uuid references inventory_merch_variants(id) on delete set null,
  location_id uuid references inventory_locations(id) on delete set null,
  label text not null,
  size text,
  detail text,
  group_label text not null default 'No location set',
  photo_url text,
  sort_order int not null default 0,
  before_value int,
  counted_value int,
  counted_at timestamptz,
  constraint count_sheet_line_target check (
    (kind = 'percent' and variant_id is null) or (kind = 'units' and item_id is null)
  ),
  constraint count_sheet_line_range check (
    counted_value is null
    or (kind = 'percent' and counted_value between 0 and 100)
    or (kind = 'units' and counted_value >= 0)
  )
);

create index inventory_count_sheet_lines_sheet_idx on inventory_count_sheet_lines (sheet_id, sort_order);

alter table inventory_count_sheets enable row level security;
alter table inventory_count_sheet_lines enable row level security;

create policy "staff all inventory_count_sheets" on inventory_count_sheets for all
  using (is_staff()) with check (is_staff());
create policy "staff all inventory_count_sheet_lines" on inventory_count_sheet_lines for all
  using (is_staff()) with check (is_staff());

create or replace function submit_count_sheet(p_sheet_id uuid, p_counted_on date default current_date)
returns int as $$
declare
  s inventory_count_sheets;
  ln inventory_count_sheet_lines;
  cur int;
  applied int := 0;
begin
  if not is_staff() then raise exception 'Not allowed'; end if;
  select * into s from inventory_count_sheets where id = p_sheet_id for update;
  if not found then raise exception 'Count sheet not found'; end if;
  if s.status <> 'assigned' then raise exception 'This count sheet is already %', s.status; end if;

  for ln in
    select * from inventory_count_sheet_lines
    where sheet_id = s.id and counted_value is not null
    order by sort_order
  loop
    if ln.kind = 'percent' and ln.item_id is not null then
      select percent_remaining into cur from inventory_items where id = ln.item_id;
      update inventory_count_sheet_lines set before_value = cur where id = ln.id;
      update inventory_items
      set percent_remaining = ln.counted_value,
          last_checked_at = coalesce(ln.counted_at, now()),
          last_checked_by = auth.uid()
      where id = ln.item_id;
      applied := applied + 1;
    elsif ln.kind = 'units' and ln.variant_id is not null then
      select unit_count into cur from inventory_merch_stock
      where variant_id = ln.variant_id and location_id is not distinct from ln.location_id;
      update inventory_count_sheet_lines set before_value = coalesce(cur, 0) where id = ln.id;
      perform record_merch_count(ln.variant_id, ln.location_id, ln.counted_value, p_counted_on, coalesce(ln.counted_at, now()));
      applied := applied + 1;
    end if;
  end loop;

  update inventory_count_sheets
  set status = 'submitted', submitted_at = now(), submitted_by = auth.uid()
  where id = s.id;
  return applied;
end;
$$ language plpgsql security definer;
