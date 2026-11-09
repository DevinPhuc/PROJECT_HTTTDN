-- 1. Update description for attendance.self to 'Chấm công ra/vào'
update public.permissions
set description = 'Chấm công ra/vào'
where permission_code = 'attendance.self';

-- 2. Insert the 8 admin permissions
insert into public.permissions (permission_code, module_name, action, description)
values
  ('admin.01_account_create', 'Hệ thống', 'Create', 'Thêm tài khoản nhân sự mới'),
  ('admin.02_account_edit', 'Hệ thống', 'Edit', 'Chỉnh sửa thông tin nhân sự'),
  ('admin.03_role_assign', 'Hệ thống', 'Edit', 'Phân quyền nhân sự'),
  ('admin.04_employee_view_all', 'Hệ thống', 'View', 'Xem toàn bộ nhân viên của hệ thống'),
  ('admin.05_account_delete_restore', 'Hệ thống', 'Delete', 'Xóa/Khôi phục tài khoản nhân sự'),
  ('admin.06_account_lock', 'Hệ thống', 'Edit', 'Khóa/Mở khóa tài khoản nhân sự'),
  ('admin.07_employee_permanent_delete', 'Hệ thống', 'Delete', 'Xóa vĩnh viễn nhân sự'),
  ('admin.08_employee_search', 'Hệ thống', 'View', 'Tìm kiếm nhân sự')
on conflict (permission_code) do update
set description = excluded.description,
    module_name = excluded.module_name,
    action = excluded.action;

-- 3. Clear old role_permissions for Admin
delete from public.role_permissions
where role_id = (select role_id from public.roles where lower(role_name) = 'admin');

-- 4. Assign the 8 admin permissions to Admin role
insert into public.role_permissions (role_id, permission_id)
select r.role_id, p.permission_id
from public.roles r
cross join public.permissions p
where lower(r.role_name) = 'admin'
  and p.permission_code in (
    'admin.01_account_create',
    'admin.02_account_edit',
    'admin.03_role_assign',
    'admin.04_employee_view_all',
    'admin.05_account_delete_restore',
    'admin.06_account_lock',
    'admin.07_employee_permanent_delete',
    'admin.08_employee_search'
  );
