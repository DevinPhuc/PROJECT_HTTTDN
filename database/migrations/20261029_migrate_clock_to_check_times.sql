-- Chấm công: move the self clock-in/out timestamps to the legacy
-- check_in_time / check_out_time columns (time-of-day, Asia/Ho_Chi_Minh),
-- then drop the timestamptz clock_in / clock_out columns.
-- Run once in the Supabase SQL editor; keep the verify select before dropping.

update public.attendance_records
set check_in_time  = case when clock_in  is null then check_in_time  else (clock_in  at time zone 'Asia/Ho_Chi_Minh')::time end,
    check_out_time = case when clock_out is null then check_out_time else (clock_out at time zone 'Asia/Ho_Chi_Minh')::time end
where clock_in is not null or clock_out is not null;

-- Verify before dropping: work_date, clock_in, check_in_time, clock_out, check_out_time
-- must match for every row the update touched.
select work_date, clock_in, check_in_time, clock_out, check_out_time
from public.attendance_records
where clock_in is not null or clock_out is not null;

alter table public.attendance_records
  drop column if exists clock_in,
  drop column if exists clock_out;
