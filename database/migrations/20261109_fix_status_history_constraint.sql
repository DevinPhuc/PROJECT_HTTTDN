-- Fix check constraint on public.hr_employment_status_history to be case-insensitive
alter table public.hr_employment_status_history
  drop constraint if exists hr_employment_status_history_employment_status_check;

alter table public.hr_employment_status_history
  add constraint hr_employment_status_history_employment_status_check
  check (lower(employment_status) in ('active', 'on_leave', 'resigned'));
