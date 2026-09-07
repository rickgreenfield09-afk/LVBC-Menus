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

insert into beers (name, style, category, description, abv, price, badges) values
  ('Bronco Blonde', 'Blonde Ale', 'Light & Lager', 'Smooth and easy-drinking with a touch of honey sweetness and a clean finish.', 5.0, 6.50, '{}'),
  ('Float Club', 'Dry Hopped Kölsch', 'Light & Lager', 'Light and crisp with a delicate hop aroma and refreshing German character.', 5.1, 7.50, '{}'),
  ('Howdyfest', 'Rye Lager', 'Light & Lager', 'A Texas take on a classic lager, with a spicy rye backbone and smooth malt body.', 6.2, 6.50, '{}'),
  ('Southern Drawl', 'Helles Lager', 'Light & Lager', 'Soft, malty, and approachable — a Bavarian classic brewed for the Texas heat.', 5.5, 6.50, '{}'),
  ('Orbit Sixx-T', 'Patersbier', 'Light & Lager', 'The sessionable table beer of Belgian monks — golden, gentle, and quietly complex.', 5.8, 6.50, '{}'),
  ('Bonfire', 'Amber Ale', 'Ales & IPAs', 'Rich caramel malt with a gentle hop balance and a warm, toasty finish.', 5.0, 6.50, '{}'),
  ('Vista IPA', 'IPA', 'Ales & IPAs', 'Bold citrus and pine hop character with a clean, bitter finish that opens up the view.', 6.2, 7.50, '{}'),
  ('Thick & Sprucey', 'Spruce Tip IPA', 'Ales & IPAs', 'Bright forest aromatics and resinous spruce tips layered over a juicy hop base.', 6.2, 7.50, '{}'),
  ('All Burn', 'Rauchbier', 'Ales & IPAs', 'German smoked malt brings the campfire to the glass — savory, deep, and unforgettable.', 5.2, 7.50, '{}'),
  ('TBD', 'Berliner Weisse', 'Ales & IPAs', 'Tart, refreshing, and light — a classic German wheat ale with bright lactic acidity.', 3.8, 6.50, '{new_release}'),
  ('Hill Country Strong', 'Peach Saison', 'Strong & Specialty', 'Rustic farmhouse yeast meets Hill Country peaches for a fruity, peppery seasonal.', 8.0, 7.50, '{}'),
  ('Brazos Abbey', 'Belgian Dubbel', 'Strong & Specialty', 'Dark fruit, brown sugar, and Belgian yeast spice in a rich, abbey-style ale.', 6.5, 7.50, '{}'),
  ('Double Quad Dare', 'Belgian Quad', 'Strong & Specialty', 'A bold, warming strong ale with dried fruit, caramel depth, and monastic complexity.', 8.5, 7.50, '{new_release}'),
  ('Mintal Vacation', 'Mint Milk Chocolate Stout', 'Dark', 'Lush chocolate malt with cool mint and a creamy lactose finish — dessert in a glass.', 6.6, 7.50, '{lactose}'),
  ('Lago''s Finest', 'Root Beer', 'Non-Alcoholic', 'House-crafted with vanilla and wintergreen — the best non-alcoholic pour on the list.', null, 4.00, '{}'),
  ('Tin City Cider', 'Dry Hopped Cider', 'Non-Alcoholic', 'Crisp fermented apple with a bright hop lift — bone dry and endlessly drinkable.', 6.9, 7.00, '{}');

insert into point_rules (label, transaction_type, description, points) values
  ('First Visit', 'checkin_first_visit', 'Awarded on a member''s very first check-in', 50),
  ('Wednesday Check-In', 'checkin_wednesday', 'Standard check-in on a Wednesday', 25),
  ('Thursday Check-In', 'checkin_thursday', 'Standard check-in on a Thursday', 25),
  ('Standard Check-In', 'checkin_standard', 'Any other day', 15);
