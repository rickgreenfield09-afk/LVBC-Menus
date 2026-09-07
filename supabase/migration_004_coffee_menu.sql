-- ============================================================
-- Migration 004 — Coffee Menu + Recipe Reference
-- Adds a customer-facing, printable coffee menu (same pattern as
-- beers/wine_menu) plus a staff-only recipe reference that never
-- gets printed. Data transcribed from the printed coffee menu and
-- the espresso training card.
--
-- Run this in the Supabase SQL Editor against the LIVE project
-- (opatyodqtfrytgosqxom).
-- ============================================================

create table coffee_menu (
  id uuid primary key default gen_random_uuid(),
  drink_name text not null,
  size_label text not null,
  price numeric(6,2) not null,
  sort_order int not null default 0,
  status text not null default 'active' check (status in ('active','archived')),
  created_at timestamptz not null default now()
);

create table coffee_recipes (
  id uuid primary key default gen_random_uuid(),
  drink_name text not null,
  size_label text,
  recipe text not null,
  sort_order int not null default 0,
  created_at timestamptz not null default now()
);

create table coffee_guide (
  id uuid primary key default gen_random_uuid(),
  content text not null default '',
  updated_at timestamptz not null default now()
);

alter table coffee_menu enable row level security;
alter table coffee_recipes enable row level security;
alter table coffee_guide enable row level security;

create policy "public read coffee_menu" on coffee_menu for select using (true);
create policy "admin write coffee_menu" on coffee_menu for all using (is_admin()) with check (is_admin());

create policy "staff read coffee_recipes" on coffee_recipes for select using (is_staff());
create policy "admin write coffee_recipes" on coffee_recipes for all using (is_admin()) with check (is_admin());

create policy "staff read coffee_guide" on coffee_guide for select using (is_staff());
create policy "admin write coffee_guide" on coffee_guide for all using (is_admin()) with check (is_admin());

insert into coffee_menu (drink_name, size_label, price, sort_order) values
  ('Drip Coffee', '8 oz', 3.00, 1),
  ('Drip Coffee', '12 oz', 3.50, 2),
  ('Espresso', 'Single', 2.50, 3),
  ('Espresso', 'Double', 3.50, 4),
  ('Americano', '8 oz', 4.00, 5),
  ('Americano', '12 oz', 4.50, 6),
  ('Americano', 'Iced 16 oz', 5.00, 7),
  ('Latte', '8 oz', 4.50, 8),
  ('Latte', '12 oz', 5.00, 9),
  ('Latte', 'Iced 16 oz', 5.50, 10),
  ('Cappuccino', '8 oz', 4.50, 11),
  ('Vanilla Latte', '8 oz', 5.50, 12),
  ('Vanilla Latte', '12 oz', 6.00, 13),
  ('Vanilla Latte', 'Iced 16 oz', 6.50, 14),
  ('Caramel Latte', '8 oz', 5.50, 15),
  ('Caramel Latte', '12 oz', 6.00, 16),
  ('Caramel Latte', 'Iced 16 oz', 6.50, 17),
  ('Mocha', '8 oz', 5.50, 18),
  ('Mocha', '12 oz', 6.00, 19),
  ('Mocha', 'Iced 16 oz', 6.50, 20),
  ('White Mocha', '8 oz', 5.50, 21),
  ('White Mocha', '12 oz', 6.00, 22),
  ('White Mocha', 'Iced 16 oz', 6.50, 23);

-- Transcribed from the training card. Some handwritten corrections were
-- hard to read precisely — double-check these in the app and correct
-- as needed once you can see them rendered.
insert into coffee_recipes (drink_name, size_label, recipe, sort_order) values
  ('Cappuccino', '8 oz', '2 oz espresso + start with 4 oz milk (thick foam), steam to end with 6 oz', 1),
  ('Latte', '8 oz', '2 oz espresso + start with 4 oz milk, steam to end with 6 oz', 2),
  ('Latte', '12 oz', '4 oz espresso + start with 8 oz milk, steam to end with 10 oz', 3),
  ('Americano', '8 oz', '2 oz espresso + 6 oz hot water', 4),
  ('Americano', '12 oz', '4 oz espresso + 8 oz hot water', 5),
  ('Mocha', '8 oz', '1 oz chocolate + 2 oz espresso + 4 oz milk', 6),
  ('Mocha', '12 oz', '2 pumps chocolate + 2 oz espresso + fill to 7 oz milk', 7),
  ('White Chocolate Pumpkin Spice (seasonal)', null, '1 pump pumpkin pie syrup + 1 pump white chocolate syrup', 8);

insert into coffee_guide (content) values (
$$ESPRESSO DIAL-IN STANDARD
- Dose: 18 g
- Yield: 36 g
- Ratio: 1:2
- Shot Time: 28-32 sec
- Water Temp: 200-202°F

MILK STANDARDS
- Latte: thin, silky microfoam
- Cappuccino: thick, velvety foam
- Milk Temp: 140-150°F
- Syrups: standard 1 oz, extra +½ oz

SHOT EVALUATION
- Good Shot: thick hazelnut crema, steady honey-like flow, balanced flavor.
- Too Fast (<28 sec): sour, weak, pale crema → grind finer.
- Too Slow (>32 sec): bitter, dry, dark crema → grind coarser.$$
);
