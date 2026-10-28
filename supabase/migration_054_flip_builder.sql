-- ============================================================
-- Migration 054 — Flier builder: component library + built designs
-- ============================================================
-- flip_components: borders, backgrounds and images uploaded in Marketing >
-- Print Outs > Component Library (files live in the public 'assets' bucket
-- under flip/components/). flip_designs gains `kind` ('upload' = flat image
-- pages from migration 053, 'built' = layout saved in `spec` and rendered at
-- print time so app data such as upcoming releases stays current).
-- Safe to re-run.

create table if not exists flip_components (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('border', 'background', 'image')),
  name text not null,
  url text not null,
  path text not null,
  archived boolean not null default false,
  created_at timestamptz not null default now()
);

alter table flip_components enable row level security;
drop policy if exists "staff all flip_components" on flip_components;
create policy "staff all flip_components" on flip_components for all
  using (is_staff()) with check (is_staff());

alter table flip_designs add column if not exists kind text not null default 'upload' check (kind in ('upload', 'built'));
alter table flip_designs add column if not exists spec jsonb;
