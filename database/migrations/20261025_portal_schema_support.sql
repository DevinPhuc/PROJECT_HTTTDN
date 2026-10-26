-- Schema support for the staff/manager portals against the live business_rules
-- schema (the UIs were originally written against database/migrations/
-- 20261017_hr_existing_tables.sql, which was never applied):
-- 1. payroll gains the self-service breakdown columns the staff UI displays.
-- 2. leave_types is seeded with the four leave kinds the staff UI offers,
--    so leave forms can resolve leave_type_id and pass the num_days/salary
--    guard triggers.
alter table public.payroll
  add column if not exists work_days numeric(6, 2),
  add column if not exists standard_days numeric(6, 2),
  add column if not exists insurance_amount numeric(14, 2) not null default 0,
  add column if not exists personal_income_tax numeric(14, 2) not null default 0;

-- Statutory-ish defaults (Điều 113/149 Bo Luat Lao Dong): annual 12y, sick 30y
-- (medical document required before approval), maternity 180d fixed and
-- insurance-paid, resignation single-day notice. Adjust values as needed;
-- inserts are guarded so reruns do not duplicate rows.
insert into public.leave_types (type_name, max_days_per_year, is_paid, legal_basis, fixed_days, is_insurance_paid, requires_document)
select 'Nghỉ phép', 12, true, 'Điều 113 Bộ luật Lao động 2019', null, false, false
where not exists (select 1 from public.leave_types where type_name = 'Nghỉ phép');

insert into public.leave_types (type_name, max_days_per_year, is_paid, legal_basis, fixed_days, is_insurance_paid, requires_document)
select 'Nghỉ ốm đau', 30, true, 'Điều 132 Bộ luật Lao động 2019', null, false, true
where not exists (select 1 from public.leave_types where type_name = 'Nghỉ ốm đau');

insert into public.leave_types (type_name, max_days_per_year, is_paid, legal_basis, fixed_days, is_insurance_paid, requires_document)
select 'Nghỉ thai sản', null, true, 'Điều 139 Bộ luật Lao động 2019', 180, true, false
where not exists (select 1 from public.leave_types where type_name = 'Nghỉ thai sản');

insert into public.leave_types (type_name, max_days_per_year, is_paid, legal_basis, fixed_days, is_insurance_paid, requires_document)
select 'Xin nghỉ việc', null, false, 'Điều 35 Bộ luật Lao động 2019', 1, false, false
where not exists (select 1 from public.leave_types where type_name = 'Xin nghỉ việc');

comment on column public.payroll.work_days is 'Worked days this pay period; entered from the manager portal.';
comment on column public.payroll.standard_days is 'Standard days for the pay period; entered from the manager portal.';
