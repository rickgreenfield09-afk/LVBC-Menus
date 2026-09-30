-- migration_032_open_shifts.sql
-- Lets a scheduler leave a shift unassigned (staff_id null) and lets
-- any staffer claim it for themselves. claimed_by/claimed_at record
-- that a shift started open and was later picked up, independent of
-- who currently holds it, so the Metrics dashboard can count "open
-- shifts claimed" without parsing audit_log.

alter table shifts add column if not exists claimed_by uuid references staff_profiles(id) on delete set null;
alter table shifts add column if not exists claimed_at timestamptz;

-- The existing "schedulers write shifts" policy already covers admins
-- doing anything (including claiming on someone's behalf). This adds
-- a narrow allowance for any staffer to claim a shift that is
-- currently open, only onto themselves.
create policy "staff claim open shifts" on shifts for update
  using (is_staff() and staff_id is null)
  with check (staff_id = auth.uid() and claimed_by = auth.uid());
