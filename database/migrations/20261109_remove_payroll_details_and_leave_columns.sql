-- Drop columns and constraint no longer needed:
-- 1. payroll_details: quantity, rate_multiplier, and ck_payroll_details_quantity
-- 2. leave_requests: medical_ref

alter table if exists public.payroll_details
  drop constraint if exists ck_payroll_details_quantity;

alter table if exists public.payroll_details
  drop column if exists quantity,
  drop column if exists rate_multiplier;

alter table if exists public.leave_requests
  drop column if exists medical_ref;
