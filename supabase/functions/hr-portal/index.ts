// POST /functions/v1/hr-portal
// Header: x-admin-token (HS256 session token issued by admin-login portal mode).
// Body:   { action, ... }
//   boot:            full lookup snapshot (employees, contacts, positions,
//                    departments, roles, permissions, assignments, leave
//                    requests, payroll, attendance) for the manager's scope
//   employee_save:   create/update employee (+ contact upsert + role assign)
//   employee_delete: remove an employee and its dependent rows
//   role_assign:     replace an employee's role assignment
//   permissions_save: sync a role's permissions (assigning the role if needed)
//   leave_review:    approve/reject a leave request
//   attendance_save: upsert one attendance record for a work date
//   payroll_save:    upsert one payroll row for a month
// The function connects as a trusted backend (RLS bypassed): managers are
// gated here (server side) and see only their department's employees; Admin
// role users see everything. Leave/attendance/payroll guard triggers still
// fire on every write.
import postgres from "npm:postgres@3";
import { jwtVerify } from "npm:jose@5";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-admin-token",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

const SUPABASE_DB_URL = Deno.env.get("SUPABASE_DB_URL");
const ADMIN_JWT_SECRET = Deno.env.get("ADMIN_JWT_SECRET");

// One connection per warm instance; transaction-mode pooling does not support prepared statements.
const sql = SUPABASE_DB_URL
  ? postgres(SUPABASE_DB_URL, { max: 1, prepare: false, ssl: "require" })
  : null;

const JWT_KEY = ADMIN_JWT_SECRET ? new TextEncoder().encode(ADMIN_JWT_SECRET) : null;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Same membership rule portal_login used for the manager portal.
const MANAGER_ROLES = ["manager", "hr_manager", "quản lý", "quản lý nhân sự"];
const MANAGER_PERMISSIONS = ["manager", "hr_manager", "manage_staff", "manage_employees"];

// Live check constraints expect exactly these values.
const EMPLOYMENT_STATUS: Record<string, string> = { active: "Active", on_leave: "OnLeave", resigned: "Resigned" };
const ATTENDANCE_STATUS: Record<string, string> = {
  present: "Present", absent: "Absent", late: "Late", halfday: "HalfDay", on_leave: "OnLeave",
};

type Actor = {
  employee_id: string;
  full_name: string;
  department_id: string | null; // null ⇒ Admin role ⇒ sees everything
};

function makeError(code: string): Error {
  return Object.assign(new Error(code), { code });
}

