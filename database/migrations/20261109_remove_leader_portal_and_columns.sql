-- Migration: Remove leader portal columns and revert portal_login
-- 1. Drop leader review columns from public.leave_requests
alter table if exists public.leave_requests
  drop column if exists leader_status cascade,
  drop column if exists leader_reviewed_by cascade,
  drop column if exists leader_reviewed_at cascade;

-- 2. Drop leader review index and constraint if still present
drop index if exists public.leave_requests_leader_review_idx;
alter table if exists public.leave_requests
  drop constraint if exists leave_requests_leader_status_check;

-- 3. Restore portal_login: Leader uses staff portal, manager/admin use their respective portals
create or replace function public.portal_login(p_username text, p_password text)
returns json
language plpgsql
security definer
set search_path = 'public', 'extensions', 'pg_temp'
as $function$
declare
  v_acc public.employee_accounts%rowtype;
  v_emp public.employees%rowtype;
  v_today date := (now() at time zone 'Asia/Ho_Chi_Minh')::date;
  v_portals text[];
  v_is_admin boolean;
  v_is_manager boolean;
begin
  select a.* into v_acc
  from public.employee_accounts a
  left join public.employees e on e.employee_id = a.employee_id
  where lower(a.username) = lower(trim(coalesce(p_username, '')))
     or lower(e.email) = lower(trim(coalesce(p_username, '')))
  limit 1;

  if not found or v_acc.password_hash is null or not v_acc.is_active then
    perform crypt(coalesce(p_password, ''), gen_salt('bf', 10));
    return json_build_object('ok', false, 'error', 'invalid_credentials');
  end if;

  if v_acc.locked_until is not null and v_acc.locked_until > now() then
    return json_build_object('ok', false, 'error', 'account_locked');
  end if;

  if v_acc.password_hash <> crypt(coalesce(p_password, ''), v_acc.password_hash) then
    update public.employee_accounts
    set failed_attempts = failed_attempts + 1,
        locked_until = case when failed_attempts + 1 >= 5 then now() + interval '15 minutes' else null end
    where employee_id = v_acc.employee_id;
    return json_build_object('ok', false, 'error', 'invalid_credentials');
  end if;

  select * into v_emp
  from public.employees
  where employee_id = v_acc.employee_id and employment_status = 'Active';

  if v_emp.employee_id is null then
    return json_build_object('ok', false, 'error', 'invalid_credentials');
  end if;

  select
    exists (
      select 1
      from public.user_roles ur
      join public.roles r on r.role_id = ur.role_id
      where ur.employee_id = v_emp.employee_id
        and r.role_name = 'Admin'
        and ur.valid_from <= v_today
        and (ur.valid_to is null or ur.valid_to >= v_today)
    ),
    exists (
      select 1
      from public.user_roles ur
      join public.roles r on r.role_id = ur.role_id
      where ur.employee_id = v_emp.employee_id
        and lower(r.role_name) in ('manager', 'hr_manager', 'quản lý', 'quản lý nhân sự')
        and ur.valid_from <= v_today
        and (ur.valid_to is null or ur.valid_to >= v_today)
    ) or exists (
      select 1
      from public.user_roles ur
      join public.role_permissions rp on rp.role_id = ur.role_id
      join public.permissions p on p.permission_id = rp.permission_id
      where ur.employee_id = v_emp.employee_id
        and lower(p.permission_code) in ('manager', 'hr_manager', 'manage_staff', 'manage_employees')
        and ur.valid_from <= v_today
        and (ur.valid_to is null or ur.valid_to >= v_today)
    )
  into v_is_admin, v_is_manager;

  v_portals := array['staff'];
  if v_is_admin then
    v_portals := array['admin'];
  elsif v_is_manager then
    v_portals := array['manager'];
  end if;

  update public.employee_accounts
  set failed_attempts = 0, locked_until = null, last_login = now()
  where employee_id = v_acc.employee_id;

  return json_build_object(
    'ok', true,
    'employee_id', v_emp.employee_id,
    'username', v_acc.username,
    'full_name', v_emp.full_name,
    'portals', to_json(v_portals)
  );
end;
$function$;
