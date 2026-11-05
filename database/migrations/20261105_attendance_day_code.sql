-- Bảng chấm công (manager portal): painted day codes X/N/CT/P/L/O/KP.
-- day_code is the sheet's source of truth; status stays in sync via the
-- edge function's map so existing views keep working.
-- Run once in the Supabase SQL editor.

alter table public.attendance_records
  add column if not exists day_code text;

-- Lock historical values; legacy rows keep day_code NULL (fallback by status).
alter table public.attendance_records
  drop constraint if exists attendance_records_day_code_check;
alter table public.attendance_records
  add constraint attendance_records_day_code_check
  check (day_code in ('X', 'N', 'CT', 'P', 'L', 'O', 'KP'));
