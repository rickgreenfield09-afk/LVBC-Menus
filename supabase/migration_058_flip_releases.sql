-- ============================================================
-- Migration 058 — Editable Upcoming Releases flip card
-- ============================================================
-- One row (id = 1) holding the four beer-style lines printed on the
-- Upcoming Releases flip card (js/menu.js, Marketing > Print Outs). Each
-- item is {style, note}: the beer style and an optional flavor/color
-- subtitle. Everything else on the card is fixed in code. Safe to re-run.

create table if not exists flip_releases (
  id int primary key check (id = 1),
  items jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now()
);

insert into flip_releases (id, items) values (1, '[
  {"style": "Cold IPA", "note": ""},
  {"style": "Lagoritaville Mexican Lager", "note": ""},
  {"style": "Apple Strudel Lager", "note": ""},
  {"style": "", "note": ""}
]'::jsonb) on conflict (id) do nothing;

alter table flip_releases enable row level security;
drop policy if exists "staff all flip_releases" on flip_releases;
create policy "staff all flip_releases" on flip_releases for all
  using (is_staff()) with check (is_staff());
