-- ============================================================
-- Migration 051 — Close a count sheet without counting
-- ============================================================
-- The employee a sheet is assigned to can cancel the count from the
-- phone by giving a reason (js: mobile/js/countsheets.js). The sheet
-- moves to 'closed' with their message, nothing is applied to
-- inventory, and the person who built it is told by push
-- (api/notify-count-sheet.js, event 'closed'). 'closed' is the
-- counter walking away; 'cancelled' stays the builder withdrawing it.
-- The builder can reassign a closed sheet, which reopens it.
-- Requires migration 050. Safe to re-run.

alter table inventory_count_sheets drop constraint if exists inventory_count_sheets_status_check;
alter table inventory_count_sheets add constraint inventory_count_sheets_status_check
  check (status in ('assigned','submitted','cancelled','closed'));

alter table inventory_count_sheets
  add column if not exists close_reason text,
  add column if not exists closed_at timestamptz,
  add column if not exists closed_by uuid references staff_profiles(id) on delete set null;

create or replace function close_count_sheet(p_sheet_id uuid, p_reason text)
returns void as $$
declare
  s inventory_count_sheets;
begin
  if not is_staff() then raise exception 'Not allowed'; end if;
  if length(trim(coalesce(p_reason, ''))) < 3 then raise exception 'Please say why you are closing this count'; end if;
  select * into s from inventory_count_sheets where id = p_sheet_id for update;
  if not found then raise exception 'Count sheet not found'; end if;
  if s.status <> 'assigned' then raise exception 'This count sheet is already %', s.status; end if;

  update inventory_count_sheets
  set status = 'closed', close_reason = left(trim(p_reason), 240), closed_at = now(), closed_by = auth.uid()
  where id = s.id;
end;
$$ language plpgsql security definer;
