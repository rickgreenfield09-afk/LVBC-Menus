-- ============================================================
-- Migration 039 — Seed opening and closing duties; keep their order
-- ============================================================
-- Requires migration 037. Carries the laminated Opening / Closing
-- Procedures sheet into Assignments > Shift Duties: 16 opening duties
-- for the AM bartender and 22 closing duties for the PM (closing)
-- bartender, every open day. Turnover duties are not on that sheet and
-- get added later.
--
-- The sheet's order matters (doors are unlocked near the end of
-- opening, locked partway through closing), so this also adds
-- assignment_tasks.sort_order. Lists show tasks by sort_order, then
-- title; a task added later from the app goes to the end of its type.
--
-- Wording is the sheet's, with three spellings tidied: "bus tubs",
-- "paper towels", "water station".
-- Safe to re-run: a duty whose title already exists in that category
-- is skipped.

alter table assignment_tasks add column if not exists sort_order int not null default 0;

insert into assignment_tasks (title, category, frequency, period, sort_order)
select v.title, v.category, 'daily', v.period, v.sort_order
from (values
  ('Spot sweep tap room',                                    'opening', 'morning',  1),
  ('Spot sweep bathrooms',                                   'opening', 'morning',  2),
  ('Turn on CO2',                                            'opening', 'morning',  3),
  ('Clear taps',                                             'opening', 'morning',  4),
  ('Put out bar mats',                                       'opening', 'morning',  5),
  ('Start dishwasher',                                       'opening', 'morning',  6),
  ('Bring and set mats under bar and under water station',   'opening', 'morning',  7),
  ('Stock bar snacks',                                       'opening', 'morning',  8),
  ('Stock fridge under bar',                                 'opening', 'morning',  9),
  ('Inspect beer fridge and merch stand for missing items',  'opening', 'morning', 10),
  ('Put trash bags in trash cans',                           'opening', 'morning', 11),
  ('Turn on beer fridge light',                              'opening', 'morning', 12),
  ('Rearrange beer garden',                                  'opening', 'morning', 13),
  ('Turn on music and TVs',                                  'opening', 'morning', 14),
  ('Unlock doors and flip sign',                             'opening', 'morning', 15),
  ('Set out both "No outside food" signs',                   'opening', 'morning', 16),

  ('Turn off CO2',                                           'closing', 'evening',  1),
  ('Clean taps, tap handles and tile behind taps',           'closing', 'evening',  2),
  ('Clean bus tubs',                                         'closing', 'evening',  3),
  ('Turn off and drain dishwasher',                          'closing', 'evening',  4),
  ('Clean growler machine',                                  'closing', 'evening',  5),
  ('Stock bathrooms with TP and paper towels',               'closing', 'evening',  6),
  ('Clean bathrooms',                                        'closing', 'evening',  7),
  ('Close out cash drawers',                                 'closing', 'evening',  8),
  ('Take out mats under bar and water station and wash them', 'closing', 'evening',  9),
  ('Take out trash',                                         'closing', 'evening', 10),
  ('Wipe off bar top and tables',                            'closing', 'evening', 11),
  ('Turn off TV and music',                                  'closing', 'evening', 12),
  ('Flip sign to closed and lock doors',                     'closing', 'evening', 13),
  ('Bring outside trash cans inside',                        'closing', 'evening', 14),
  ('Bring in fans (if applicable)',                          'closing', 'evening', 15),
  ('Turn off outside lights',                                'closing', 'evening', 16),
  ('Rinse out tap drain with hot water',                     'closing', 'evening', 17),
  ('Put away games and clean game area',                     'closing', 'evening', 18),
  ('Turn off beer fridge light',                             'closing', 'evening', 19),
  ('Walk beer garden for trash and glasses',                 'closing', 'evening', 20),
  ('Clean floor under taps and by dishwasher',               'closing', 'evening', 21),
  ('Bring back inside "No outside food" signs',              'closing', 'evening', 22)
) as v(title, category, period, sort_order)
where not exists (
  select 1 from assignment_tasks t
  where t.category = v.category and lower(t.title) = lower(v.title)
);
