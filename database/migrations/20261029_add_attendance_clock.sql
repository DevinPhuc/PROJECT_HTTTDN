-- Chấm công: employee self clock-in/out.
-- Adds full timestamps (date + time) next to the legacy check_in_time/
-- check_out_time time columns plus a self clock permission for staff roles.
-- Run once in the Supabase SQL editor.

alter table public.attendance_records
  add column if not exists clock_in  timestamptz,
  add column if not exists clock_out timestamptz;

insert into public.permissions (permission_code, module_name, action, description)
select 'attendance.self', 'Chấm công', 'View', 'Chấm công vào/ra của nhân viên'
where not exists (
  select 1 from public.permissions where lower(permission_code) = 'attendance.self'
);

-- Grant to every role that already has the basic employee permission.
insert into public.role_permissions (role_id, permission_id)
select r.role_id, p.permission_id
from public.roles r
join public.permissions p
  on lower(p.permission_code) = 'attendance.self'
where exists (
  select 1 from public.role_permissions rp
  join public.permissions pp on pp.permission_id = rp.permission_id
  where rp.role_id = r.role_id and lower(pp.permission_code) = 'employee.view'
)
and not exists (
  select 1 from public.role_permissions rp
  join public.permissions p2 on p2.permission_id = rp.permission_id
  where rp.role_id = r.role_id and lower(p2.permission_code) = 'attendance.self'
);
