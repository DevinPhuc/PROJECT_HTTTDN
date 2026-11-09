-- 1. Update role description for 'Quản lý'
update public.roles
set description = 'Quản lý nhân sự của phòng ban mình'
where lower(role_name) in ('quản lý', 'manager', 'hr_manager', 'quản lý nhân sự')
   or description = 'Trưởng phòng: dữ liệu phòng ban, duyệt đơn nghỉ phép, không xem lương';

-- 2. Update role description for 'Trưởng nhóm'
update public.roles
set description = 'Giám sát thành viên nhóm'
where lower(role_name) in ('trưởng nhóm', 'leader', 'team_lead', 'team leader', 'team_leader')
   or description = 'Giám sát nhóm: chấm công và duyệt đơn nghỉ phép của phòng ban';

-- 3. Insert permission 'Phân công công việc' if not exists
insert into public.permissions (permission_code, module_name, action, description)
values ('task.assign', 'Công việc', 'Edit', 'Phân công công việc')
on conflict (permission_code) do update
set description = excluded.description,
    module_name = excluded.module_name,
    action = excluded.action;

-- 4. Assign 'Phân công công việc' to 'Trưởng nhóm' role
insert into public.role_permissions (role_id, permission_id)
select r.role_id, p.permission_id
from public.roles r
cross join public.permissions p
where (lower(r.role_name) in ('trưởng nhóm', 'leader', 'team_lead', 'team leader', 'team_leader')
       or r.description = 'Giám sát thành viên nhóm')
  and p.permission_code = 'task.assign'
on conflict do nothing;
