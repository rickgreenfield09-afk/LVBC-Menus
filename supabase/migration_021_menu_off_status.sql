-- ============================================================
-- Migration 021 — "off" status for menu items
-- ============================================================
-- 'off' = temporarily unavailable (e.g. out of stock for a few days):
-- not retired, so it stays in the staff Current list and can be turned
-- back on with one click. Any reader that filters status = 'active'
-- (the menu generators, and presumably any customer-facing menu)
-- automatically stops showing it, so no reader changes are needed.

alter table beers drop constraint if exists beers_status_check;
alter table beers add constraint beers_status_check check (status in ('active','off','archived'));

alter table wine_menu drop constraint if exists wine_menu_status_check;
alter table wine_menu add constraint wine_menu_status_check check (status in ('active','off','archived'));

alter table coffee_menu drop constraint if exists coffee_menu_status_check;
alter table coffee_menu add constraint coffee_menu_status_check check (status in ('active','off','archived'));
