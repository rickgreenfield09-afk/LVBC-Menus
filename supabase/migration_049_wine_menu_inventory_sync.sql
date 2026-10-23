-- ============================================================
-- Migration 049 — Keep wine inventory in sync with the wine menu
-- ============================================================
-- Wine inventory rows are tied to wine_menu items by wine_menu_id
-- (migration_024). That link was matched by name once and has drifted
-- as the menu was edited. This migration:
--   1. re-links rows whose menu item was replaced by a newer record
--      with the same name (the old one is archived or gone),
--   2. creates a 100% inventory row for every live menu item that has none,
--      and zeroes rows still tied to archived menu items,
--   3. keeps them in step from now on: a new menu item gets an inventory
--      row, a rename carries over, and Off or Archived zeroes the stock.
-- Turning an item back On, or restoring it, leaves the level alone so
-- it gets a real recount. Safe to re-run.
-- Requires migrations 021, 022, 023 and 024.

-- 1. Re-link by name: unlinked rows, or rows pointing at an archived/removed menu item.
with pick as (
  select distinct on (w.id) i.id as inv_id, w.id as menu_id
  from wine_menu w
  join inventory_items i
    on i.category = 'wine' and lower(i.name) = lower(w.name)
  where w.status <> 'archived'
    and not exists (select 1 from inventory_items j where j.wine_menu_id = w.id)
    and (
      i.wine_menu_id is null
      or not exists (select 1 from wine_menu o where o.id = i.wine_menu_id and o.status <> 'archived')
    )
  order by w.id, i.created_at
)
update inventory_items t
set wine_menu_id = pick.menu_id
from pick
where t.id = pick.inv_id;

-- 2. Anything on the live menu still without a row starts at 100%.
insert into inventory_items (category, subcategory, name, percent_remaining, wine_menu_id)
select 'wine', w.display_group, w.name, 100, w.id
from wine_menu w
where w.status <> 'archived'
  and not exists (select 1 from inventory_items i where i.wine_menu_id = w.id);

-- 2b. Archived menu items hold no stock (rows re-linked above are already excluded).
update inventory_items
set percent_remaining = 0, last_checked_at = now()
where percent_remaining > 0
  and wine_menu_id in (select id from wine_menu where status = 'archived');

-- 3a. Off or Archived zeroes the stock.
create or replace function zero_inventory_when_menu_off()
returns trigger as $$
begin
  if new.status in ('off', 'archived') and old.status is distinct from new.status then
    update inventory_items
    set percent_remaining = 0, last_checked_at = now()
    where wine_menu_id = new.id;
  end if;
  return new;
end;
$$ language plpgsql security definer;

-- 3b. New menu item => inventory row (adopting an unlinked row of the
-- same name if one exists); rename => inventory row renamed.
create or replace function sync_inventory_with_wine_menu()
returns trigger as $$
declare
  adopt_id uuid;
begin
  if tg_op = 'UPDATE' and new.name is distinct from old.name then
    update inventory_items set name = new.name where wine_menu_id = new.id;
  end if;

  if new.status <> 'archived'
     and not exists (select 1 from inventory_items where wine_menu_id = new.id) then
    select id into adopt_id
    from inventory_items
    where category = 'wine' and wine_menu_id is null and lower(name) = lower(new.name)
    order by created_at
    limit 1;

    if adopt_id is not null then
      update inventory_items set wine_menu_id = new.id where id = adopt_id;
    else
      insert into inventory_items (category, subcategory, name, percent_remaining, wine_menu_id)
      values ('wine', new.display_group, new.name, 100, new.id);
    end if;
  end if;
  return new;
end;
$$ language plpgsql security definer;

drop trigger if exists wine_menu_syncs_inventory on wine_menu;
create trigger wine_menu_syncs_inventory
  after insert or update of name, status on wine_menu
  for each row execute function sync_inventory_with_wine_menu();
