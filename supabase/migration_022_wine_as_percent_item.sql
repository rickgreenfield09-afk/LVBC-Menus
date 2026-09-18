-- ============================================================
-- Migration 022 — Wine tracked as a percent item
-- ============================================================
-- For now wine uses the same percent-remaining model as every other
-- inventory category so the dashboard rollups behave identically. It
-- becomes a fifth category in inventory_items; the separate
-- inventory_wine (bottle count) table is dropped, but only if it is
-- empty so no entered data is ever lost silently.

alter table inventory_items drop constraint if exists inventory_items_category_check;
alter table inventory_items add constraint inventory_items_category_check
  check (category in ('consumables','snacks','coffee','wine','merchandise'));

do $$
begin
  if not exists (select 1 from inventory_wine) then
    drop table inventory_wine;
  else
    raise notice 'inventory_wine has rows — left in place; move or delete them manually, then drop the table.';
  end if;
end $$;
