# Supabase setup

## Existing schema mapping

The portals use the existing tables and do not insert seed rows:

- `employees`: `employee_id` (UUID), `employee_code`, `full_name`, `email`, `hire_date`, `employment_status`, `gender`, `date_of_birth`. The migration adds `position_id` and `education`.
- `positions` and `departments`: `positions.position_id`, `position_title`, `department_id`; department names come from `departments.department_name`.
- `employee_contacts`: `employee_id`, `phone_number`, `address`.
- `user_roles`, `roles`, `role_permissions`, `permissions`: existing role and permission assignments.
- `attendance_records`: daily attendance by `employee_id`, `work_date`, `status`, `overtime_hours`, `notes`.
- `leave_requests`: existing dates, reason, status and approver. The migration adds `leave_type` and `reviewed_at`.
- `payroll`: `employee_id`, `pay_year`, `pay_month`, `base_salary`, `bonus`, `overtime_pay`, `gross_salary`, `net_salary`. The migration adds attendance and deduction details.

## Apply migration

Review and run `database/migrations/20261017_hr_existing_tables.sql` once in Supabase **SQL Editor**. It only adds HR columns/indexes/functions/policies to existing tables; it does not insert or update employee/payroll rows. Existing payroll rows with no `pay_year` remain unclassified and will not be backfilled automatically. Back up the project before applying schema changes.

The HR manager needs an Auth user whose email matches `employees.email`, plus a `user_roles` assignment to a role named `manager`, `hr_manager`, `Quản lý`, or `Quản lý nhân sự`, or a role with a permission code such as `manager`, `hr_manager`, `manage_staff`, or `manage_employees`. Other system admins do not automatically receive HR access. Staff Auth accounts are linked to employees by matching email. Add the employee's `position_id` and `employee_contacts` row as needed.

The staff UI reads these permission-code aliases: `profile`/`view_profile`, `leave`/`submit_leave`, `salary_month`/`view_monthly_payroll`/`view_payroll`, and `salary_year`/`view_annual_payroll`/`view_payroll_yearly`. To let an employee view salary statements, assign the relevant payroll view permissions to their role. The staff portal queries monthly and annual payroll for the signed-in employee, and the payroll RLS policy limits staff to their own rows. Managers create the saved monthly payroll record from the manager portal; employees can view and print its pay components and calculation details.

The project URL and browser-safe publishable key are in `shared/js/supabase-config.js`. Never put a Supabase secret/service-role key in browser code or commit one. A secret key was shared in chat; revoke/rotate it in Supabase.

Run the site over HTTP (for example, VS Code Live Server). Do not open the portals through `file://`.
