alter table public.employees
  add column if not exists position_id uuid references public.positions(position_id) on delete set null,
  add column if not exists education text;

alter table public.leave_requests
  add column if not exists leave_type text,
  add column if not exists reviewed_at timestamptz;

alter table public.payroll
  add column if not exists pay_year smallint,
  add column if not exists work_days numeric(6, 2),
  add column if not exists standard_days numeric(6, 2),
  add column if not exists overtime_hours numeric(7, 2) not null default 0,
  add column if not exists insurance_rate numeric(5, 2) not null default 10.5,
  add column if not exists insurance_amount numeric(14, 2) not null default 0,
  add column if not exists personal_income_tax numeric(14, 2) not null default 0,
  add column if not exists total_deductions numeric(14, 2);

alter table public.leave_requests
  add constraint leave_requests_leave_type_check
  check (leave_type is null or leave_type in ('annual', 'sick', 'maternity', 'resignation'));

create index if not exists employees_position_id_idx on public.employees(position_id);
create index if not exists attendance_records_employee_date_idx on public.attendance_records(employee_id, work_date);
create index if not exists leave_requests_employee_start_date_idx on public.leave_requests(employee_id, start_date);
create index if not exists payroll_employee_year_month_idx on public.payroll(employee_id, pay_year, pay_month);

create or replace function public.current_employee_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select employee_id
  from public.employees
  where lower(email) = lower(auth.jwt() ->> 'email')
  limit 1;
$$;

create or replace function public.has_hr_role(p_role_names text[])
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.user_roles ur
    join public.roles r on r.role_id = ur.role_id
    where ur.employee_id = public.current_employee_id()
      and lower(r.role_name) = any (select lower(input.role_name) from unnest(p_role_names) as input(role_name))
  );
$$;

create or replace function public.has_hr_permission(p_permission_codes text[])
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.has_hr_role(array['manager', 'hr_manager', 'quản lý', 'quản lý nhân sự'])
    or exists (
    select 1
    from public.user_roles ur
    join public.role_permissions rp on rp.role_id = ur.role_id
    join public.permissions p on p.permission_id = rp.permission_id
    where ur.employee_id = public.current_employee_id()
      and lower(p.permission_code) = any (select lower(input.code) from unnest(p_permission_codes) as input(code))
    );
$$;

