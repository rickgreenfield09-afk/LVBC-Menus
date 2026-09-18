-- ============================================================
-- Migration 023 — Seed wine inventory from the wine menu
-- ============================================================
-- One-time carry-over: every non-archived wine_menu item (wines, N/A
-- beer, N/A options) becomes a Wine inventory row at 100%, ready to be
-- corrected on the first real count. display_group ("Wine by the
-- Bottle", "N/A Beer", ...) becomes the subcategory so they stay
-- distinguishable. Safe to re-run: skips names already in Wine.
-- Requires migration 022 (allows category 'wine').

insert into inventory_items (category, subcategory, name, percent_remaining)
select 'wine', w.display_group, w.name, 100
from wine_menu w
where w.status <> 'archived'
  and not exists (
    select 1 from inventory_items i
    where i.category = 'wine' and lower(i.name) = lower(w.name)
  );