function isUUID(value: string): boolean {
  return UUID_RE.test(value);
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function isRealDate(value: string): boolean {
  if (!DATE_RE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

async function getActor(token: string): Promise<Actor | null> {
  let employeeId = "";
  try {
    const { payload } = await jwtVerify(token, JWT_KEY!, { algorithms: ["HS256"] });
    employeeId = typeof payload.employee_id === "string" ? payload.employee_id : "";
  } catch {
    return null;
  }
  if (!UUID_RE.test(employeeId)) return null;

  const rows = await sql!`
    select e.employee_id, e.full_name, e.current_department_id
    from public.employees e
    join public.employee_accounts a on a.employee_id = e.employee_id
    where e.employee_id = ${employeeId}::uuid
      and a.is_active is true
      and a.deleted_at is null
      and e.employment_status = 'Active'
    limit 1`;

  const row = rows[0] as undefined | { employee_id: string; full_name: string; current_department_id: string };
  if (!row) return null;

  const [adminCheck] = await sql!`
    select true as is_admin
    where exists (
      select 1 from public.user_roles ur
      join public.roles r on r.role_id = ur.role_id
      where ur.employee_id = ${row.employee_id}::uuid and r.role_name = 'Admin'
        and ur.valid_from <= (now() at time zone 'Asia/Ho_Chi_Minh')::date
        and (ur.valid_to is null or ur.valid_to >= (now() at time zone 'Asia/Ho_Chi_Minh')::date))`;

  const [managerCheck] = await sql!`
    select true as is_manager
    where exists (
      select 1 from public.user_roles ur
      join public.roles r on r.role_id = ur.role_id
      where ur.employee_id = ${row.employee_id}::uuid
        and lower(r.role_name) = any(${sql.array(MANAGER_ROLES)})
        and ur.valid_from <= (now() at time zone 'Asia/Ho_Chi_Minh')::date
        and (ur.valid_to is null or ur.valid_to >= (now() at time zone 'Asia/Ho_Chi_Minh')::date))
       or exists (
      select 1 from public.user_roles ur
      join public.role_permissions rp on rp.role_id = ur.role_id
      join public.permissions p on p.permission_id = rp.permission_id
      where ur.employee_id = ${row.employee_id}::uuid
        and lower(p.permission_code) = any(${sql.array(MANAGER_PERMISSIONS)})
        and ur.valid_from <= (now() at time zone 'Asia/Ho_Chi_Minh')::date
        and (ur.valid_to is null or ur.valid_to >= (now() at time zone 'Asia/Ho_Chi_Minh')::date))`;

  if (!adminCheck && !managerCheck) return null;

  return {
    employee_id: row.employee_id,
    full_name: row.full_name,
    department_id: adminCheck ? null : (row.current_department_id ?? null),
  };
}

const DB_ERRORS: Record<string, string> = {
  "23505": "duplicate",
  "23503": "invalid_reference",
  "23502": "invalid_request",
  "23514": "rule_violation",
  "23P01": "rule_violation",
};

function dbError(err: unknown): Response {
  const code = (err as { code?: string })?.code ?? "";
  if (code === "forbidden") return json({ ok: false, error: "forbidden" }, 403);
  if (DB_ERRORS[code]) return json({ ok: false, error: DB_ERRORS[code] }, 400);
  console.error("hr-portal: unhandled database error", err);
  return json({ ok: false, error: "server_error" }, 500);
}

// Employees the actor may act on: the whole company for Admin role users,
// otherwise only the employee(s) of the actor's department.
//
// sql.raw fragments proved unreliable under npm:postgres in Deno (see
// staff-portal), so every statement inlines its SQL as literal template text.
async function scopedEmployeeIds(actor: Actor): Promise<string[]> {
  const rows = actor.department_id === null
    ? await sql!`select employee_id from public.employees`
    : await sql!`
        select employee_id from public.employees
        where current_department_id = ${actor.department_id}::uuid
           or employee_id = ${actor.employee_id}::uuid`;
  return rows.map((row) => String(row.employee_id));
}

// Guard: is employeeId one the actor may act on?
async function employeeInScope(actor: Actor, employeeId: string): Promise<boolean> {
  if (actor.department_id === null) return UUID_RE.test(employeeId);
  const rows = await sql!`
    select 1 from public.employees
    where employee_id = ${employeeId}::uuid
      and (current_department_id = ${actor.department_id}::uuid
           or employee_id = ${actor.employee_id}::uuid)`;
  return rows.length > 0;
}

// Roles currently assigned to employees the actor may act on (managers may
// only edit permissions/assignments of roles present in their scope).
async function scopedRoleIds(actor: Actor): Promise<string[]> {
  const rows = actor.department_id === null
    ? await sql!`select distinct role_id from public.user_roles`
    : await sql!`
        select distinct ur.role_id
        from public.user_roles ur
        where ur.employee_id = any(${sql.array(tagged(await scopedEmployeeIds(actor)))}::uuid[])`;
  return rows.map((row) => String(row.role_id));
}

// Managers must not hand out roles they cannot see in their own scope.
async function roleInScope(actor: Actor, roleId: string): Promise<boolean> {
  if (actor.department_id === null) return UUID_RE.test(roleId);
  return (await scopedRoleIds(actor)).includes(roleId);
}

function tagged(ids: string[]): string[] {
  return ids.length ? ids : ["00000000-0000-0000-0000-000000000000"];
}

async function bootAction(actor: Actor): Promise<Response> {
  const ids = tagged(await scopedEmployeeIds(actor));

  const [employees, contacts, positions, departments, roles, permissions, assignments, rolePerms, leaveRows, payrollRows, attendanceRows] = await Promise.all([
    sql!`
      select employee_id, employee_code, full_name, email, hire_date,
             employment_status, current_position_id as position_id
      from public.employees
      where employee_id = any(${sql.array(ids)}::uuid[])
      order by full_name`,
    sql!`
      select c.employee_id, c.phone_number, c.address
      from public.employee_contacts c
      where c.employee_id = any(${sql.array(ids)}::uuid[])`,
    sql!`
      select position_id, department_id, position_title, description
      from public.positions
      order by position_title`,
    sql!`select department_id, department_name, description from public.departments order by department_name`,
    sql!`select role_id, role_name, description from public.roles order by role_name`,
    sql!`select permission_id, permission_code, description from public.permissions order by permission_code`,
    sql!`
      select employee_id, role_id
      from public.user_roles
      where employee_id = any(${sql.array(ids)}::uuid[])`,
    sql!`select role_id, permission_id from public.role_permissions`,
    sql!`
      select lr.leave_request_id, lr.employee_id, lr.start_date, lr.end_date,
             lr.reason, lower(lr.status) as status,
             case lt.type_name
               when 'Nghỉ phép' then 'annual'
               when 'Nghỉ ốm đau' then 'sick'
               when 'Nghỉ thai sản' then 'maternity'
               when 'Xin nghỉ việc' then 'resignation'
               else lt.type_name
             end as leave_type
      from public.leave_requests lr
      left join public.leave_types lt on lt.leave_type_id = lr.leave_type_id
      where lr.employee_id = any(${sql.array(ids)}::uuid[])
      order by lr.start_date desc`,
    sql!`
      select payroll_id, employee_id, pay_month, pay_year, base_salary,
             total_allowance as allowance, total_deduction as total_deductions,
             bonus, overtime_pay, night_pay, gross_salary, net_salary,
             work_days, standard_days, insurance_amount, personal_income_tax,
             payment_date, payment_status, payment_method
      from public.payroll
      where employee_id = any(${sql.array(ids)}::uuid[])
      order by pay_year desc, pay_month desc`,
    sql!`
      select attendance_id, employee_id, work_date, status, overtime_hours, notes
      from public.attendance_records
      where employee_id = any(${sql.array(ids)}::uuid[])
      order by work_date desc`,
  ]);

  for (const row of attendanceRows) {
    (row as Record<string, unknown>).status = String((row as Record<string, unknown>).status ?? "").toLowerCase();
  }

  return json({
    ok: true,
    actor: { employee_id: actor.employee_id, department_id: actor.department_id },
    employees,
    contacts,
    positions,
    departments,
    roles,
    permissions,
    user_roles: assignments,
    role_permissions: rolePerms,
    leave_requests: leaveRows,
    payroll: payrollRows,
    attendance: attendanceRows,
  });
}

async function contactTx(tx: typeof sql, employeeId: string, phone: string, address: string | null): Promise<void> {
  const existing = await tx`
    select employee_id from public.employee_contacts
    where employee_id = ${employeeId}::uuid
    limit 1`;
  if (existing.length) {
    await tx`
      update public.employee_contacts
      set phone_number = ${phone}, address = ${address}
      where employee_id = ${employeeId}::uuid`;
  } else {
    await tx`
      insert into public.employee_contacts (employee_id, phone_number, address)
      values (${employeeId}::uuid, ${phone}, ${address})`;
  }
}

async function roleAssignTx(tx: typeof sql, actor: Actor, employeeId: string, roleId: string): Promise<void> {
  await tx`
    delete from public.user_roles
    where employee_id = ${employeeId}::uuid`;
  await tx`
    insert into public.user_roles (employee_id, role_id, valid_from, assigned_by)
    values (${employeeId}::uuid, ${roleId}::uuid,
            (now() at time zone 'Asia/Ho_Chi_Minh')::date, ${actor.employee_id}::uuid)`;
}

async function employeeSaveAction(actor: Actor, body: Record<string, unknown>): Promise<Response> {
  const id = str(body.id);
  const fullName = str(body.full_name);
  const email = str(body.email).toLowerCase();
  const positionId = str(body.position_id);
  const hireDate = str(body.hire_date);
  const statusInput = str(body.employment_status).toLowerCase();
  const roleId = str(body.role_id);
  const phone = str(body.phone_number);

  if (!fullName || !isRealDate(hireDate)) return json({ ok: false, error: "invalid_employee" }, 400);
  if (!(statusInput in EMPLOYMENT_STATUS)) return json({ ok: false, error: "invalid_status" }, 400);

  const employmentStatus = EMPLOYMENT_STATUS[statusInput];

  if (id) {
    if (!UUID_RE.test(id)) return json({ ok: false, error: "invalid_employee" }, 400);
    if (!await employeeInScope(actor, id)) return json({ ok: false, error: "forbidden" }, 403);
  }
  if (!isUUID(positionId)) return json({ ok: false, error: "invalid_employee" }, 400);
  if (roleId && !await roleInScope(actor, roleId)) return json({ ok: false, error: "forbidden" }, 403);
  // Managers may only create/update inside their own department.
  const [position] = await sql!`
    select department_id from public.positions
    where position_id = ${positionId}::uuid`;
  if (!position) return json({ ok: false, error: "invalid_employee" }, 400);
  if (actor.department_id !== null && String(position.department_id) !== actor.department_id) {
    return json({ ok: false, error: "forbidden" }, 403);
  }

  try {
    await sql!.begin(async (tx) => {
      let employeeId = id;
      // Department follows the chosen position (validated and fetched above).
      const departmentId = position.department_id === null ? null : String(position.department_id);

      if (!employeeId) {
        const code = `JW-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
        const [created] = await tx`
          insert into public.employees
            (employee_code, full_name, email, hire_date, current_position_id,
             current_department_id, employment_status)
          values
            (${code}, ${fullName}, ${email}, ${hireDate}::date, ${positionId}::uuid,
             ${departmentId}::uuid, ${employmentStatus})
          returning employee_id`;
        employeeId = String(created.employee_id);
      } else {
        await tx`
          update public.employees
          set full_name = ${fullName},
              email = ${email},
              hire_date = ${hireDate}::date,
              employment_status = ${employmentStatus},
              current_position_id = ${positionId}::uuid,
              current_department_id = ${departmentId}::uuid
          where employee_id = ${employeeId}::uuid`;
      }

      await contactTx(tx, employeeId, phone, null);
      if (roleId) await roleAssignTx(tx, actor, employeeId, roleId);
    });
  } catch (err) {
    return dbError(err);
  }

  return json({ ok: true });
}

async function employeeDeleteAction(actor: Actor, body: Record<string, unknown>): Promise<Response> {
  const id = str(body.id);
  if (!UUID_RE.test(id)) return json({ ok: false, error: "invalid_employee" }, 400);
  if (!await employeeInScope(actor, id)) return json({ ok: false, error: "forbidden" }, 403);

  try {
    await sql!.begin(async (tx) => {
      // No foreign keys cascade from employees; clear dependents first.
      await tx`delete from public.employee_accounts where employee_id = ${id}::uuid`;
      await tx`delete from public.user_roles where employee_id = ${id}::uuid or assigned_by = ${id}::uuid`;
      await tx`delete from public.employee_contacts where employee_id = ${id}::uuid`;
      await tx`delete from public.employee_personal_info where employee_id = ${id}::uuid`;
      await tx`delete from public.employee_payroll_info where employee_id = ${id}::uuid`;
      await tx`delete from public.employee_qualifications where employee_id = ${id}::uuid`;
      await tx`delete from public.employee_status_history where employee_id = ${id}::uuid or recorded_by = ${id}::uuid`;
      await tx`delete from public.career_history where employee_id = ${id}::uuid or approved_by = ${id}::uuid`;
      await tx`delete from public.leave_requests where employee_id = ${id}::uuid or approved_by = ${id}::uuid`;
      await tx`delete from public.attendance_records where employee_id = ${id}::uuid or ot_approved_by = ${id}::uuid`;
      await tx`delete from public.payroll where employee_id = ${id}::uuid`;
      await tx`delete from public.employees where employee_id = ${id}::uuid`;
    });
  } catch (err) {
    return dbError(err);
  }

  return json({ ok: true });
}

async function roleAssignAction(actor: Actor, body: Record<string, unknown>): Promise<Response> {
  const employeeId = str(body.employee_id);
  const roleId = str(body.role_id);
  if (!UUID_RE.test(employeeId) || !UUID_RE.test(roleId)) return json({ ok: false, error: "invalid_request" }, 400);
  if (!await employeeInScope(actor, employeeId)) return json({ ok: false, error: "forbidden" }, 403);
  if (!await roleInScope(actor, roleId)) return json({ ok: false, error: "forbidden" }, 403);

  try {
    await sql!.begin(async (tx) => {
      await roleAssignTx(tx, actor, employeeId, roleId);
    });
  } catch (err) {
    return dbError(err);
  }

  return json({ ok: true });
}

async function permissionsSaveAction(actor: Actor, body: Record<string, unknown>): Promise<Response> {
  const employeeId = str(body.employee_id);
  const roleId = str(body.role_id);
  const permissionIds = Array.isArray(body.permission_ids)
    ? body.permission_ids.filter((value): value is string => typeof value === "string" && UUID_RE.test(value))
    : [];
  if (!UUID_RE.test(employeeId) || !UUID_RE.test(roleId)) return json({ ok: false, error: "invalid_request" }, 400);
  if (!await employeeInScope(actor, employeeId)) return json({ ok: false, error: "forbidden" }, 403);

  const roleScope = actor.department_id === null ? [] : await scopedRoleIds(actor);
  if (actor.department_id !== null && !roleScope.includes(roleId)) {
    return json({ ok: false, error: "forbidden" }, 403);
  }

  await sql!.begin(async (tx) => {
    const [assigned] = await tx`
      select 1 from public.user_roles
      where employee_id = ${employeeId}::uuid and role_id = ${roleId}::uuid`;
    if (!assigned) await roleAssignTx(tx, actor, employeeId, roleId);

    await tx`
      delete from public.role_permissions
      where role_id = ${roleId}::uuid`;
    if (permissionIds.length) {
      await tx`
        insert into public.role_permissions (role_id, permission_id)
        select ${roleId}::uuid, perm
        from unnest(${sql.array(permissionIds)}::uuid[]) as perm`;
    }
  });

  return json({ ok: true });
}

async function leaveReviewAction(actor: Actor, body: Record<string, unknown>): Promise<Response> {
  const requestId = str(body.leave_request_id);
  const statusInput = str(body.status).toLowerCase();
  if (!UUID_RE.test(requestId)) return json({ ok: false, error: "invalid_request" }, 400);
  if (!["approved", "rejected"].includes(statusInput)) return json({ ok: false, error: "invalid_status" }, 400);

  try {
    const [leave] = await sql`
      select employee_id from public.leave_requests
      where leave_request_id = ${requestId}::uuid
      limit 1`;
    if (!leave) return json({ ok: false, error: "invalid_reference" }, 400);
    if (!await employeeInScope(actor, String(leave.employee_id))) {
      return json({ ok: false, error: "forbidden" }, 403);
    }

    // Single statement: no transaction needed (and the pool is max 1, so nested
    // pool queries inside sql.begin would deadlock).
    await sql`
      update public.leave_requests
      set status = ${statusInput === "approved" ? "Approved" : "Rejected"},
          approved_by = ${actor.employee_id}::uuid,
          decided_at = now()
      where leave_request_id = ${requestId}::uuid`;
  } catch (err) {
    return dbError(err);
  }

  return json({ ok: true });
}

async function attendanceSaveAction(actor: Actor, body: Record<string, unknown>): Promise<Response> {
  const employeeId = str(body.employee_id);
  const workDate = str(body.work_date);
  const statusInput = str(body.status).toLowerCase();
  const overtimeHours = Number(body.overtime_hours ?? 0);
  const notes = str(body.notes) || null;
  if (!UUID_RE.test(employeeId) || !isRealDate(workDate)) return json({ ok: false, error: "invalid_request" }, 400);
  if (!(statusInput in ATTENDANCE_STATUS)) return json({ ok: false, error: "invalid_status" }, 400);
  if (!Number.isFinite(overtimeHours) || overtimeHours < 0) return json({ ok: false, error: "invalid_request" }, 400);
  if (!await employeeInScope(actor, employeeId)) return json({ ok: false, error: "forbidden" }, 403);

  try {
    await sql!.begin(async (tx) => {
      const [existing] = await tx`
        select attendance_id from public.attendance_records
        where employee_id = ${employeeId}::uuid and work_date = ${workDate}::date
        limit 1`;
      if (existing) {
        await tx`
          update public.attendance_records
          set status = ${ATTENDANCE_STATUS[statusInput]},
              overtime_hours = ${overtimeHours},
              notes = ${notes}
          where attendance_id = ${existing.attendance_id}`;
      } else {
        await tx`
          insert into public.attendance_records
            (employee_id, work_date, status, overtime_hours, night_hours, notes)
          values (${employeeId}::uuid, ${workDate}::date,
                  ${ATTENDANCE_STATUS[statusInput]}, ${overtimeHours}, 0, ${notes})`;
      }
    });
  } catch (err) {
    return dbError(err);
  }

  return json({ ok: true });
}

async function payrollSaveAction(actor: Actor, body: Record<string, unknown>): Promise<Response> {
  const employeeId = str(body.employee_id);
  const year = Number(body.pay_year);
  const month = Number(body.pay_month);
  const baseSalary = Number(body.base_salary);
  const allowance = Number(body.allowance ?? 0);
  const overtimePay = Number(body.overtime_pay ?? 0);
  const workDays = Number(body.work_days ?? 0);
  const standardDays = Number(body.standard_days ?? 0);
  const insuranceAmount = Number(body.insurance_amount ?? 0);
  const tax = Number(body.personal_income_tax ?? 0);
  const totalDeductions = Number(body.total_deductions ?? insuranceAmount + tax);
  const grossSalary = Number(body.gross_salary ?? 0);
  const netSalary = Number(body.net_salary ?? 0);

  if (!UUID_RE.test(employeeId)) return json({ ok: false, error: "invalid_request" }, 400);
  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12 || year < 2000 || year > 2100) {
    return json({ ok: false, error: "invalid_period" }, 400);
  }
  const inputs = [baseSalary, allowance, overtimePay, workDays, standardDays, insuranceAmount, tax, totalDeductions, grossSalary, netSalary];
  if (inputs.some((value) => !Number.isFinite(value) || value < 0)) return json({ ok: false, error: "invalid_amounts" }, 400);
  if (netSalary > grossSalary) return json({ ok: false, error: "invalid_amounts" }, 400);
  if (!await employeeInScope(actor, employeeId)) return json({ ok: false, error: "forbidden" }, 403);

  try {
    await sql!.begin(async (tx) => {
      const [existing] = await tx`
        select payroll_id from public.payroll
        where employee_id = ${employeeId}::uuid and pay_year = ${year} and pay_month = ${month}
        limit 1`;
      if (existing) {
        await tx`
          update public.payroll
          set base_salary = ${baseSalary}, total_allowance = ${allowance},
              total_deduction = ${totalDeductions}, bonus = ${allowance},
              overtime_pay = ${overtimePay},
              work_days = ${workDays}, standard_days = ${standardDays},
              insurance_amount = ${insuranceAmount},
              personal_income_tax = ${tax},
              gross_salary = ${grossSalary}, net_salary = ${netSalary}
          where payroll_id = ${existing.payroll_id}`;
      } else {
        await tx`
          insert into public.payroll
            (employee_id, pay_year, pay_month, base_salary, total_allowance,
             total_deduction, bonus, overtime_pay, work_days, standard_days,
             insurance_amount, personal_income_tax, gross_salary, net_salary)
          values (${employeeId}::uuid, ${year}, ${month}, ${baseSalary}, ${allowance},
                  ${totalDeductions}, ${allowance}, ${overtimePay},
                  ${workDays}, ${standardDays},
                  ${insuranceAmount}, ${tax}, ${grossSalary}, ${netSalary})`;
      }
    });
  } catch (err) {
    return dbError(err);
  }

  return json({ ok: true });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);

  if (!sql || !JWT_KEY) {
    console.error("hr-portal: SUPABASE_DB_URL or ADMIN_JWT_SECRET is not set");
    return json({ ok: false, error: "server_not_configured" }, 500);
  }

  const token = req.headers.get("x-admin-token") ?? "";

  let actor: Actor | null;
  try {
    actor = token ? await getActor(token) : null;
  } catch (err) {
    return dbError(err); // database trouble is not a bad token
  }
  if (!actor) return json({ ok: false, error: "unauthorized" }, 401);

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: "bad_request" }, 400);
  }

  try {
    switch (body.action) {
      case "boot": return await bootAction(actor);
      case "employee_save": return await employeeSaveAction(actor, body);
      case "employee_delete": return await employeeDeleteAction(actor, body);
      case "role_assign": return await roleAssignAction(actor, body);
      case "permissions_save": return await permissionsSaveAction(actor, body);
      case "leave_review": return await leaveReviewAction(actor, body);
      case "attendance_save": return await attendanceSaveAction(actor, body);
      case "payroll_save": return await payrollSaveAction(actor, body);
      default: return json({ ok: false, error: "unknown_action" }, 400);
    }
  } catch (err) {
    return dbError(err);
  }
});