create or replace function public.update_my_hr_profile(
  p_full_name text,
  p_phone_number text,
  p_address text,
  p_date_of_birth date
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  employee_uuid uuid := public.current_employee_id();
  contact_row_id uuid;
begin
  if employee_uuid is null then
    raise exception 'Employee profile not found';
  end if;

  update public.employees
  set full_name = p_full_name,
      date_of_birth = p_date_of_birth,
      updated_at = now()
  where employee_id = employee_uuid;

  select employee_id into contact_row_id
  from public.employee_contacts
  where employee_id = employee_uuid
  limit 1;

  if contact_row_id is null then
    insert into public.employee_contacts(employee_id, phone_number, address)
    values (employee_uuid, p_phone_number, p_address);
  else
    update public.employee_contacts
    set phone_number = p_phone_number,
        address = p_address
    where employee_id = employee_uuid;
  end if;
end;
$$;

grant execute on function public.current_employee_id() to authenticated;
grant execute on function public.has_hr_role(text[]) to authenticated;
grant execute on function public.has_hr_permission(text[]) to authenticated;
grant execute on function public.update_my_hr_profile(text, text, text, date) to authenticated;

grant select on public.employees, public.employee_contacts, public.positions, public.departments,
  public.user_roles, public.roles, public.role_permissions, public.permissions to authenticated;
grant select, insert, update, delete on public.employees, public.employee_contacts,
  public.leave_requests, public.attendance_records, public.payroll, public.user_roles,
  public.role_permissions to authenticated;

alter table public.employees enable row level security;
alter table public.employee_contacts enable row level security;
alter table public.leave_requests enable row level security;
alter table public.attendance_records enable row level security;
alter table public.payroll enable row level security;
alter table public.user_roles enable row level security;
alter table public.role_permissions enable row level security;

alter table public.positions enable row level security;
alter table public.departments enable row level security;
alter table public.roles enable row level security;
alter table public.permissions enable row level security;

drop policy if exists positions_select_authenticated on public.positions;
create policy positions_select_authenticated on public.positions for select to authenticated using (true);

drop policy if exists departments_select_authenticated on public.departments;
create policy departments_select_authenticated on public.departments for select to authenticated using (true);

drop policy if exists roles_select_authenticated on public.roles;
create policy roles_select_authenticated on public.roles for select to authenticated using (true);

drop policy if exists permissions_select_authenticated on public.permissions;
create policy permissions_select_authenticated on public.permissions for select to authenticated using (true);

drop policy if exists user_roles_select_self_or_hr on public.user_roles;
create policy user_roles_select_self_or_hr on public.user_roles for select to authenticated
using (employee_id = public.current_employee_id() or public.has_hr_permission(array['manage_staff', 'manage_employees', 'manager', 'hr_manager']));

drop policy if exists user_roles_manage_hr on public.user_roles;
create policy user_roles_manage_hr on public.user_roles for all to authenticated
using (public.has_hr_permission(array['manage_staff', 'manage_employees', 'manager', 'hr_manager']))
with check (public.has_hr_permission(array['manage_staff', 'manage_employees', 'manager', 'hr_manager']));

drop policy if exists role_permissions_select_authenticated on public.role_permissions;
create policy role_permissions_select_authenticated on public.role_permissions for select to authenticated
using (true);

drop policy if exists role_permissions_manage_hr on public.role_permissions;
create policy role_permissions_manage_hr on public.role_permissions for all to authenticated
using (public.has_hr_permission(array['manage_staff', 'manage_employees', 'manager', 'hr_manager']))
with check (public.has_hr_permission(array['manage_staff', 'manage_employees', 'manager', 'hr_manager']));

 drop policy if exists employees_select_self_or_hr on public.employees;
create policy employees_select_self_or_hr on public.employees for select to authenticated
using (employee_id = public.current_employee_id() or public.has_hr_permission(array['manage_staff', 'manage_employees', 'manager', 'hr_manager']));

drop policy if exists employees_insert_hr on public.employees;
create policy employees_insert_hr on public.employees for insert to authenticated
with check (public.has_hr_permission(array['manage_staff', 'manage_employees', 'manager', 'hr_manager']));

drop policy if exists employees_update_hr on public.employees;
create policy employees_update_hr on public.employees for update to authenticated
using (public.has_hr_permission(array['manage_staff', 'manage_employees', 'manager', 'hr_manager']))
with check (public.has_hr_permission(array['manage_staff', 'manage_employees', 'manager', 'hr_manager']));

drop policy if exists employees_delete_hr on public.employees;
create policy employees_delete_hr on public.employees for delete to authenticated
using (public.has_hr_permission(array['manage_staff', 'manage_employees', 'manager', 'hr_manager']));

drop policy if exists employee_contacts_select_self_or_hr on public.employee_contacts;
create policy employee_contacts_select_self_or_hr on public.employee_contacts for select to authenticated
using (employee_id = public.current_employee_id() or public.has_hr_permission(array['manage_staff', 'manage_employees', 'manager', 'hr_manager']));

drop policy if exists employee_contacts_manage_self_or_hr on public.employee_contacts;
create policy employee_contacts_manage_self_or_hr on public.employee_contacts for all to authenticated
using (employee_id = public.current_employee_id() or public.has_hr_permission(array['manage_staff', 'manage_employees', 'manager', 'hr_manager']))
with check (employee_id = public.current_employee_id() or public.has_hr_permission(array['manage_staff', 'manage_employees', 'manager', 'hr_manager']));

drop policy if exists leave_requests_select_self_or_hr on public.leave_requests;
create policy leave_requests_select_self_or_hr on public.leave_requests for select to authenticated
using (employee_id = public.current_employee_id() or public.has_hr_permission(array['approve_leave', 'manage_staff', 'manage_employees', 'manager', 'hr_manager']));

drop policy if exists leave_requests_insert_self on public.leave_requests;
create policy leave_requests_insert_self on public.leave_requests for insert to authenticated
with check (employee_id = public.current_employee_id());

drop policy if exists leave_requests_update_hr on public.leave_requests;
create policy leave_requests_update_hr on public.leave_requests for update to authenticated
using (public.has_hr_permission(array['approve_leave', 'manage_staff', 'manage_employees', 'manager', 'hr_manager']))
with check (public.has_hr_permission(array['approve_leave', 'manage_staff', 'manage_employees', 'manager', 'hr_manager']));

drop policy if exists attendance_records_select_self_or_hr on public.attendance_records;
create policy attendance_records_select_self_or_hr on public.attendance_records for select to authenticated
using (employee_id = public.current_employee_id() or public.has_hr_permission(array['attendance', 'manage_staff', 'manage_employees', 'manager', 'hr_manager']));

drop policy if exists attendance_records_manage_hr on public.attendance_records;
create policy attendance_records_manage_hr on public.attendance_records for all to authenticated
using (public.has_hr_permission(array['attendance', 'manage_staff', 'manage_employees', 'manager', 'hr_manager']))
with check (public.has_hr_permission(array['attendance', 'manage_staff', 'manage_employees', 'manager', 'hr_manager']));

drop policy if exists payroll_select_self_or_hr on public.payroll;
create policy payroll_select_self_or_hr on public.payroll for select to authenticated
using (employee_id = public.current_employee_id() or public.has_hr_permission(array['payroll', 'manage_staff', 'manage_employees', 'manager', 'hr_manager']));

drop policy if exists payroll_manage_hr on public.payroll;
create policy payroll_manage_hr on public.payroll for all to authenticated
using (public.has_hr_permission(array['payroll', 'manage_staff', 'manage_employees', 'manager', 'hr_manager']))
with check (public.has_hr_permission(array['payroll', 'manage_staff', 'manage_employees', 'manager', 'hr_manager']));

-- No seed rows are inserted. Create staff, roles, permissions and assignments using the existing HR screens/tables.
-- Existing leave requests keep a null leave_type until an administrator classifies them.
-- Existing payroll rows keep pay_year null because their year cannot be inferred from pay_month alone.
