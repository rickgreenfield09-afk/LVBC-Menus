-- ============================================================
-- Migration 053 — Uploaded flip card / flier designs
-- ============================================================
-- Fliers uploaded in Marketing > Print Outs > Flip Cards. Images live in
-- the public 'assets' bucket under flip/<id>/. `pages` is an ordered array
-- of image URLs: one entry for a single page, two when a portrait flier was
-- turned sideways and split into two half-sheet pages. `size` is the printed
-- size of each page: 'half' (5.5x8.5, two per sheet) or 'full' (8.5x11).
-- show_in_app / starts_on / ends_on are reserved for showing fliers in the
-- member app. Safe to re-run.

create table if not exists flip_designs (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  size text not null default 'half' check (size in ('half', 'full')),
  pages jsonb not null default '[]'::jsonb,
  source_url text,
  show_in_app boolean not null default false,
  starts_on date,
  ends_on date,
  archived boolean not null default false,
  created_at timestamptz not null default now()
);

alter table flip_designs enable row level security;
drop policy if exists "staff all flip_designs" on flip_designs;
create policy "staff all flip_designs" on flip_designs for all
  using (is_staff()) with check (is_staff());
