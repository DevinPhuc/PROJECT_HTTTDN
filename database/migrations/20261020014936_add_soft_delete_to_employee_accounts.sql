-- Soft delete for admin account management: the row stays visible in the account
-- list, is_active is set to false, and admin_login refuses the account.
alter table public.employee_accounts
  add column if not exists deleted_at timestamptz;

comment on column public.employee_accounts.deleted_at is 'Set when the account is soft deleted; the row stays in the admin list but admin_login refuses it.';
