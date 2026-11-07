alter table public.employee_accounts
  add column if not exists pending_notice jsonb;

comment on column public.employee_accounts.pending_notice is 'Stores pending notification for password or role changes made by admin';
