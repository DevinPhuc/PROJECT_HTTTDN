# Supabase setup

## Existing schema mapping

The portals use the existing tables and do not insert seed rows:

- `employees`: `employee_id` (UUID), `employee_code`, `full_name`, `email`, `hire_date`, `employment_status`, `gender`, `date_of_birth`. The migration adds `position_id` and `education`.
- `positions` and `departments`: `positions.position_id`, `position_title`, `department_id`; department names come from `departments.department_name`.
- `employee_contacts`: `employee_id`, `phone_number`, `address`.
- `user_roles`, `roles`, `role_permissions`, `permissions`: existing role and permission assignments.
- `attendance_records`: daily attendance by `employee_id`, `work_date`, `status`, `overtime_hours`, `notes`, plus `check_in_time`/`check_out_time` (time of day, Asia/Ho_Chi_Minh) for employee self clock-in/out.
- `leave_requests`: existing dates, reason, status and approver. The migration adds `leave_type` and `reviewed_at`.
- `payroll`: `employee_id`, `pay_year`, `pay_month`, `base_salary`, `bonus`, `overtime_pay`, `gross_salary`, `net_salary`. The migration adds attendance and deduction details.

## Apply migration

Review and run `database/migrations/20261017_hr_existing_tables.sql` and then `database/migrations/20261029_hr_reporting_and_status_history.sql` once in Supabase **SQL Editor**. The second migration adds employment-status history and records each existing employee's current status starting on the migration date (or later hire date). Older status changes cannot be reconstructed; monthly reports before the recorded starting date mark that employee's status as unknown instead of inferring it from today's profile. The migration does not change employee or payroll rows. Existing payroll rows with no `pay_year` remain unclassified and will not be backfilled automatically. Back up the project before applying schema changes.

The manager's monthly report counts activity across the selected month (through today's Vietnam date for the current month): employees with an active status interval during the month, approved leave requests that overlap the month, and resignations effective during the month. These groups can overlap; for example, someone who worked before taking leave or resigned later in the month may appear in more than one count. Earlier months without recorded status are marked unknown instead of inferred from today's profile. The report can be filtered and downloaded as CSV. Status changes made in the employee form take effect on the current Vietnam calendar date. The profile statistics include education and seniority distributions, and use the latest payroll period with both year and month recorded for base salary. Unclassified rows are excluded; employees without a classified payroll period are shown as missing salary data. The table can be searched, filtered by education, and downloaded as CSV. For employees already resigned before the migration, recorded tenure ends at the migration baseline unless the original exit date is entered from a verified HR record.

The permissions screen compares current permissions with the selected role's permissions, previews added and removed permissions, and shows role assignment history. Assigning a role to an employee does not change the shared role definition. Role permissions are shared by everyone with that role and remain centrally configured; changing a role's permission set affects all assignees. The edge function prevents department managers from assigning Admin or HR-manager roles. Admin can assign those roles and can edit shared role permissions through the admin portal.

The HR manager needs an Auth user whose email matches `employees.email`, plus a `user_roles` assignment to a role named `manager`, `hr_manager`, `Quản lý`, or `Quản lý nhân sự`, or a role with a permission code such as `manager`, `hr_manager`, `manage_staff`, or `manage_employees`. Other system admins do not automatically receive HR access. Staff Auth accounts are linked to employees by matching email. Add the employee's `position_id` and `employee_contacts` row as needed.

The staff UI reads these permission-code aliases (must match `permissions.permission_code` in the DB): `employee.view`/`employee.edit` for profile, `attendance.self` for self clock-in/out, `leave.create`/`leave.view` for leave, `payroll.view` for monthly payroll, and `payroll.print`/`payroll.view` for annual payroll.

The project URL and browser-safe publishable key are in `shared/js/supabase-config.js`. Never put a Supabase secret/service-role key in browser code or commit one. A secret key was shared in chat; revoke/rotate it in Supabase.

Run the site over HTTP (for example, VS Code Live Server). Do not open the portals through `file://`.
