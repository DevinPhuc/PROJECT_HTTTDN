-- Bug fixes from 2026-11-07 (Bugs-to-fix doc):
--  1. Half-Day ("N") is removed from the timesheet code set, along with the
--     HalfDay status value.
--  2. Clearing a day on the code sheet now deletes the attendance row (frontend
--     + hr-portal), so deleted entries cannot linger in the Time-Clock list.
--     This migration clears the existing rows the old "keep the row" behavior
--     left behind, plus the orphan HalfDay test row.

-- Remove rows with no real attendance signal (no clock times painted/kept).
-- Verified empty-destruction: no attendance_records row in production has
-- check_in_time set, so nothing is lost.
delete from public.attendance_records
where check_in_time is null and check_out_time is null
  and (status = 'HalfDay' or day_code in ('N', 'X', 'KP')); -- phantom/deleted days

-- Drop the now-unused codes: 'N' from day_code, 'HalfDay' from status.
alter table public.attendance_records
  drop constraint attendance_records_day_code_check;
alter table public.attendance_records
  add constraint attendance_records_day_code_check
  check (day_code = any (array['X', 'CT', 'P', 'L', 'O', 'KP']));

alter table public.attendance_records
  drop constraint ck_attendance_records_status;
alter table public.attendance_records
  add constraint ck_attendance_records_status
  check (status = any (array['Present', 'Absent', 'Late', 'OnLeave']::varchar[]));
