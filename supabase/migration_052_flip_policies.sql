-- ============================================================
-- Migration 052 — Editable Policies flip menu
-- ============================================================
-- One row (id = 1) holding the bullet list and WiFi details printed on
-- the Policies flip card (js/menu.js, Marketing > Flip Menus). Everything
-- else on the card is fixed in code. Safe to re-run.

create table if not exists flip_policies (
  id int primary key check (id = 1),
  rules jsonb not null default '[]'::jsonb,
  wifi_name text not null default 'Lago Vista Brewing',
  wifi_password text not null default 'CheersLVBC',
  updated_at timestamptz not null default now()
);

insert into flip_policies (id, rules) values (1, '[
  "No smoking or vaping anywhere on the premises.",
  "Outside food and drinks are not permitted.",
  "Children MUST be supervised by their guardians at all times.",
  "No climbing on retaining walls or the fountain outside.",
  "No moving or throwing rocks",
  "Dogs are welcome but must be kept on a leash at all times and off furniture. Pet messes should be promptly cleaned up by their owners.",
  "All visitors must wear shirts, pants, and shoes at all times.",
  "Visitors should not turn on heaters or fire pit without staff assistance.",
  "Please return games to the designated game area after use for others to enjoy."
]'::jsonb) on conflict (id) do nothing;

alter table flip_policies enable row level security;
drop policy if exists "staff all flip_policies" on flip_policies;
create policy "staff all flip_policies" on flip_policies for all
  using (is_staff()) with check (is_staff());
