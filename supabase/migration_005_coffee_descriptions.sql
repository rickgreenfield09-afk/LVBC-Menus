-- ============================================================
-- Migration 005 — Coffee menu descriptions
-- Adds a short description per drink for the printed Coffee Menu
-- (customer-facing "what is this drink" line).
--
-- Run this in the Supabase SQL Editor against the LIVE project,
-- after migration_004_coffee_menu.sql.
-- ============================================================

alter table coffee_menu add column if not exists description text;

update coffee_menu set description = 'Classic brewed coffee, hot off the pot.' where drink_name = 'Drip Coffee';
update coffee_menu set description = 'A concentrated shot of rich, bold coffee.' where drink_name = 'Espresso';
update coffee_menu set description = 'Espresso diluted with hot water for a smooth, lighter cup.' where drink_name = 'Americano';
update coffee_menu set description = 'Espresso with steamed milk and a light layer of foam.' where drink_name = 'Latte';
update coffee_menu set description = 'Espresso with steamed milk and a thick, velvety foam.' where drink_name = 'Cappuccino';
update coffee_menu set description = 'Our latte sweetened with real vanilla syrup.' where drink_name = 'Vanilla Latte';
update coffee_menu set description = 'Our latte sweetened with rich caramel syrup.' where drink_name = 'Caramel Latte';
update coffee_menu set description = 'Espresso, steamed milk, and chocolate — a coffeehouse classic.' where drink_name = 'Mocha';
update coffee_menu set description = 'Espresso, steamed milk, and white chocolate for a sweeter twist.' where drink_name = 'White Mocha';
