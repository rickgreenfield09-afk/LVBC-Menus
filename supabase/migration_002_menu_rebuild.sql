-- ============================================================
-- Migration 002 — Menu rebuild
-- Adopts the data model from the standalone "Beers & Menus" MVP:
-- free-text category, active/archived status, badges array, photo
-- upload via Storage. Adds the Wine & N/A menu. Drops beer_categories.
--
-- Run this in the Supabase SQL Editor against the LIVE project
-- (opatyodqtfrytgosqxom) — schema.sql has already been updated to
-- match this as the new from-scratch source of truth.
-- ============================================================

-- ---------- BEERS: reshape to the new model ----------
alter table beers
  add column if not exists category text,
  add column if not exists long_description text,
  add column if not exists badges text[] not null default '{}',
  add column if not exists status text not null default 'active',
  add column if not exists ref_id text;

-- Backfill category from the old category_id FK before it's dropped.
update beers b
set category = c.name
from beer_categories c
where b.category_id = c.id and b.category is null;

-- Backfill status from the old retired flag.
update beers
set status = case when retired then 'archived' else 'active' end;

-- Backfill the new_release badge from the old boolean flag.
update beers
set badges = array_append(badges, 'new_release')
where is_new_release and not ('new_release' = any(badges));

alter table beers
  add constraint beers_status_check check (status in ('active','archived'));

alter table beers
  drop column if exists category_id,
  drop column if exists is_on_tap,
  drop column if exists is_new_release,
  drop column if exists retired,
  drop column if exists retired_on,
  drop column if exists tapped_on,
  drop column if exists ibu,
  drop column if exists srm,
  drop column if exists og,
  drop column if exists fg,
  drop column if exists sort_order;

-- Drops the beer_categories table and its "public read"/"staff write" policies.
drop table if exists beer_categories cascade;

-- ---------- WINE & N/A MENU ----------
create table if not exists wine_menu (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  winery text,
  region text,
  type text,
  category text,
  display_group text,
  description text,
  price_glass numeric(6,2),
  price_bottle numeric(6,2),
  badge text[] not null default '{}',
  status text not null default 'active' check (status in ('active','archived')),
  sort_order int not null default 0,
  created_at timestamptz not null default now()
);

alter table wine_menu enable row level security;
create policy "public read wine_menu" on wine_menu for select using (true);
create policy "admin write wine_menu" on wine_menu for all using (is_admin()) with check (is_admin());

-- ---------- BEERS RLS: admin-only write (was any staff) ----------
drop policy if exists "staff write beers" on beers;
drop policy if exists "admin write beers" on beers;
create policy "admin write beers" on beers for all using (is_admin()) with check (is_admin());

-- ---------- STORAGE — beer / wine photo uploads ----------
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
