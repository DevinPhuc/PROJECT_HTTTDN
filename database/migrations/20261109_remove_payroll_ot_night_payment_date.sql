-- Drop overtime_pay, night_pay, and payment_date from public.payroll
alter table if exists public.payroll
  drop column if exists overtime_pay cascade,
  drop column if exists night_pay cascade,
  drop column if exists payment_date cascade;
