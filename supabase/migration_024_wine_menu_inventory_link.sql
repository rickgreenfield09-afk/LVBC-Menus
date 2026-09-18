-- ============================================================
-- Migration 024 — Link wine inventory to the wine menu
-- ============================================================
-- Turning a wine/N/A menu item Off zeroes its inventory level (red on
-- the dashboard = needs ordering). Turning it back On leaves the level
-- at 0 so the restock gets a real recount. Runs in the database so it
-- works no matter who toggles it; security definer lets any staff
-- toggle write inventory even though inventory RLS is separate.
-- Safe to re-run.
-- Requires migrations 021 (off status), 022 and 023.

alter table inventory_items
  add column if not exists wine_menu_id uuid references wine_menu(id) on delete set null;

-- One-time link: match by name (023 seeded inventory from menu names).
update inventory_items i
set wine_menu_id = w.id
from wine_menu w
where i.category = 'wine'
  and i.wine_menu_id is null
  and lower(i.name) = lower(w.name);

create or replace function zero_inventory_when_menu_off()
returns trigger as $$
begin
  if new.status = 'off' and old.status is distinct from 'off' then
    update inventory_items
    set percent_remaining = 0, last_checked_at = now()
    where wine_menu_id = new.id;
  end if;
  return new;
end;
$$ language plpgsql security definer;

drop trigger if exists wine_menu_off_zeroes_inventory on wine_menu;
create trigger wine_menu_off_zeroes_inventory
  after update of status on wine_menu
  for each row execute function zero_inventory_when_menu_off();

-- Items already Off when this ships.
update inventory_items
set percent_remaining = 0, last_checked_at = now()
where wine_menu_id in (select id from wine_menu where status = 'off');
