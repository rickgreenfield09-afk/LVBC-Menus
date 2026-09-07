-- ============================================================
-- LVBC Rebuild — Schema v1
-- Run in Supabase SQL Editor (new project, separate from paid work)
-- ============================================================

-- ---------- STAFF AUTH ----------
-- Staff log in via Supabase Auth (email/password). This table maps
-- an auth.users row to a role so RLS can gate writes.
create table staff_profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  name text not null,
  role text not null check (role in ('admin','staff')) default 'staff',
  created_at timestamptz not null default now()
);

create or replace function is_staff()
returns boolean as $$
  select exists (select 1 from staff_profiles where id = auth.uid());
$$ language sql security definer stable;

create or replace function is_admin()
returns boolean as $$
  select exists (select 1 from staff_profiles where id = auth.uid() and role = 'admin');
$$ language sql security definer stable;

-- ---------- TIERS ----------
-- Replaces the old free-text tier column on members.
create table tiers (
  id serial primary key,
  name text not null unique,        -- 'Free','Mug Club','Coffee Club','Full Pour'
  rank int not null unique,         -- 0,1,2,3 — for ordering/comparisons
  created_at timestamptz not null default now()
);

-- ---------- BEERS ----------
-- Category is free text (fixed dropdown in the UI, not a lookup table) —
-- matches the "Beers & Menus" MVP this replaces. status replaces the old
-- is_on_tap/retired booleans; badges replaces the old is_new_release flag
-- with a small set of admin-picked labels (new_release, back_again, etc).
create table beers (
  id uuid primary key default gen_random_uuid(),
  ref_id text,
  name text not null,
  style text,
  abv numeric(4,2),
  price numeric(6,2),
  category text,                    -- 'Light & Lager','Ales & IPAs','Strong & Specialty','Dark','Guest Tap','Non-Alcoholic'
  description text,
  long_description text,
  badges text[] not null default '{}',   -- e.g. 'new_release','back_again','seasonal','limited','collab','lactose','wheat'
  collab_partner text,
  image_url text,
  status text not null default 'active' check (status in ('active','archived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create or replace function set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger beers_set_updated_at
  before update on beers
  for each row execute function set_updated_at();

-- ---------- WINE & N/A MENU ----------
create table wine_menu (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  winery text,
  region text,
  type text,
  category text,             -- white/red/rosé/sparkling/na
  display_group text,        -- 'Wine by the Bottle' | 'Wine by the Glass' | 'N/A Beer' | 'N/A Options'
  description text,
  price_glass numeric(6,2),
  price_bottle numeric(6,2),
  badge text[] not null default '{}',
  status text not null default 'active' check (status in ('active','archived')),
  sort_order int not null default 0,
  created_at timestamptz not null default now()
);

-- ---------- COFFEE MENU ----------
-- Customer-facing, printable like the tap list. One row per
-- drink+size (e.g. 'Latte' / '8 oz' / 4.50).
create table coffee_menu (
  id uuid primary key default gen_random_uuid(),
  drink_name text not null,
  size_label text not null,
  price numeric(6,2) not null,
  sort_order int not null default 0,
  status text not null default 'active' check (status in ('active','archived')),
  created_at timestamptz not null default now()
);

-- ---------- COFFEE RECIPES (staff reference — never printed) ----------
create table coffee_recipes (
  id uuid primary key default gen_random_uuid(),
  drink_name text not null,
  size_label text,
  recipe text not null,
  sort_order int not null default 0,
  created_at timestamptz not null default now()
);

-- ---------- COFFEE GUIDE (staff reference — dial-in/milk/shot notes) ----------
-- Single free-text document, edited as one block in the admin UI.
create table coffee_guide (
  id uuid primary key default gen_random_uuid(),
  content text not null default '',
  updated_at timestamptz not null default now()
);

-- ---------- MEMBERS ----------
create table members (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  email text not null unique,
  phone text,
  birthday date,
  tier_id int not null references tiers(id) default 1,
  points_balance int not null default 0,
  points_earned_lifetime int not null default 0,
  is_active boolean not null default true,
  pin text,                          -- kiosk PIN, nullable (cleared by staff)
  profile_photo_url text,
  joined_at timestamptz not null default now()
);

-- ---------- QR TOKENS ----------
-- Provisioning (token creation) happens outside this file — flagged earlier,
-- no insert path existed in the old staff panel. Table shape only.
create table qr_tokens (
  id uuid primary key default gen_random_uuid(),
  member_id uuid not null references members(id) on delete cascade,
  token text not null unique,
  created_at timestamptz not null default now()
);

-- ---------- CHECK-INS ----------
create table check_ins (
  id uuid primary key default gen_random_uuid(),
  member_id uuid not null references members(id) on delete cascade,
  checked_in_at timestamptz not null default now(),
  new_release_poured boolean not null default false,
  free_pour_beer text,
  points_awarded int not null default 0
);

-- ---------- POINT RULES ----------
create table point_rules (
  id serial primary key,
  label text not null,
  transaction_type text not null unique,   -- 'checkin_first_visit', etc.
  description text,
  points int not null
);

-- ---------- POINTS TRANSACTIONS ----------
create table points_transactions (
  id uuid primary key default gen_random_uuid(),
  member_id uuid not null references members(id) on delete cascade,
  transaction_type text not null,
  points int not null,
  notes text,
  processed_by text,
  created_at timestamptz not null default now()
);

-- ---------- REWARDS ----------
create table rewards (
  id uuid primary key default gen_random_uuid(),
  reward_name text not null,
  tier_id int not null references tiers(id),
  points_cost int not null,
  tier_limit text,
  repeatable boolean not null default true,
  is_active boolean not null default true
);

-- ---------- REDEMPTIONS ----------
create table redemptions (
  id uuid primary key default gen_random_uuid(),
  member_id uuid not null references members(id) on delete cascade,
  tier_id int references tiers(id),        -- snapshot of tier at redemption time
  reward_name text not null,
  points_spent int not null,
  processed_by text,
  notes text,
  redeemed_at timestamptz not null default now()
);

-- ---------- FREE POURS ----------
create table free_pours (
  id uuid primary key default gen_random_uuid(),
  member_id uuid not null references members(id) on delete cascade,
  beer_id uuid not null references beers(id) on delete cascade,
  poured_at timestamptz not null default now()
);

-- ---------- BADGES ----------
-- Catalog only this pass — member_badges (who earned what) deferred.
create table badges (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  category text not null,
  rarity text not null check (rarity in ('Standard','Rare','Exclusive')) default 'Standard',
  border_color text,
  description text,
  trigger_description text,
  is_secret boolean not null default false,
  is_active boolean not null default true
);

-- ---------- EVENTS ----------
create table events (
  id uuid primary key default gen_random_uuid(),
  event_name text not null,
  event_type text,
  event_date timestamptz not null,
  points_available int default 30,
  max_capacity int,
  notes text,
  is_beer_release boolean not null default false,
  created_at timestamptz not null default now()
);

-- ---------- LVBC U-THERE (outing polls) ----------
create table lvbc_u_there (
  id uuid primary key default gen_random_uuid(),
  outing_name text not null,
  outing_type text,
  proposed_date date,
  description text,
  status text not null check (status in ('pending','approved','rejected')) default 'pending',
  vote_count int not null default 0,
  nominated_by text,
  created_at timestamptz not null default now()
);

-- ============================================================
-- ROW LEVEL SECURITY
-- Public (anon) = customer-facing surfaces only: menu, events, badge
-- catalog, reward catalog. Everything with member PII or point/dollar
-- movement requires a logged-in staff account.
-- ============================================================

alter table staff_profiles enable row level security;
alter table tiers enable row level security;
alter table beers enable row level security;
alter table wine_menu enable row level security;
alter table coffee_menu enable row level security;
alter table coffee_recipes enable row level security;
alter table coffee_guide enable row level security;
alter table members enable row level security;
alter table qr_tokens enable row level security;
alter table check_ins enable row level security;
alter table point_rules enable row level security;
alter table points_transactions enable row level security;
alter table rewards enable row level security;
alter table redemptions enable row level security;
alter table free_pours enable row level security;
alter table badges enable row level security;
alter table events enable row level security;
alter table lvbc_u_there enable row level security;

-- staff_profiles: staff can read the roster; only admins manage roles
create policy "staff read roster" on staff_profiles for select using (is_staff());
create policy "admin manage roster" on staff_profiles for all
  using (is_admin()) with check (is_admin());

-- Public read, staff write: catalog/marketing surfaces
create policy "public read tiers" on tiers for select using (true);
create policy "staff write tiers" on tiers for all using (is_staff()) with check (is_staff());

create policy "public read beers" on beers for select using (true);
create policy "admin write beers" on beers for all using (is_admin()) with check (is_admin());

create policy "public read wine_menu" on wine_menu for select using (true);
create policy "admin write wine_menu" on wine_menu for all using (is_admin()) with check (is_admin());

create policy "public read coffee_menu" on coffee_menu for select using (true);
create policy "admin write coffee_menu" on coffee_menu for all using (is_admin()) with check (is_admin());

-- Recipes/guide are staff reference material, not customer-facing.
create policy "staff read coffee_recipes" on coffee_recipes for select using (is_staff());
create policy "admin write coffee_recipes" on coffee_recipes for all using (is_admin()) with check (is_admin());

create policy "staff read coffee_guide" on coffee_guide for select using (is_staff());
create policy "admin write coffee_guide" on coffee_guide for all using (is_admin()) with check (is_admin());

create policy "public read rewards" on rewards for select using (true);
create policy "staff write rewards" on rewards for all using (is_staff()) with check (is_staff());

create policy "public read badges" on badges for select using (true);
create policy "staff write badges" on badges for all using (is_staff()) with check (is_staff());

create policy "public read events" on events for select using (true);
create policy "staff write events" on events for all using (is_staff()) with check (is_staff());

create policy "public read uthere" on lvbc_u_there for select using (true);
create policy "staff write uthere" on lvbc_u_there for all using (is_staff()) with check (is_staff());

-- Staff-only, both read and write: PII / financial-equivalent (points) data
create policy "staff only members" on members for all using (is_staff()) with check (is_staff());
create policy "staff only qr_tokens" on qr_tokens for all using (is_staff()) with check (is_staff());
create policy "staff only check_ins" on check_ins for all using (is_staff()) with check (is_staff());
create policy "staff only point_rules" on point_rules for all using (is_staff()) with check (is_staff());
create policy "staff only points_transactions" on points_transactions for all using (is_staff()) with check (is_staff());
create policy "staff only redemptions" on redemptions for all using (is_staff()) with check (is_staff());
create policy "staff only free_pours" on free_pours for all using (is_staff()) with check (is_staff());

-- ============================================================
-- STORAGE — beer / wine photo uploads
-- Public bucket "assets", admin-only write.
-- ============================================================

insert into storage.buckets (id, name, public) values ('assets', 'assets', true)
  on conflict (id) do nothing;

create policy "public read assets" on storage.objects for select
  using (bucket_id = 'assets');
create policy "admin write assets" on storage.objects for insert
  with check (bucket_id = 'assets' and is_admin());
create policy "admin update assets" on storage.objects for update
  using (bucket_id = 'assets' and is_admin()) with check (bucket_id = 'assets' and is_admin());
create policy "admin delete assets" on storage.objects for delete
  using (bucket_id = 'assets' and is_admin());

-- ============================================================
-- SEED DATA
-- ============================================================

insert into tiers (name, rank) values
  ('Free', 0), ('Mug Club', 1), ('Coffee Club', 2), ('Full Pour', 3);

-- Real tap list + wine/N/A data, carried over from the retired MVP
-- (tmbvkusticlunsmqjfty.supabase.co). IDs preserved verbatim.
insert into beers (id, ref_id, name, style, description, category, abv, price, status, badges, collab_partner) values
  ('017bf196-6d74-472d-bcec-31effae9e307','33','Bronco Blonde','Blonde Ale','Smooth and easy-drinking with a touch of honey sweetness and a clean finish.','Light & Lager',5,6.5,'active','{}',null),
  ('52dcc935-6cb0-4a92-9dc9-f8601f772fc8','34','Howdyfest','Rye Lager','A Texas take on a classic lager with a spicy rye backbone and smooth malt body.','Light & Lager',6.2,6.5,'active','{}',null),
  ('b16e6e28-98d6-43b5-beae-616a27e20c77','35','Southern Drawl','Helles Lager','Soft malty and approachable — a Bavarian classic brewed for the Texas heat.','Light & Lager',5.5,6.5,'active','{back_again}',null),
  ('85f5736a-17c7-4c16-9fa0-d2efaf052b44','36','Orbit Sixx-T','Patersbier','The sessionable table beer of Belgian monks — golden gentle and quietly complex.','Light & Lager',5.8,6.5,'active','{}',null),
  ('58474929-778d-4ec7-bd8b-8dce4ffd9743','37','Purple Rain','Lavender & Chamomile Maibock','A smooth, golden Maibock with honeyed malt sweetness and delicate notes of lavender and chamomile (contains lavender extract made in a facility that processes nuts).','Light & Lager',6.5,7,'active','{}',null),
  ('4cdb3ea9-b56c-49b7-9da2-30ba9f0d0c3f','38','Bonfire','Amber Ale','Rich caramel malt with a gentle hop balance and a warm toasty finish.','Ales & IPAs',5,6.5,'active','{}',null),
  ('c20e2897-a7f8-4373-9171-fb8f95613221','39','Vista IPA','IPA','Bold citrus and pine hop character with a clean bitter finish that opens up the view.','Ales & IPAs',6.2,7.5,'active','{}',null),
  ('a107f1e1-8111-4d20-8ffa-aa3671be4898','40','3rd And Totally Tubular','Piña Colada Ale','This all that and a bag of chips—loaded with pineapple, coconut, and enough tropical nostalgia to make your inner 90s kid do the Macarena.','Ales & IPAs',6,7.5,'active','{lactose}',null),
  ('10af934d-d784-47f5-ab6b-b6d2af3b8f43','41','All Burn','Rauchbier','German smoked malt brings the campfire to the glass — savory deep and unforgettable.','Ales & IPAs',5.2,7.5,'active','{back_again}',null),
  ('1a39c80b-10c9-4f75-97a7-91f3348461f2','42','MMM Berliner','Berliner Weisse','Tart refreshing and light — a classic German wheat ale with bright lactic acidity.','Ales & IPAs',3.8,6.5,'active','{}',null),
  ('3744980f-d035-4c72-8fe0-daa9d681d989','43','Brazos Abbey','Belgian Dubbel','Dark fruit brown sugar and Belgian yeast spice in a rich abbey-style ale.','Strong & Specialty',6.5,7.5,'active','{}',null),
  ('21c01ef4-13e5-437c-886f-26904dbd2d1e','44','Double Quad Dare','Belgian Quad','A bold warming strong ale with dried fruit caramel depth and monastic complexity.','Strong & Specialty',8.5,7.5,'active','{}',null),
  ('801244d5-0f3f-4728-baee-396a06eeff4e','45','Mintal Vacation','Mint Milk Chocolate Stout','Lush chocolate malt with cool mint and a creamy lactose finish — dessert in a glass.','Dark',6.6,7.5,'active','{}',null),
  ('008b789f-a9d2-43ec-ba18-9f483bd5bf37','46','Fairweather Cider Co','Apple Cider','Very dry, tart, and crisp with moderate apple aroma.','Guest Tap',5.5,7,'active','{}',null),
  ('4d644fd7-a792-48aa-a7fc-1c982efe2819','47','Lago''s Finest','Root Beer','House-crafted with vanilla and wintergreen — the best non-alcoholic pour on the list.','Non-Alcoholic',0,4,'active','{}',null);

insert into wine_menu (id, name, winery, region, type, category, display_group, description, price_glass, price_bottle, badge, status, sort_order) values
  ('c0860769-96c8-4582-b39d-b99d7e0ac22e','Cremant d''Alsace','Lucien Albrecht','Orschwihr, France','Brut Rosé','sparkling','Wine by the Bottle','Fine bubbles with aromas of apple, peach, and a creamy finish',null,30,'{Bottle}','active',1),
  ('4a617261-d94a-497c-8411-7dd44659e33b','Pinot Grigio','Flat Creek Estate','Marble Falls, TX','Pinot Grigio','white','Wine by the Bottle','Ripe pear and citrus with crisp acidity and a clean finish',null,35,'{Bottle}','active',2),
  ('95813edc-1e56-4912-a685-31bfdfe60000','Sparkling Almond','Flat Creek Estate','Marble Falls, TX','Sparkling','sparkling','Wine by the Bottle','Lightly sweet with almond blossom and crisp effervescence',null,30,'{Bottle}','active',3),
  ('82464ef9-2114-4c21-91aa-a567a6507a56','Four Horseman','Flat Creek Estate','Marble Falls, TX','Dry Red','red','Wine by the Bottle','Bold Texas red blend with dark fruit, cedar, and warm leather finish',null,49,'{Bottle}','active',4),
  ('3e160b90-d1c3-4518-943c-2c7f36258ad9','Louis Perdrier Brut','Louis Perdrier','Burgundy, France','Champagne','sparkling','Wine by the Glass','Served straight or brightened with fresh orange juice',6,20,'{Glass+Bottle}','active',5),
  ('10432646-fd69-412b-87f9-5191ddbf10c3','Unoaked Chardonnay','La Playa','Colchagua Valley, Chile','Chardonnay','white','Wine by the Glass','Crisp with green apple, citrus, and a clean finish',8,25,'{Glass+Bottle}','active',6),
  ('e8408561-043a-4b91-87a8-d638cce6d998','Tortoise Creek Sauvignon Blanc','Tortoise Creek','Lodi, California','Sauvignon Blanc','white','Wine by the Glass','Bright and zesty with herbaceous notes and lively citrus',8,25,'{Glass+Bottle}','active',7),
  ('f0f92eb6-7a3c-4599-99fb-8c0cb8843dbf','Prickly Rose','Frisk','Victoria, Australia','Riesling','white','Wine by the Glass','Off-dry and aromatic with peach, apricot, and a touch of sweetness',8,25,'{Glass+Bottle}','active',8),
  ('7cf5e216-1ab1-48e4-8194-31ba6840cb43','Comtesse Marion Cabernet Sauvignon','Comtesse Marion','Languedoc-Roussillon, France','Cabernet Sauvignon','red','Wine by the Glass','Full-bodied with dark fruit, cedar, and smooth tannins',8,25,'{Glass+Bottle}','active',9),
  ('b64b4a05-2d46-41d7-bb15-7adfe604551c','Sway Rosé','William Chris','Fredericksburg, TX','Dry Rosé','rosé','Wine by the Glass','Texas High Plains canned rosé with guava, strawberry, and a crisp finish',null,9,'{Can}','active',10),
  ('2bed1978-c352-4d28-8967-47eb38ffd81e','Upside Dawn','Athletic',null,'Golden Ale','na','N/A Beer','Crisp and light-bodied with citrus, herbs, and earthy hop aroma · <0.5% ABV · 50 cal',null,5,'{Can}','active',11),
  ('dd48e6f1-c617-4bd7-81d6-83fec53b4176','Run Wild IPA','Athletic',null,'IPA','na','N/A Beer','Five Northwest hops, piney citrus nose, approachable bitterness · <0.5% ABV · 70 cal',null,5,'{Can}','active',12),
  ('7fb3acc1-e6f5-4db8-88ec-552388d8d5ac','Athletic Lite','Athletic',null,'Light Lager','na','N/A Beer','Crisp, clean, and crushable with noble hops and a rice-malt body · <0.5% ABV · 25 cal',null,5,'{Can}','active',13),
  ('002d5526-e1f6-49f7-87cc-145d5d33d48d','Lago''s Finest','Lago Vista Brewing Company',null,'Root Beer','na','N/A Options','House-crafted root beer',null,4,'{}','active',14),
  ('175363c5-5823-48f6-a2fc-038ec5ff69dc','Canned Soda',null,null,null,'na','N/A Options','Coke · Diet Coke · Dr Pepper · Diet Dr Pepper · Sprite · Canada Dry',null,2,'{Can}','active',15),
  ('ade2ac42-9d28-4f5b-8641-c29ea9fb450d','Iced Tea','Gold Peak',null,null,'na','N/A Options','Sweet or Unsweet',null,3,'{Bottle}','active',16),
  ('d470ac77-ad21-4640-a848-486b9593a7d3','Lemonade',null,null,null,'na','N/A Options',null,null,4,'{}','active',17),
  ('8176b278-49d8-4be4-a893-3adfe2d6508a','Sparkling Mineral Water','Mineragua',null,null,'na','N/A Options','12.5 oz bottle',null,3,'{Bottle}','active',18),
  ('fb85d5e1-eb94-45ff-acee-f8870464ea00','Juice Box','Apple & Eve',null,null,'na','N/A Options','Apple, White Grape Raspberry, Fruit Punch',null,1,'{}','active',19);

-- Coffee menu — transcribed from the printed menu sheet.
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

-- Coffee recipes — staff reference only, transcribed from the training
-- card. Some handwritten corrections on the source card were hard to
-- read precisely; double-check these in the app and correct as needed.
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

insert into point_rules (label, transaction_type, description, points) values
  ('First Visit', 'checkin_first_visit', 'Awarded on a member''s very first check-in', 50),
  ('Wednesday Check-In', 'checkin_wednesday', 'Standard check-in on a Wednesday', 25),
  ('Thursday Check-In', 'checkin_thursday', 'Standard check-in on a Thursday', 25),
  ('Standard Check-In', 'checkin_standard', 'Any other day', 15);
