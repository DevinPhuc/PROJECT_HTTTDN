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
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-admin-token",
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
  ? postgres(SUPABASE_DB_URL, {
      max: 3,
      idle_timeout: 20,
      connect_timeout: 10,
      prepare: false,
      ssl: "require",
    })
  : null;

const JWT_KEY = ADMIN_JWT_SECRET
  ? new TextEncoder().encode(ADMIN_JWT_SECRET)
  : null;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Same membership rule portal_login used for the manager portal.
const MANAGER_ROLES = ["manager", "hr_manager", "quản lý", "quản lý nhân sự"];
const MANAGER_PERMISSIONS = [
  "manager",
  "hr_manager",
  "manage_staff",
  "manage_employees",
];
const LEADER_ROLES = [
  "leader",
  "team_lead",
  "team lead",
  "team_leader",
  "team leader",
  "trưởng nhóm",
  "truong nhom",
];
const LEADER_PERMISSIONS = [
  "leader",
  "team_lead",
  "team_leader",
  "team_lead_access",
  "team_leader_access",
  "approve_team_leave",
];

// Live check constraints expect exactly these values.
const EMPLOYMENT_STATUS: Record<string, string> = {
  active: "Active",
  on_leave: "OnLeave",
  resigned: "Resigned",
};
const ATTENDANCE_STATUS: Record<string, string> = {
  present: "Present",
  absent: "Absent",
  late: "Late",
  on_leave: "OnLeave",
};

// Code sheet values mapped to attendance status; day_code remains the source of truth.
const DAY_CODE_STATUS: Record<string, { status: string }> = {
  X: { status: "present" },
  P: { status: "on_leave" },
  L: { status: "on_leave" },
  O: { status: "absent" },
  KP: { status: "absent" },
};

// "Worked all day" (X) means 07:00–17:00 so the Time-Clock list sums to 8h.
// Real clock timestamps win: coalesce only fills the gaps.
const FULL_DAY_IN = "07:00:00";
const FULL_DAY_OUT = "17:00:00";

type Actor = {
  employee_id: string;
  full_name: string;
  email: string;
  department_id: string | null;
  is_admin: boolean;
  is_hr: boolean;
  is_manager: boolean;
  is_leader: boolean;
  pending_notice?: unknown;
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

function abbreviatePosition(positionName: string): string {
  const normalized = positionName
    .trim()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\u0111/g, "d")
    .replace(/\u0110/g, "D");
  const words = normalized.split(/\s+/).filter(Boolean);
  return (
    words.length > 1
      ? words
          .slice(0, 2)
          .map((word) => word[0])
          .join("")
      : normalized.slice(0, 2)
  ).toUpperCase();
}

function generateAccountPassword(
  positionName: string,
  departmentDescription: string,
  dateOfBirth: string,
): string {
  const [year, month, day] = dateOfBirth.split("-");
  return `${abbreviatePosition(positionName)}${departmentDescription
    .trim()
    .slice(0, 3)
    .toLowerCase()}@${day}${month}${year}`;
}

async function updateEmployeeAccountPassword(
  tx: postgres.TransactionSql,
  employeeId: string,
  roleId: string,
): Promise<void> {
  const [details] = await tx`
    select r.role_name,
           coalesce(d.description, '') as department_description,
           to_char(e.date_of_birth, 'YYYY-MM-DD') as date_of_birth
    from public.employees e
    left join public.departments d on d.department_id = e.current_department_id
    join public.roles r on r.role_id = ${roleId}::uuid
    where e.employee_id = ${employeeId}::uuid
      and exists (
        select 1 from public.user_roles ur
        where ur.employee_id = e.employee_id
          and ur.role_id = ${roleId}::uuid
      )
    limit 1`;
  if (!details || !details.date_of_birth) return;

  const password = generateAccountPassword(
    String(details.role_name || ""),
    String(details.department_description || ""),
    String(details.date_of_birth),
  );
  await tx`
    update public.employee_accounts
    set password_hash = extensions.crypt(${password}, extensions.gen_salt('bf', 10))
    where employee_id = ${employeeId}::uuid`;
}

function isRealDate(value: string): boolean {
  if (!DATE_RE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return (
    !Number.isNaN(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value
  );
}

function parseNotice(notice: unknown): Record<string, unknown> | null {
  if (!notice) return null;
  let current: unknown = notice;
  while (typeof current === "string") {
    try {
      current = JSON.parse(current);
    } catch {
      break;
    }
  }
  return current && typeof current === "object"
    ? (current as Record<string, unknown>)
    : null;
}

let noticeColumnChecked = false;
async function ensureNoticeColumn() {
  if (noticeColumnChecked) return;
  try {
    await sql!`alter table public.employee_accounts add column if not exists pending_notice jsonb`;
  } catch (err) {
    console.error("hr-portal: ensureNoticeColumn pending_notice failed", err);
  }
  try {
    await sql!`
      alter table public.leave_requests
        add column if not exists leader_status text,
        add column if not exists leader_reviewed_by uuid references public.employees(employee_id) on delete set null,
        add column if not exists leader_reviewed_at timestamptz`;
  } catch (err) {
    console.warn(
      "hr-portal: ensure leader columns on leave_requests failed",
      err,
    );
  }
  noticeColumnChecked = true;
}

async function getActor(token: string): Promise<Actor | null> {
  let employeeId = "";
  let iat = 0;
  try {
    const { payload } = await jwtVerify(token, JWT_KEY!, {
      algorithms: ["HS256"],
    });
    employeeId =
      typeof payload.employee_id === "string" ? payload.employee_id : "";
    iat = typeof payload.iat === "number" ? payload.iat : 0;
  } catch {
    return null;
  }
  if (!UUID_RE.test(employeeId)) return null;

  let rows;
  try {
    rows = await sql!`
      select e.employee_id, e.full_name, e.email,
             coalesce(e.current_department_id, position_department.department_id) as current_department_id,
             e.updated_at,
             lower(coalesce(d.department_name, '')) = 'nhân sự' as is_hr,
             a.pending_notice
      from public.employees e
      join public.employee_accounts a on a.employee_id = e.employee_id
      left join lateral (
        select (array_agg(distinct dp.department_id))[1] as department_id
        from public.department_positions dp
        where dp.position_id = e.current_position_id
        having count(distinct dp.department_id) = 1
      ) position_department on true
      left join public.departments d on d.department_id = coalesce(e.current_department_id, position_department.department_id)
      where e.employee_id = ${employeeId}::uuid
        and a.is_active is true
        and a.deleted_at is null
        and e.employment_status = 'Active'
      limit 1`;
  } catch (err) {
    const code = (err as { code?: string })?.code ?? "";
    if (code === "42703") {
      rows = await sql!`
        select e.employee_id, e.full_name, e.email,
               coalesce(e.current_department_id, position_department.department_id) as current_department_id,
               e.updated_at,
               lower(coalesce(d.department_name, '')) = 'nhân sự' as is_hr,
               null as pending_notice
        from public.employees e
        join public.employee_accounts a on a.employee_id = e.employee_id
        left join lateral (
          select (array_agg(distinct dp.department_id))[1] as department_id
          from public.department_positions dp
          where dp.position_id = e.current_position_id
          having count(distinct dp.department_id) = 1
        ) position_department on true
        left join public.departments d on d.department_id = coalesce(e.current_department_id, position_department.department_id)
        where e.employee_id = ${employeeId}::uuid
          and a.is_active is true
          and a.deleted_at is null
          and e.employment_status = 'Active'
        limit 1`;
    } else {
      throw err;
    }
  }

  const row = rows[0] as
    | undefined
    | {
        employee_id: string;
        full_name: string;
        email: string;
        current_department_id: string | null;
        is_hr: boolean;
        updated_at: string | Date | null;
        pending_notice?: unknown;
      };
  if (!row) return null;

  // Ngày hiệu lực được đối chiếu theo múi giờ Asia/Ho_Chi_Minh.
  const [adminCheck] = await sql!`
    select true as is_admin
    where exists (
      select 1 from public.user_roles ur
      join public.roles r on r.role_id = ur.role_id
      where ur.employee_id = ${row.employee_id}::uuid and r.role_name = 'Admin'
        and (ur.valid_from is null or ur.valid_from <= (now() at time zone 'Asia/Ho_Chi_Minh')::date)
        and (ur.valid_to is null or ur.valid_to >= (now() at time zone 'Asia/Ho_Chi_Minh')::date))`;

  const [managerCheck] = await sql!`
    select true as is_manager
    where exists (
      select 1 from public.user_roles ur
      join public.roles r on r.role_id = ur.role_id
      where ur.employee_id = ${row.employee_id}::uuid
        and lower(r.role_name) = any(${sql.array(MANAGER_ROLES)})
        and (ur.valid_from is null or ur.valid_from <= (now() at time zone 'Asia/Ho_Chi_Minh')::date)
        and (ur.valid_to is null or ur.valid_to >= (now() at time zone 'Asia/Ho_Chi_Minh')::date))
       or exists (
      select 1 from public.user_roles ur
      join public.role_permissions rp on rp.role_id = ur.role_id
      join public.permissions p on p.permission_id = rp.permission_id
      where ur.employee_id = ${row.employee_id}::uuid
        and lower(p.permission_code) = any(${sql.array(MANAGER_PERMISSIONS)})
        and (ur.valid_from is null or ur.valid_from <= (now() at time zone 'Asia/Ho_Chi_Minh')::date)
        and (ur.valid_to is null or ur.valid_to >= (now() at time zone 'Asia/Ho_Chi_Minh')::date))`;

  const [leaderCheck] = await sql!`
    select true as is_leader
    where exists (
      select 1 from public.user_roles ur
      join public.roles r on r.role_id = ur.role_id
      where ur.employee_id = ${row.employee_id}::uuid
        and lower(r.role_name) = any(${sql.array(LEADER_ROLES)})
        and (ur.valid_from is null or ur.valid_from <= (now() at time zone 'Asia/Ho_Chi_Minh')::date)
        and (ur.valid_to is null or ur.valid_to >= (now() at time zone 'Asia/Ho_Chi_Minh')::date))
       or exists (
      select 1 from public.user_roles ur
      join public.role_permissions rp on rp.role_id = ur.role_id
      join public.permissions p on p.permission_id = rp.permission_id
      where ur.employee_id = ${row.employee_id}::uuid
        and lower(p.permission_code) = any(${sql.array(LEADER_PERMISSIONS)})
        and (ur.valid_from is null or ur.valid_from <= (now() at time zone 'Asia/Ho_Chi_Minh')::date)
        and (ur.valid_to is null or ur.valid_to >= (now() at time zone 'Asia/Ho_Chi_Minh')::date))`;

  if (!adminCheck && !managerCheck && !leaderCheck) {
    if (row.pending_notice) {
      return {
        employee_id: row.employee_id,
        full_name: row.full_name,
        email: row.email,
        department_id: row.current_department_id ?? null,
        is_admin: false,
        is_hr: false,
        is_manager: false,
        is_leader: false,
        pending_notice: parseNotice(row.pending_notice),
      };
    }
    return null;
  }

  return {
    employee_id: row.employee_id,
    full_name: row.full_name,
    email: row.email,
    department_id: row.current_department_id ?? null,
    is_admin: Boolean(adminCheck),
    is_hr: Boolean(row.is_hr),
    is_manager: Boolean(managerCheck),
    is_leader: Boolean(leaderCheck && !managerCheck && !adminCheck),
    pending_notice: parseNotice(row.pending_notice),
  };
}

const DB_ERRORS: Record<string, string> = {
  "23505": "duplicate",
  "23503": "invalid_reference",
  "23502": "invalid_request",
  "23514": "rule_violation",
  "23P01": "rule_violation",
  "42P01": "migration_required",
};

function dbError(err: unknown): Response {
  const code = (err as { code?: string })?.code ?? "";
  if (code === "forbidden") return json({ ok: false, error: "forbidden" }, 403);
  if (DB_ERRORS[code]) return json({ ok: false, error: DB_ERRORS[code] }, 400);
  console.error("hr-portal: unhandled database error", err);
  return json(
    {
      ok: false,
      error: "server_error",
      message: (err as Error)?.message || String(err),
    },
    500,
  );
}

async function optionalBootQuery<T>(
  label: string,
  query: Promise<T>,
  fallback: T,
): Promise<T> {
  try {
    return await query;
  } catch (error) {
    const code = (error as { code?: string })?.code ?? "";
    if (code === "42P01") {
      console.error(`hr-portal boot skipped missing table: ${label}`, error);
      return fallback;
    }
    throw error;
  }
}

// Employees the actor may act on: the whole company for Admin role users,
// otherwise only the employee(s) of the actor's department.
//
// sql.raw fragments proved unreliable under npm:postgres in Deno (see
// staff-portal), so every statement inlines its SQL as literal template text.
async function scopedEmployeeIds(actor: Actor): Promise<string[]> {
  const rows = actor.is_leader
    ? !actor.department_id || !UUID_RE.test(actor.department_id)
      ? []
      : await sql!`
            select e.employee_id
            from public.employees e
            left join lateral (
              select (array_agg(distinct dp.department_id))[1] as department_id
              from public.department_positions dp
              where dp.position_id = e.current_position_id
              having count(distinct dp.department_id) = 1
            ) position_department on true
            where e.employee_id <> ${actor.employee_id}::uuid
              and e.employment_status = 'Active'
              and exists (
                select 1 from public.employee_accounts a
                where a.employee_id = e.employee_id
                  and a.is_active is true
                  and a.deleted_at is null
              )
              and (
                e.current_department_id = ${actor.department_id}::uuid
                or (
                  e.current_department_id is null
                  and position_department.department_id = ${actor.department_id}::uuid
                )
              )`
    : actor.is_admin || actor.is_hr
      ? await sql!`select employee_id from public.employees`
      : !actor.department_id || !UUID_RE.test(actor.department_id)
        ? await sql!`select employee_id from public.employees where employee_id = ${actor.employee_id}::uuid`
        : await sql!`
        select employee_id from public.employees
        where current_department_id = ${actor.department_id}::uuid
           or employee_id = ${actor.employee_id}::uuid`;
  return rows.map((row) => String(row.employee_id));
}

// Guard: is employeeId one the actor may act on?
async function employeeInScope(
  actor: Actor,
  employeeId: string,
): Promise<boolean> {
  if (actor.is_leader) {
    if (actor.department_id === null || employeeId === actor.employee_id)
      return false;
    const rows = await sql!`
      select 1 from public.employees e
      left join lateral (
        select (array_agg(distinct dp.department_id))[1] as department_id
        from public.department_positions dp
        where dp.position_id = e.current_position_id
        having count(distinct dp.department_id) = 1
      ) position_department on true
      where e.employee_id = ${employeeId}::uuid
        and e.employment_status = 'Active'
        and exists (
          select 1 from public.employee_accounts a
          where a.employee_id = e.employee_id
            and a.is_active is true
            and a.deleted_at is null
        )
        and (
          e.current_department_id = ${actor.department_id}::uuid
          or (
            e.current_department_id is null
            and position_department.department_id = ${actor.department_id}::uuid
          )
        )
      limit 1`;
    return rows.length > 0;
  }
  if (actor.is_admin || actor.is_hr) return UUID_RE.test(employeeId);
  if (actor.department_id === null) return employeeId === actor.employee_id;
  const rows = await sql!`
    select 1 from public.employees e
    left join public.department_positions dp on dp.position_id = e.current_position_id
    where e.employee_id = ${employeeId}::uuid
      and (e.current_department_id = ${actor.department_id}::uuid
           or dp.department_id = ${actor.department_id}::uuid
           or e.employee_id = ${actor.employee_id}::uuid)
    limit 1`;
  return rows.length > 0;
}

// Role changes are employee-specific; only Admin may grant roles that
// provide HR-manager access or change the shared permission catalog.
async function canAssignRole(actor: Actor, roleId: string): Promise<boolean> {
  if (!UUID_RE.test(roleId)) return false;
  if (actor.is_admin) return true;
  const rows = await sql!`
    select 1
    from public.roles r
    where r.role_id = ${roleId}::uuid
      and lower(r.role_name) <> 'admin'
      and not (lower(r.role_name) = any(${sql.array(MANAGER_ROLES)}))
      and not exists (
        select 1
        from public.role_permissions rp
        join public.permissions p on p.permission_id = rp.permission_id
        where rp.role_id = r.role_id
          and lower(p.permission_code) = any(${sql.array(MANAGER_PERMISSIONS)})
      )
    limit 1`;
  return rows.length > 0;
}

async function employeeHasActiveRole(
  employeeId: string,
  roleId: string,
): Promise<boolean> {
  const rows = await sql!`
    select 1
    from public.user_roles
    where employee_id = ${employeeId}::uuid
      and role_id = ${roleId}::uuid
      and valid_from <= (now() at time zone 'Asia/Ho_Chi_Minh')::date
      and (valid_to is null or valid_to >= (now() at time zone 'Asia/Ho_Chi_Minh')::date)
    limit 1`;
  return rows.length > 0;
}

async function employeeHoldsAdminRole(employeeId: string): Promise<boolean> {
  const rows = await sql!`
    select 1 from public.user_roles ur
    join public.roles r on r.role_id = ur.role_id
    where ur.employee_id = ${employeeId}::uuid and r.role_name = 'Admin'
      and ur.valid_to is null
    limit 1`;
  return rows.length > 0;
}

function tagged(ids: string[]): string[] {
  return ids.length ? ids : ["00000000-0000-0000-0000-000000000000"];
}

async function fetchBootLeaveRows(ids: string[]): Promise<unknown[]> {
  try {
    return await sql!`
      select lr.leave_request_id, lr.employee_id, lr.start_date, lr.end_date,
             lr.reason, lower(lr.status::text) as status,
             lr.leader_status, lr.leader_reviewed_at,
             to_char(lr.requested_at, 'YYYY-MM-DD"T"HH24:MI:SS') as requested_at,
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
      order by lr.start_date desc`;
  } catch (err) {
    const code = (err as { code?: string })?.code ?? "";
    if (code === "42703" || code === "42P01") {
      try {
        return await sql!`
          select lr.leave_request_id, lr.employee_id, lr.start_date, lr.end_date,
                 lr.reason, lower(lr.status::text) as status,
                 null as leader_status, null as leader_reviewed_at,
                 null as requested_at,
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
          order by lr.start_date desc`;
      } catch (_) {
        return [];
      }
    }
    throw err;
  }
}

async function fetchBootAttendanceRows(
  ids: string[],
): Promise<Record<string, unknown>[]> {
  try {
    return (await sql!`
      select attendance_id, employee_id, work_date, status, day_code, 0 as overtime_hours, null as notes
      from public.attendance_records
      where employee_id = any(${sql.array(ids)}::uuid[])
      order by work_date desc`) as Record<string, unknown>[];
  } catch (err) {
    const code = (err as { code?: string })?.code ?? "";
    if (code === "42703" || code === "42P01") {
      try {
        return (await sql!`
          select attendance_id, employee_id, work_date, status, null as day_code, 0 as overtime_hours, null as notes
          from public.attendance_records
          where employee_id = any(${sql.array(ids)}::uuid[])
          order by work_date desc`) as Record<string, unknown>[];
      } catch (_) {
        return [];
      }
    }
    throw err;
  }
}

async function bootAction(actor: Actor): Promise<Response> {
  const ids = tagged(await scopedEmployeeIds(actor));

  const [
    employees,
    contacts,
    positions,
    departments,
    roles,
    permissions,
    assignments,
    rolePerms,
    roleHistory,
    leaveRows,
    payrollRows,
    attendanceRows,
    statusHistory,
    allCodeRows,
  ] = await Promise.all([
    sql!`
      select e.employee_id, e.employee_code, e.full_name, e.email,
             to_char(e.hire_date, 'YYYY-MM-DD') as hire_date,
             to_char(e.date_of_birth, 'YYYY-MM-DD') as date_of_birth,
             e.gender,
             e.employment_status, e.current_position_id as position_id,
             e.current_department_id as department_id, e.education,
             a.deleted_at, a.is_active
      from public.employees e
      left join public.employee_accounts a on a.employee_id = e.employee_id
      where e.employee_id = any(${sql.array(ids)}::uuid[])
        and a.deleted_at is null
        and a.is_active = true
        and e.employment_status = 'Active'
      order by e.full_name`,
    sql!`
      select c.employee_id, c.phone_number, c.address
      from public.employee_contacts c
      where c.employee_id = any(${sql.array(ids)}::uuid[])`,
    sql!`
      select p.position_id, p.position_title, p.description,
             coalesce((select json_agg(dp.department_id) from public.department_positions dp
                       where dp.position_id = p.position_id), '[]'::json) as department_ids
      from public.positions p
      order by p.position_title`,
    sql!`select department_id, department_name, description from public.departments order by department_name`,
    actor.is_admin
      ? sql!`select role_id, role_name, description, true as assignable from public.roles order by role_name`
      : sql!`
          select r.role_id, r.role_name, r.description,
                 lower(r.role_name) <> 'admin'
                 and not (lower(r.role_name) = any(${sql.array(MANAGER_ROLES)}))
                 and not exists (
                   select 1
                   from public.role_permissions rp
                   join public.permissions p on p.permission_id = rp.permission_id
                   where rp.role_id = r.role_id
                     and lower(p.permission_code) = any(${sql.array(MANAGER_PERMISSIONS)})
                 ) as assignable
          from public.roles r
          order by r.role_name`,
    sql!`select permission_id, permission_code, description from public.permissions order by permission_code`,
    sql!`
      select employee_id, role_id
      from public.user_roles
      where employee_id = any(${sql.array(ids)}::uuid[])
        and valid_from <= (now() at time zone 'Asia/Ho_Chi_Minh')::date
        and (valid_to is null or valid_to >= (now() at time zone 'Asia/Ho_Chi_Minh')::date)
      order by valid_from desc, user_role_id desc`,
    sql!`select role_id, permission_id from public.role_permissions`,
    sql!`
      select ur.user_role_id, ur.employee_id, ur.role_id, r.role_name,
             ur.valid_from, ur.valid_to, assigned.full_name as assigned_by_name
      from public.user_roles ur
      join public.roles r on r.role_id = ur.role_id
      left join public.employees assigned on assigned.employee_id = ur.assigned_by
      where ur.employee_id = any(${sql.array(ids)}::uuid[])
      order by ur.employee_id, ur.valid_from desc, ur.user_role_id desc`,
    fetchBootLeaveRows(ids),
    sql!`
      select payroll_id, employee_id, pay_month, pay_year, base_salary,
             total_allowance as allowance, total_deduction as total_deductions,
             bonus, overtime_pay, night_pay, gross_salary, net_salary,
             work_days, standard_days, insurance_amount, personal_income_tax,
             payment_date, payment_status, payment_method
      from public.payroll
      where employee_id = any(${sql.array(ids)}::uuid[])
      order by pay_year desc nulls last, pay_month desc nulls last`,
    sql!`
      select attendance_id, employee_id, work_date, status, day_code
      from public.attendance_records
      where employee_id = any(${sql.array(ids)}::uuid[])
      order by work_date desc`,
    optionalBootQuery(
      "hr_employment_status_history",
      sql!`
      select employee_id, employment_status, is_baseline, effective_from, effective_to
      from public.hr_employment_status_history
      where employee_id = any(${sql.array(ids)}::uuid[])
      order by employee_id, effective_from`,
      [],
    ),
    optionalBootQuery(
      "all_employee_codes",
      sql!`select employee_code from public.employees where employee_code is not null`,
      [],
    ),
  ]);

  for (const row of attendanceRows) {
    (row as Record<string, unknown>).status = String(
      (row as Record<string, unknown>).status ?? "",
    ).toLowerCase();
  }

  return json({
    ok: true,
    actor: {
      employee_id: actor.employee_id,
      full_name: actor.full_name,
      email: actor.email,
      department_id: actor.department_id,
      is_admin: actor.is_admin,
      is_hr: actor.is_hr,
      is_manager: actor.is_manager,
      is_leader: actor.is_leader,
    },
    employees,
    contacts,
    positions,
    departments,
    roles,
    permissions,
    all_employee_codes: (allCodeRows as Array<{ employee_code: string }>)
      .map((r) => String(r.employee_code))
      .filter(Boolean),
    user_roles: assignments,
    role_permissions: rolePerms,
    role_history: roleHistory,
    leave_requests: leaveRows,
    payroll: payrollRows,
    attendance: attendanceRows,
    employment_status_history: statusHistory,
    pending_notice: actor.pending_notice || null,
  });
}

async function leaderBootAction(
  actor: Actor,
  body: Record<string, unknown>,
): Promise<Response> {
  const requestedMonth = str(body.month);
  const currentMonth = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Ho_Chi_Minh",
    year: "numeric",
    month: "2-digit",
  }).format(new Date());
  const month = requestedMonth || currentMonth;
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
    return json({ ok: false, error: "invalid_period" }, 400);
  }

  const rawIds = await scopedEmployeeIds(actor);
  if (!rawIds.length) {
    return json({
      ok: true,
      actor: {
        employee_id: actor.employee_id,
        full_name: actor.full_name,
        email: actor.email,
        department_id: actor.department_id,
      },
      month,
      employees: [],
      attendance: [],
      leave_requests: [],
      pending_notice: actor.pending_notice || null,
    });
  }
  const ids = rawIds;
  const [teamEmployees, attendanceRows, leaveRows] = await Promise.all([
    sql!`
      select e.employee_id, e.employee_code, e.full_name, e.email,
             e.employment_status, e.current_position_id as position_id,
             coalesce(e.current_department_id, position_department.department_id) as department_id,
             p.position_title
      from public.employees e
      left join lateral (
        select (array_agg(distinct dp.department_id))[1] as department_id
        from public.department_positions dp
        where dp.position_id = e.current_position_id
        having count(distinct dp.department_id) = 1
      ) position_department on true
      left join public.positions p on p.position_id = e.current_position_id
      left join public.employee_accounts a on a.employee_id = e.employee_id
      where e.employee_id = any(${sql.array(ids)}::uuid[])
        and a.deleted_at is null
        and a.is_active is true
        and e.employment_status = 'Active'
      order by e.full_name`,
    sql!`
      select ar.attendance_id, ar.employee_id,
             lower(ar.status::text) as status, ar.day_code,
             to_char(ar.work_date, 'YYYY-MM-DD') as work_date,
             to_char(ar.check_in_time, 'HH24:MI:SS') as check_in_time,
             to_char(ar.check_out_time, 'HH24:MI:SS') as check_out_time
      from public.attendance_records ar
      where ar.employee_id = any(${sql.array(ids)}::uuid[])
        and ar.work_date >= ${`${month}-01`}::date
        and ar.work_date < (${`${month}-01`}::date + interval '1 month')
      order by ar.work_date desc, ar.employee_id`,
    sql!`
      select lr.leave_request_id, lr.employee_id, e.full_name, e.employee_code,
             to_char(lr.start_date, 'YYYY-MM-DD') as start_date,
             to_char(lr.end_date, 'YYYY-MM-DD') as end_date,
             lr.reason,
             lower(lr.status::text) as status, lr.leader_status,
             lr.leader_reviewed_at,
             to_char(lr.requested_at, 'YYYY-MM-DD"T"HH24:MI:SS') as requested_at,
             case lt.type_name
               when 'Nghỉ phép' then 'annual'
               when 'Nghỉ ốm đau' then 'sick'
               when 'Nghỉ thai sản' then 'maternity'
               when 'Xin nghỉ việc' then 'resignation'
               else lt.type_name
             end as leave_type
      from public.leave_requests lr
      join public.employees e on e.employee_id = lr.employee_id
      left join public.leave_types lt on lt.leave_type_id = lr.leave_type_id
      where lr.employee_id = any(${sql.array(ids)}::uuid[])
      order by lr.requested_at desc nulls last, lr.start_date desc`,
  ]);
  for (const row of attendanceRows) {
    (row as Record<string, unknown>).work_date = String(
      (row as Record<string, unknown>).work_date,
    ).slice(0, 10);
  }

  return json({
    ok: true,
    actor: {
      employee_id: actor.employee_id,
      full_name: actor.full_name,
      email: actor.email,
      department_id: actor.department_id,
    },
    month,
    employees: teamEmployees,
    attendance: attendanceRows,
    leave_requests: leaveRows,
    pending_notice: actor.pending_notice || null,
  });
}

async function leaderAttendanceListAction(actor: Actor): Promise<Response> {
  const [todayRow] = await sql!`
    select (now() at time zone 'Asia/Ho_Chi_Minh')::date::text as today`;
  const records = await sql!`
    select attendance_id,
           to_char(work_date, 'YYYY-MM-DD') as work_date,
           to_char(check_in_time, 'HH24:MI:SS') as check_in,
           to_char(check_out_time, 'HH24:MI:SS') as check_out,
           status
    from public.attendance_records
    where employee_id = ${actor.employee_id}::uuid
    order by work_date desc
    limit 400`;
  return json({ ok: true, today: todayRow.today, records });
}

async function leaderAttendanceClockAction(
  actor: Actor,
  body: Record<string, unknown>,
): Promise<Response> {
  const phase = str(body.phase).toLowerCase();
  if (phase !== "in" && phase !== "out")
    return json({ ok: false, error: "invalid_phase" }, 400);

  let clockError = "";
  try {
    await sql!.begin(async (tx) => {
      await tx`
        select pg_advisory_xact_lock(
          hashtextextended(
            ${actor.employee_id} || ':' ||
              (now() at time zone 'Asia/Ho_Chi_Minh')::date::text,
            0
          )
        )`;
      const [existing] = await tx`
        select attendance_id, check_in_time, check_out_time
        from public.attendance_records
        where employee_id = ${actor.employee_id}::uuid
          and work_date = (now() at time zone 'Asia/Ho_Chi_Minh')::date
        limit 1
        for update`;

      if (!existing) {
        if (phase === "out") {
          clockError = "not_clocked_in";
          return;
        }
        await tx`
          insert into public.attendance_records
            (employee_id, work_date, status, check_in_time)
          values (
            ${actor.employee_id}::uuid,
            (now() at time zone 'Asia/Ho_Chi_Minh')::date,
            'Present',
            (now() at time zone 'Asia/Ho_Chi_Minh')::time
          )`;
        return;
      }

      if (phase === "in") {
        if (existing.check_in_time != null) {
          clockError = "already_in";
          return;
        }
        await tx`
          update public.attendance_records
          set check_in_time = (now() at time zone 'Asia/Ho_Chi_Minh')::time
          where attendance_id = ${existing.attendance_id}`;
        return;
      }
      if (existing.check_in_time == null) {
        clockError = "not_clocked_in";
        return;
      }
      if (existing.check_out_time != null) {
        clockError = "already_clocked_out";
        return;
      }
      await tx`
        update public.attendance_records
        set check_out_time = (now() at time zone 'Asia/Ho_Chi_Minh')::time
        where attendance_id = ${existing.attendance_id}`;
    });
  } catch (err) {
    return dbError(err);
  }

  if (clockError) return json({ ok: false, error: clockError }, 400);
  return leaderAttendanceListAction(actor);
}

async function contactTx(
  tx: typeof sql,
  employeeId: string,
  phone: string,
  address: string | null,
): Promise<void> {
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

async function roleAssignTx(
  tx: typeof sql,
  actor: Actor,
  employeeId: string,
  roleId: string,
): Promise<void> {
  const today = sql!`(now() at time zone 'Asia/Ho_Chi_Minh')::date`;
  const currentRoles = await tx`
    select user_role_id, role_id, valid_from,
           valid_from = (now() at time zone 'Asia/Ho_Chi_Minh')::date as starts_today
    from public.user_roles
    where employee_id = ${employeeId}::uuid
      and valid_from <= ${today}
      and (valid_to is null or valid_to >= ${today})
    order by valid_from desc, user_role_id desc
    for update`;
  const matchingRole = currentRoles.find(
    (row) => String(row.role_id) === roleId,
  );

  const sameDayRole = currentRoles.find(
    (assignment) => assignment.starts_today,
  );
  if (!matchingRole && sameDayRole) {
    await tx`
      update public.user_roles
      set role_id = ${roleId}::uuid
      where user_role_id = ${sameDayRole.user_role_id}`;
  }

  const retainedRoleId = matchingRole
    ? String(matchingRole.user_role_id)
    : sameDayRole
      ? String(sameDayRole.user_role_id)
      : "";
  for (const assignment of currentRoles) {
    if (String(assignment.user_role_id) === retainedRoleId) continue;
    if (assignment.starts_today) {
      await tx`delete from public.user_roles where user_role_id = ${assignment.user_role_id}`;
    } else {
      await tx`
        update public.user_roles
        set valid_to = ${today} - 1
        where user_role_id = ${assignment.user_role_id}`;
    }
  }

  if (!matchingRole && !sameDayRole) {
    await tx`
      insert into public.user_roles (employee_id, role_id, valid_from, assigned_by)
      values (${employeeId}::uuid, ${roleId}::uuid,
              ${today}, ${actor.employee_id}::uuid)`;
  }
}

async function recordEmploymentStatusTx(
  tx: typeof sql,
  employeeId: string,
  status: string,
  effectiveDate: string,
  actorId: string,
): Promise<void> {
  const [current] = await tx`
    select status_history_id, employment_status, effective_from,
           effective_from >= (now() at time zone 'Asia/Ho_Chi_Minh')::date as starts_today_or_later
    from public.hr_employment_status_history
    where employee_id = ${employeeId}::uuid and effective_to is null
    order by effective_from desc, status_history_id desc
    limit 1
    for update`;
  if (current && String(current.employment_status) === status) return;

  if (current && current.starts_today_or_later) {
    await tx`
      update public.hr_employment_status_history
      set employment_status = ${status}, changed_by = ${actorId}::uuid,
          reason = 'Cập nhật trạng thái nhân sự', is_baseline = false
      where status_history_id = ${current.status_history_id}`;
    return;
  }

  const today = sql!`(now() at time zone 'Asia/Ho_Chi_Minh')::date`;
  if (current) {
    await tx`
      update public.hr_employment_status_history
      set effective_to = ${today} - 1
      where status_history_id = ${current.status_history_id}`;
  }
  await tx`
    insert into public.hr_employment_status_history
      (employee_id, employment_status, effective_from, changed_by, reason)
    values (${employeeId}::uuid, ${status},
            greatest(${effectiveDate}::date, ${today}),
            ${actorId}::uuid, 'Cập nhật trạng thái nhân sự')`;
}

async function employeeSaveAction(
  actor: Actor,
  body: Record<string, unknown>,
): Promise<Response> {
  const id = str(body.id);
  const fullName = str(body.full_name);
  const email = str(body.email).toLowerCase();
  const positionId = str(body.position_id);
  const dateOfBirth = str(body.date_of_birth);
  const hireDate = str(body.hire_date);
  const statusInput = str(body.employment_status).toLowerCase();
  const roleId = str(body.role_id);
  const requestedDepartmentId = str(body.department_id);
  const requestedEmployeeCode = str(body.employee_code).trim();
  const gender = str(body.gender).trim() || "Male";
  const phone = str(body.phone_number).trim();
  const education = str(body.education);
  let preserveExistingRole = false;

  if (phone && !/^\d{10}$/.test(phone)) {
    return json({ ok: false, error: "invalid_phone" }, 400);
  }

  if (
    !fullName ||
    !isRealDate(hireDate) ||
    (dateOfBirth && !isRealDate(dateOfBirth)) ||
    education.length > 120
  ) {
    return json({ ok: false, error: "invalid_employee" }, 400);
  }
  if (!(statusInput in EMPLOYMENT_STATUS))
    return json({ ok: false, error: "invalid_status" }, 400);

  const employmentStatus = EMPLOYMENT_STATUS[statusInput];

  if (id) {
    if (!UUID_RE.test(id))
      return json({ ok: false, error: "invalid_employee" }, 400);
    if (!(await employeeInScope(actor, id)))
      return json({ ok: false, error: "forbidden" }, 403);
  }
  if (!isUUID(positionId))
    return json({ ok: false, error: "invalid_employee" }, 400);
  if (requestedDepartmentId && !UUID_RE.test(requestedDepartmentId))
    return json({ ok: false, error: "invalid_employee" }, 400);
  if (roleId && !UUID_RE.test(roleId))
    return json({ ok: false, error: "invalid_employee" }, 400);
  if (roleId && !(await canAssignRole(actor, roleId))) {
    preserveExistingRole = Boolean(
      id && (await employeeHasActiveRole(id, roleId)),
    );
    if (!preserveExistingRole)
      return json({ ok: false, error: "forbidden" }, 403);
  }
  if (id && id === actor.employee_id && !actor.is_admin && roleId) {
    if (!(await employeeHasActiveRole(id, roleId)))
      return json({ ok: false, error: "forbidden" }, 403);
    preserveExistingRole = true;
  }
  if (id && !actor.is_admin && (await employeeHoldsAdminRole(id))) {
    return json({ ok: false, error: "forbidden" }, 403); // managers never edit Admin holders
  }
  // Positions link N-N now: membership lives in department_positions, not positions.department_id.
  const links = await sql!`
    select dp.department_id
    from public.department_positions dp
    where dp.position_id = ${positionId}::uuid
    order by dp.department_id`;
  if (!links.length) return json({ ok: false, error: "invalid_employee" }, 400);
  const deptIds = links.map((link) => String(link.department_id));
  let departmentId: string | null = null;
  if (!actor.is_admin && !actor.is_hr) {
    // Managers may only create/update inside their own department: the chosen
    // position must be linked to it.
    if (
      actor.department_id === null ||
      !deptIds.includes(actor.department_id)
    ) {
      return json({ ok: false, error: "forbidden" }, 403);
    }
    departmentId = actor.department_id;
  } else if (actor.is_hr && requestedDepartmentId) {
    if (!deptIds.includes(requestedDepartmentId)) {
      return json({ ok: false, error: "invalid_employee" }, 400);
    }
    departmentId = requestedDepartmentId;
  } else {
    // Admins: prefer their own department when linked, else the first membership.
    departmentId =
      actor.department_id && deptIds.includes(actor.department_id)
        ? actor.department_id
        : deptIds[0];
  }

  try {
    await sql!.begin(async (tx) => {
      let employeeId = id;

      if (!employeeId) {
        const code =
          requestedEmployeeCode ||
          `JW-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
        const [created] = await tx`
          insert into public.employees
            (employee_code, full_name, email, hire_date, current_position_id,
             current_department_id, employment_status, education, date_of_birth, gender)
          values
            (${code}, ${fullName}, ${email}, ${hireDate}::date, ${positionId}::uuid,
             ${departmentId}::uuid, ${employmentStatus}, ${education || null},
             ${dateOfBirth || null}::date, ${gender})
          returning employee_id`;
        employeeId = String(created.employee_id);

        const submittedPassword = str(body.password).trim();
        await tx`
          insert into public.employee_accounts
            (employee_id, username, password_hash, is_active)
          values
            (${employeeId}::uuid, ${email},
             extensions.crypt(${submittedPassword || "123456"}, extensions.gen_salt('bf', 10)),
             true)`;
      } else {
        await tx`
          update public.employees
          set full_name = ${fullName},
              email = ${email},
              hire_date = ${hireDate}::date,
              employment_status = ${employmentStatus},
              current_position_id = ${positionId}::uuid,
              current_department_id = ${departmentId}::uuid,
              education = ${education || null},
              date_of_birth = ${dateOfBirth || null}::date,
              gender = coalesce(${gender ? gender : null}, gender)
          where employee_id = ${employeeId}::uuid`;
      }

      await contactTx(tx, employeeId, phone, null);
      await recordEmploymentStatusTx(
        tx,
        employeeId,
        statusInput,
        hireDate,
        actor.employee_id,
      );
      if (roleId && !preserveExistingRole)
        await roleAssignTx(tx, actor, employeeId, roleId);
      const [activeRole] = await tx`
        select role_id
        from public.user_roles
        where employee_id = ${employeeId}::uuid
          and valid_from <= (now() at time zone 'Asia/Ho_Chi_Minh')::date
          and (valid_to is null or valid_to >= (now() at time zone 'Asia/Ho_Chi_Minh')::date)
        order by valid_from desc, user_role_id desc
        limit 1`;
      if (activeRole) {
        await updateEmployeeAccountPassword(
          tx,
          employeeId,
          String(activeRole.role_id),
        );
      }
    });
  } catch (err) {
    return dbError(err);
  }

  return json({ ok: true });
}

async function employeeDeleteAction(
  actor: Actor,
  body: Record<string, unknown>,
): Promise<Response> {
  const id = str(body.id);

  if (!UUID_RE.test(id)) {
    return json({ ok: false, error: "invalid_employee" }, 400);
  }

  if (!actor.is_admin && id === actor.employee_id) {
    return json({ ok: false, error: "forbidden_self_delete" }, 403);
  }

  if (!(await employeeInScope(actor, id))) {
    return json({ ok: false, error: "forbidden_out_of_scope" }, 403);
  }

  if (!actor.is_admin && (await employeeHoldsAdminRole(id))) {
    return json({ ok: false, error: "forbidden_cannot_delete_admin" }, 403);
  }

  if (!actor.is_admin) {
    const targetRoles = await sql!`
      select 1 from public.user_roles ur
      join public.roles r on r.role_id = ur.role_id
      where ur.employee_id = ${id}::uuid
        and lower(r.role_name) = any(${sql.array(MANAGER_ROLES)})
        and (ur.valid_from is null or ur.valid_from <= (now() at time zone 'Asia/Ho_Chi_Minh')::date)
        and (ur.valid_to is null or ur.valid_to >= (now() at time zone 'Asia/Ho_Chi_Minh')::date)`;

    if (targetRoles.length > 0) {
      return json(
        { ok: false, error: "forbidden_manager_cannot_delete_manager" },
        403,
      );
    }
  }

  // 1. Không cho phép ai tự xóa chính tài khoản của mình
  if (!actor.is_admin && id === actor.employee_id) {
    return json({ ok: false, error: "forbidden_self_delete" }, 403);
  }

  // 2. Kiểm tra phạm vi (Scope):
  // - Nếu là Admin hoặc HR Manager: employeeInScope sẽ luôn trả về True (được phép xóa toàn công ty)
  // - Nếu là Manager thường: employeeInScope chỉ trả về True nếu người bị xóa cùng phòng ban
  if (!(await employeeInScope(actor, id))) {
    return json({ ok: false, error: "forbidden_out_of_scope" }, 403);
  }

  // 3. Không ai được phép xóa Admin (Trừ khi người xóa cũng là Admin)
  if (!actor.is_admin && (await employeeHoldsAdminRole(id))) {
    return json({ ok: false, error: "forbidden_cannot_delete_admin" }, 403);
  }

  // (Đã gỡ bỏ đoạn mã cấm Manager xóa Manager khác. Bây giờ quyền lực được
  // quyết định hoàn toàn dựa vào phòng ban (Scope) ở bước 2).

  try {
    await sql!.begin(async (tx) => {
      // THỰC HIỆN XÓA MỀM (Dành cho cả Manager và Admin khi gọi qua hr-portal)

      // Đánh dấu tài khoản đã xóa, khóa tài khoản
      await tx`
        update public.employee_accounts
        set deleted_at = now(), is_active = false
        where employee_id = ${id}::uuid
          and deleted_at is null`;

      // Cập nhật trạng thái nhân viên thành đã nghỉ việc
      await tx`
        update public.employees
        set employment_status = 'Resigned'
        where employee_id = ${id}::uuid`;

      // Ghi log trạng thái nghỉ việc
      await tx`
        insert into public.hr_employment_status_history
          (employee_id, employment_status, effective_from, changed_by, reason)
        values (${id}::uuid, 'Resigned', (now() at time zone 'Asia/Ho_Chi_Minh')::date,
                ${actor.employee_id}::uuid, 'Quản lý xóa hồ sơ (Nghỉ việc)')`;
    });
  } catch (err) {
    return dbError(err);
  }

  return json({ ok: true });
}

async function roleAssignAction(
  actor: Actor,
  body: Record<string, unknown>,
): Promise<Response> {
  const employeeId = str(body.employee_id);
  const roleId = str(body.role_id);
  if (!UUID_RE.test(employeeId) || !UUID_RE.test(roleId))
    return json({ ok: false, error: "invalid_request" }, 400);
  if (!actor.is_admin && employeeId === actor.employee_id)
    return json({ ok: false, error: "forbidden" }, 403);
  if (!(await employeeInScope(actor, employeeId)))
    return json({ ok: false, error: "forbidden" }, 403);
  if (!(await canAssignRole(actor, roleId)))
    return json({ ok: false, error: "forbidden" }, 403);
  if (!actor.is_admin && (await employeeHoldsAdminRole(employeeId)))
    return json({ ok: false, error: "forbidden" }, 403);

  try {
    await sql!.begin(async (tx) => {
      await roleAssignTx(tx, actor, employeeId, roleId);
    });
  } catch (err) {
    return dbError(err);
  }

  return json({ ok: true });
}

async function permissionsSaveAction(
  actor: Actor,
  body: Record<string, unknown>,
): Promise<Response> {
  const employeeId = str(body.employee_id);
  const roleId = str(body.role_id);
  const permissionIds = Array.isArray(body.permission_ids)
    ? body.permission_ids.filter(
        (value): value is string =>
          typeof value === "string" && UUID_RE.test(value),
      )
    : [];
  if (!UUID_RE.test(employeeId) || !UUID_RE.test(roleId))
    return json({ ok: false, error: "invalid_request" }, 400);
  if (!(await employeeInScope(actor, employeeId)))
    return json({ ok: false, error: "forbidden" }, 403);
  // role_permissions rows are global config shared by every department: the
  // Admin portal owns them. Managers may assign roles but never rewrite the
  // permission set of any role.
  if (!actor.is_admin) return json({ ok: false, error: "forbidden" }, 403);

  try {
    await sql!.begin(async (tx) => {
      const [assigned] = await tx`
        select 1 from public.user_roles
        where employee_id = ${employeeId}::uuid and role_id = ${roleId}::uuid
          and valid_to is null`;
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
  } catch (err) {
    return dbError(err);
  }

  return json({ ok: true });
}

async function leaveReviewAction(
  actor: Actor,
  body: Record<string, unknown>,
): Promise<Response> {
  const requestId = str(body.leave_request_id);
  const statusInput = str(body.status).toLowerCase();
  if (!UUID_RE.test(requestId))
    return json({ ok: false, error: "invalid_request" }, 400);
  if (!["approved", "rejected"].includes(statusInput))
    return json({ ok: false, error: "invalid_status" }, 400);

  try {
    const [leave] = await sql`
      select employee_id, lower(status::text) as status, leader_status, start_date, reason
      from public.leave_requests
      where leave_request_id = ${requestId}::uuid
      limit 1`;
    if (!leave) return json({ ok: false, error: "invalid_reference" }, 400);
    if (leave.status !== "pending")
      return json({ ok: false, error: "already_decided" }, 400);
    if (leave.leader_status !== "approved")
      return json({ ok: false, error: "pending_leader_review" }, 400);
    if (String(leave.employee_id) === actor.employee_id) {
      return json({ ok: false, error: "forbidden" }, 403); // no self-approval
    }
    if (!(await employeeInScope(actor, String(leave.employee_id)))) {
      return json({ ok: false, error: "forbidden" }, 403);
    }

    // Single statement: no transaction needed (and the pool is max 1, so nested
    // pool queries inside sql.begin would deadlock).
    const updated = await sql`
      update public.leave_requests
      set status = ${statusInput === "approved" ? "Approved" : "Rejected"},
          approved_by = ${actor.employee_id}::uuid,
          decided_at = now()
      where leave_request_id = ${requestId}::uuid
      and lower(status::text) = 'pending'
      and leader_status = 'approved'
      returning employee_id`;

    if (!updated.length)
      return json({ ok: false, error: "already_decided" }, 400);

    if (statusInput === "approved") {
      await sql`
        insert into public.employee_status_history
          (employee_id, status, effective_date, reason, recorded_by)
        values
          (${leave.employee_id}::uuid, 'OnLeave', ${leave.start_date}::date,
           ${leave.reason || "Nghỉ phép"}, ${actor.employee_id}::uuid)`;
    }
  } catch (err) {
    return dbError(err);
  }

  return json({ ok: true });
}

async function leaderLeaveReviewAction(
  actor: Actor,
  body: Record<string, unknown>,
): Promise<Response> {
  const requestId = str(body.leave_request_id);
  const statusInput = str(body.status).toLowerCase();
  if (!UUID_RE.test(requestId))
    return json({ ok: false, error: "invalid_request" }, 400);
  if (!["approved", "rejected"].includes(statusInput))
    return json({ ok: false, error: "invalid_status" }, 400);

  try {
    const updated = await sql!`
      update public.leave_requests as lr
      set leader_status = ${statusInput},
          leader_reviewed_by = ${actor.employee_id}::uuid,
          leader_reviewed_at = now(),
          status = case when ${statusInput} = 'rejected' then 'Rejected' else status end,
          decided_at = case when ${statusInput} = 'rejected' then now() else decided_at end
      where lr.leave_request_id = ${requestId}::uuid
        and lower(lr.status::text) = 'pending'
        and lr.leader_status is null
        and lr.employee_id <> ${actor.employee_id}::uuid
        and exists (
          select 1
          from public.employees e
          left join lateral (
            select (array_agg(distinct dp.department_id))[1] as department_id
            from public.department_positions dp
            where dp.position_id = e.current_position_id
            having count(distinct dp.department_id) = 1
          ) position_department on true
          where e.employee_id = lr.employee_id
            and e.employment_status = 'Active'
            and (
              e.current_department_id = ${actor.department_id}::uuid
              or (
                e.current_department_id is null
                and position_department.department_id = ${actor.department_id}::uuid
              )
            )
            and exists (
              select 1 from public.employee_accounts a
              where a.employee_id = e.employee_id
                and a.is_active is true
                and a.deleted_at is null
            )
        )
      returning leave_request_id`;
    if (!updated.length)
      return json({ ok: false, error: "forbidden_or_already_decided" }, 400);
  } catch (err) {
    return dbError(err);
  }

  return json({
    ok: true,
    status: statusInput === "rejected" ? "rejected" : "pending",
  });
}

async function attendanceSaveAction(
  actor: Actor,
  body: Record<string, unknown>,
): Promise<Response> {
  const employeeId = str(body.employee_id);
  const workDate = str(body.work_date);
  const statusInput = str(body.status).toLowerCase();
  if (!UUID_RE.test(employeeId) || !isRealDate(workDate))
    return json({ ok: false, error: "invalid_request" }, 400);
  if (!(statusInput in ATTENDANCE_STATUS))
    return json({ ok: false, error: "invalid_status" }, 400);
  if (!(await employeeInScope(actor, employeeId)))
    return json({ ok: false, error: "forbidden" }, 403);

  // Optional day_code (code sheet). Absent property = untouched (payroll panel
  // keeps calling this without day_code); "" clears; otherwise must be a valid code.
  const hasDayCode = Object.prototype.hasOwnProperty.call(body, "day_code");
  let dayCode: string | null = null;
  if (hasDayCode) {
    dayCode = str(body.day_code).toUpperCase() || null; // "" → NULL (clear)
    if (dayCode && !(dayCode in DAY_CODE_STATUS))
      return json({ ok: false, error: "invalid_day_code" }, 400);
  }
  // day_code keeps status in sync on write; the code sheet owns the mapping.
  const statusInputForDb =
    hasDayCode && dayCode ? DAY_CODE_STATUS[dayCode].status : statusInput;
  // Clearing ("") removes the day entirely: a deleted entry must not linger
  // in the Time-Clock list (bug fix 2026-11-07).
  if (hasDayCode && !dayCode) {
    try {
      await sql!`
        delete from public.attendance_records
        where employee_id = ${employeeId}::uuid and work_date = ${workDate}::date`;
    } catch (err) {
      return dbError(err);
    }
    return json({ ok: true });
  }

  try {
    await sql!.begin(async (tx) => {
      const [existing] = await tx`
        select attendance_id from public.attendance_records
        where employee_id = ${employeeId}::uuid and work_date = ${workDate}::date
        limit 1`;
      if (existing) {
        await tx`
          update public.attendance_records
          set day_code = ${dayCode},
              status = ${ATTENDANCE_STATUS[statusInputForDb]}
          where attendance_id = ${existing.attendance_id}`;
      } else {
        await tx`
          insert into public.attendance_records
            (employee_id, work_date, status, day_code)
          values (${employeeId}::uuid, ${workDate}::date,
                  ${ATTENDANCE_STATUS[statusInputForDb]},
                  ${dayCode})`;
      }
      if (dayCode === "X") {
        await tx`
          update public.attendance_records
          set check_in_time = coalesce(check_in_time, ${FULL_DAY_IN}::time),
              check_out_time = coalesce(check_out_time, ${FULL_DAY_OUT}::time)
          where employee_id = ${employeeId}::uuid and work_date = ${workDate}::date`;
      }
    });
  } catch (err) {
    return dbError(err);
  }

  return json({ ok: true });
}

// Code sheet drag-paint: one transaction for a whole batch of painted cells.
async function attendanceBulkSaveAction(
  actor: Actor,
  body: Record<string, unknown>,
): Promise<Response> {
  const ym = str(body.ym);
  const items = Array.isArray(body.items) ? body.items : [];
  if (
    !/^\d{4}-(0[1-9]|1[0-2])$/.test(ym) ||
    !items.length ||
    items.length > 1200
  ) {
    return json({ ok: false, error: "invalid_request" }, 400);
  }

  // Validate every item before touching the database (all-or-nothing batch).
  const prepared: {
    employeeId: string;
    workDate: string;
    dayCode: string | null;
  }[] = [];
  const seenDays = new Set<string>();
  for (const item of items) {
    const employeeId =
      item && typeof item === "object"
        ? str((item as Record<string, unknown>).employee_id)
        : "";
    const workDate =
      item && typeof item === "object"
        ? str((item as Record<string, unknown>).work_date)
        : "";
    const dayCodeRaw =
      item && typeof item === "object"
        ? str((item as Record<string, unknown>).day_code).toUpperCase()
        : "";
    if (
      !UUID_RE.test(employeeId) ||
      !isRealDate(workDate) ||
      !workDate.startsWith(`${ym}-`)
    ) {
      return json({ ok: false, error: "invalid_request" }, 400);
    }
    const dayCode = dayCodeRaw || null; // "" → NULL = clear
    if (dayCode && !(dayCode in DAY_CODE_STATUS))
      return json({ ok: false, error: "invalid_day_code" }, 400);
    const dayKey = `${employeeId}:${workDate}`;
    if (seenDays.has(dayKey))
      return json({ ok: false, error: "duplicate_attendance_day" }, 400);
    seenDays.add(dayKey);
    prepared.push({ employeeId, workDate, dayCode });
  }

  if (actor.is_leader) {
    if (!actor.department_id)
      return json({ ok: false, error: "forbidden" }, 403);
    const inputRows = prepared.map((item) => ({
      employee_id: item.employeeId,
      work_date: item.workDate,
      day_code: item.dayCode,
    }));
    const inputJson = JSON.stringify(inputRows);
    const employeeIds = [...new Set(prepared.map((item) => item.employeeId))];

    try {
      await sql!.begin(async (tx) => {
        const lockedEmployees = await tx`
          select e.employee_id
          from public.employees e
          left join lateral (
            select (array_agg(distinct dp.department_id))[1] as department_id
            from public.department_positions dp
            where dp.position_id = e.current_position_id
            having count(distinct dp.department_id) = 1
          ) position_department on true
          where e.employee_id = any(${sql!.array([...employeeIds, actor.employee_id])}::uuid[])
            and (
              (
                e.employee_id = ${actor.employee_id}::uuid
                and e.employment_status = 'Active'
                and coalesce(e.current_department_id, position_department.department_id) = ${actor.department_id}::uuid
              )
              or (
                e.employee_id <> ${actor.employee_id}::uuid
                and e.employment_status = 'Active'
                and exists (
                  select 1 from public.employee_accounts a
                  where a.employee_id = e.employee_id
                    and a.is_active is true
                    and a.deleted_at is null
                )
                and (
                  e.current_department_id = ${actor.department_id}::uuid
                  or (
                    e.current_department_id is null
                    and position_department.department_id = ${actor.department_id}::uuid
                  )
                )
              )
            )
          order by e.employee_id
          for update of e`;
        if (lockedEmployees.length !== employeeIds.length + 1)
          throw makeError("forbidden");

        await tx`
          select pg_advisory_xact_lock(
            hashtextextended(locked.employee_id::text || ':' || locked.work_date::text, 0)
          )
          from (
            select distinct input.employee_id, input.work_date
            from jsonb_to_recordset(${inputJson}::jsonb)
              as input(employee_id uuid, work_date date, day_code text)
            order by input.employee_id, input.work_date
          ) locked`;

        await tx`
          with input as (
            select * from jsonb_to_recordset(${inputJson}::jsonb)
              as item(employee_id uuid, work_date date, day_code text)
          )
          delete from public.attendance_records ar
          using input
          where input.day_code is null
            and ar.employee_id = input.employee_id
            and ar.work_date = input.work_date`;

        const codeGroups = [
          { codes: ["X"], status: "Present" },
          { codes: ["P", "L"], status: "OnLeave" },
          { codes: ["O", "KP"], status: "Absent" },
        ];
        for (const group of codeGroups) {
          await tx`
            with input as (
              select * from jsonb_to_recordset(${inputJson}::jsonb)
                as item(employee_id uuid, work_date date, day_code text)
            )
            update public.attendance_records ar
            set status = ${group.status},
                day_code = input.day_code,
                check_in_time = case
                  when input.day_code = 'X' then coalesce(ar.check_in_time, ${FULL_DAY_IN}::time)
                  else ar.check_in_time
                end,
                check_out_time = case
                  when input.day_code = 'X' then coalesce(ar.check_out_time, ${FULL_DAY_OUT}::time)
                  else ar.check_out_time
                end
            from input
            where input.day_code = any(${sql!.array(group.codes)})
              and ar.employee_id = input.employee_id
              and ar.work_date = input.work_date`;

          await tx`
            with input as (
              select * from jsonb_to_recordset(${inputJson}::jsonb)
                as item(employee_id uuid, work_date date, day_code text)
            )
            insert into public.attendance_records
              (employee_id, work_date, status, day_code, check_in_time, check_out_time)
            select input.employee_id, input.work_date, ${group.status}, input.day_code,
                   case when input.day_code = 'X' then ${FULL_DAY_IN}::time else null end,
                   case when input.day_code = 'X' then ${FULL_DAY_OUT}::time else null end
            from input
            where input.day_code = any(${sql!.array(group.codes)})
              and not exists (
                select 1 from public.attendance_records ar
                where ar.employee_id = input.employee_id
                  and ar.work_date = input.work_date
              )`;
        }
      });
    } catch (err) {
      return dbError(err);
    }

    return json({ ok: true, count: prepared.length });
  }

  for (const employeeId of new Set(prepared.map((it) => it.employeeId))) {
    if (!(await employeeInScope(actor, employeeId)))
      return json({ ok: false, error: "forbidden" }, 403);
  }

  try {
    await sql!.begin(async (tx) => {
      for (const it of prepared) {
        const [existing] = await tx`
          select attendance_id from public.attendance_records
          where employee_id = ${it.employeeId}::uuid and work_date = ${it.workDate}::date
          limit 1`;
        if (existing) {
          if (it.dayCode) {
            // Paint sets code + mapped status. X also fills 07:00–17:00 clock
            // times when the row has none (real timestamps win).
            if (it.dayCode === "X") {
              await tx`
                update public.attendance_records
                set day_code = ${it.dayCode},
                    status = ${ATTENDANCE_STATUS[DAY_CODE_STATUS[it.dayCode].status]},
                    check_in_time = coalesce(check_in_time, ${FULL_DAY_IN}::time),
                    check_out_time = coalesce(check_out_time, ${FULL_DAY_OUT}::time)
                where attendance_id = ${existing.attendance_id}`;
            } else {
              await tx`
                update public.attendance_records
                set day_code = ${it.dayCode},
                    status = ${ATTENDANCE_STATUS[DAY_CODE_STATUS[it.dayCode].status]}
                where attendance_id = ${existing.attendance_id}`;
            }
          } else {
            // Clear erases the day: delete the row so the entry disappears
            // from the Time-Clock list (bug fix 2026-11-07).
            await tx`
              delete from public.attendance_records
              where employee_id = ${it.employeeId}::uuid and work_date = ${it.workDate}::date`;
          }
        } else if (it.dayCode) {
          await tx`
            insert into public.attendance_records
              (employee_id, work_date, status, day_code, check_in_time, check_out_time)
            values (${it.employeeId}::uuid, ${it.workDate}::date,
                    ${ATTENDANCE_STATUS[DAY_CODE_STATUS[it.dayCode].status]}, ${it.dayCode},
                    ${it.dayCode === "X" ? FULL_DAY_IN : null}::time,
                    ${it.dayCode === "X" ? FULL_DAY_OUT : null}::time)`;
        }
      }
    });
  } catch (err) {
    return dbError(err);
  }

  return json({ ok: true, count: prepared.length });
}

async function payrollSaveAction(
  actor: Actor,
  body: Record<string, unknown>,
): Promise<Response> {
  const employeeId = str(body.employee_id);
  const year = Number(body.pay_year);
  const month = Number(body.pay_month);
  const baseSalary = Number(body.base_salary);
  const allowance = Number(body.allowance ?? 0);
  const overtimePay = 0;
  const workDays = Number(body.work_days ?? 0);
  const standardDays = Number(body.standard_days ?? 0);
  const insuranceAmount = Number(body.insurance_amount ?? 0);
  const tax = Number(body.personal_income_tax ?? 0);
  const totalDeductions = Number(
    body.total_deductions ?? insuranceAmount + tax,
  );
  const grossSalary = Number(body.gross_salary ?? 0);
  const netSalary = Number(body.net_salary ?? 0);

  if (!UUID_RE.test(employeeId))
    return json({ ok: false, error: "invalid_request" }, 400);
  if (
    !Number.isInteger(year) ||
    !Number.isInteger(month) ||
    month < 1 ||
    month > 12 ||
    year < 2000 ||
    year > 2100
  ) {
    return json({ ok: false, error: "invalid_period" }, 400);
  }
  const inputs = [
    baseSalary,
    allowance,
    overtimePay,
    workDays,
    standardDays,
    insuranceAmount,
    tax,
    totalDeductions,
    grossSalary,
    netSalary,
  ];
  if (inputs.some((value) => !Number.isFinite(value) || value < 0))
    return json({ ok: false, error: "invalid_amounts" }, 400);
  if (netSalary > grossSalary)
    return json({ ok: false, error: "invalid_amounts" }, 400);
  if (!(await employeeInScope(actor, employeeId)))
    return json({ ok: false, error: "forbidden" }, 403);

  try {
    await sql!.begin(async (tx) => {
      const [existing] = await tx`
        select payroll_id from public.payroll
        where employee_id = ${employeeId}::uuid and pay_year = ${year} and pay_month = ${month}
        limit 1`;
      if (existing) {
        // night_pay is NOT NULL without a default in the live schema; every
        // save must set it or new-month inserts fail (bug fix 2026-11-07).
        await tx`
          update public.payroll
          set base_salary = ${baseSalary}, total_allowance = ${allowance},
              total_deduction = ${totalDeductions}, bonus = ${allowance},
              overtime_pay = ${overtimePay}, night_pay = 0,
              work_days = ${workDays}, standard_days = ${standardDays},
              insurance_amount = ${insuranceAmount},
              personal_income_tax = ${tax},
              gross_salary = ${grossSalary}, net_salary = ${netSalary}
          where payroll_id = ${existing.payroll_id}`;
      } else {
        await tx`
          insert into public.payroll
            (employee_id, pay_year, pay_month, base_salary, total_allowance,
             total_deduction, bonus, overtime_pay, night_pay, work_days, standard_days,
             insurance_amount, personal_income_tax, gross_salary, net_salary)
          values (${employeeId}::uuid, ${year}, ${month}, ${baseSalary}, ${allowance},
                  ${totalDeductions}, ${allowance}, ${overtimePay}, 0,
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
  if (req.method === "OPTIONS")
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (req.method !== "POST")
    return json({ ok: false, error: "method_not_allowed" }, 405);

  if (!sql || !JWT_KEY) {
    console.error("hr-portal: SUPABASE_DB_URL or ADMIN_JWT_SECRET is not set");
    return json({ ok: false, error: "server_not_configured" }, 500);
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: "bad_request" }, 400);
  }

  const token = req.headers.get("x-admin-token") ?? "";
  const action = str(body.action);

  // Fast-path ping: ultra lightweight check without heavy multi-table joins
  if (action === "ping") {
    if (!token) return json({ ok: false, error: "unauthorized" }, 401);
    try {
      const { payload } = await jwtVerify(token, JWT_KEY, {
        algorithms: ["HS256"],
      });
      const employeeId =
        typeof payload.employee_id === "string" ? payload.employee_id : "";
      if (!UUID_RE.test(employeeId))
        return json({ ok: false, error: "unauthorized" }, 401);
      const [acc] = await sql`
        select is_active, deleted_at, pending_notice
        from public.employee_accounts
        where employee_id = ${employeeId}::uuid
        limit 1`;
      if (!acc || acc.deleted_at || !acc.is_active) {
        return json(
          {
            ok: false,
            error: "unauthorized",
            pending_notice: parseNotice(acc?.pending_notice),
          },
          401,
        );
      }
      return json({
        ok: true,
        pending_notice: parseNotice(acc.pending_notice),
      });
    } catch {
      return json({ ok: false, error: "unauthorized" }, 401);
    }
  }

  await ensureNoticeColumn();

  let actor: Actor | null;
  try {
    actor = token ? await getActor(token) : null;
  } catch (err) {
    return dbError(err); // database trouble is not a bad token
  }
  if (!actor) {
    let redirectUrl = "../manager/login.html";
    let activeRole = "";
    let pendingNotice: unknown = null;
    if (token) {
      try {
        const { payload } = await jwtVerify(token, JWT_KEY!, {
          algorithms: ["HS256"],
        });
        const employeeId =
          typeof payload.employee_id === "string" ? payload.employee_id : "";
        if (UUID_RE.test(employeeId)) {
          const [roleRow] = await sql!`
            select
              (select pending_notice from public.employee_accounts where employee_id = ${employeeId}::uuid limit 1) as pending_notice,
              exists (
                select 1 from public.user_roles ur
                join public.roles r on r.role_id = ur.role_id
                where ur.employee_id = ${employeeId}::uuid
                  and r.role_name = 'Admin'
                  and (ur.valid_from is null or ur.valid_from <= (now() at time zone 'Asia/Ho_Chi_Minh')::date)
                  and (ur.valid_to is null or ur.valid_to >= (now() at time zone 'Asia/Ho_Chi_Minh')::date)
              ) as is_admin,
              exists (
                select 1 from public.user_roles ur
                join public.roles r on r.role_id = ur.role_id
                where ur.employee_id = ${employeeId}::uuid
                  and lower(r.role_name) = any(${sql.array(MANAGER_ROLES)})
                  and (ur.valid_from is null or ur.valid_from <= (now() at time zone 'Asia/Ho_Chi_Minh')::date)
                  and (ur.valid_to is null or ur.valid_to >= (now() at time zone 'Asia/Ho_Chi_Minh')::date)
              ) or exists (
                select 1 from public.user_roles ur
                join public.role_permissions rp on rp.role_id = ur.role_id
                join public.permissions p on p.permission_id = rp.permission_id
                where ur.employee_id = ${employeeId}::uuid
                  and lower(p.permission_code) = any(${sql.array(MANAGER_PERMISSIONS)})
                  and (ur.valid_from is null or ur.valid_from <= (now() at time zone 'Asia/Ho_Chi_Minh')::date)
                  and (ur.valid_to is null or ur.valid_to >= (now() at time zone 'Asia/Ho_Chi_Minh')::date)
              ) as is_manager,
              exists (
                select 1 from public.user_roles ur
                join public.roles r on r.role_id = ur.role_id
                where ur.employee_id = ${employeeId}::uuid
                  and lower(r.role_name) = any(${sql.array(LEADER_ROLES)})
                  and (ur.valid_from is null or ur.valid_from <= (now() at time zone 'Asia/Ho_Chi_Minh')::date)
                  and (ur.valid_to is null or ur.valid_to >= (now() at time zone 'Asia/Ho_Chi_Minh')::date)
              ) or exists (
                select 1 from public.user_roles ur
                join public.role_permissions rp on rp.role_id = ur.role_id
                join public.permissions p on p.permission_id = rp.permission_id
                where ur.employee_id = ${employeeId}::uuid
                  and lower(p.permission_code) = any(${sql.array(LEADER_PERMISSIONS)})
                  and (ur.valid_from is null or ur.valid_from <= (now() at time zone 'Asia/Ho_Chi_Minh')::date)
                  and (ur.valid_to is null or ur.valid_to >= (now() at time zone 'Asia/Ho_Chi_Minh')::date)
              ) as is_leader`;
          if (roleRow) {
            if (roleRow.pending_notice) {
              pendingNotice = parseNotice(roleRow.pending_notice);
            }
            if (roleRow.is_admin) {
              activeRole = "Admin";
              redirectUrl = "../admin/login.html";
            } else if (roleRow.is_manager) {
              activeRole = "Manager";
              redirectUrl = "../manager/login.html";
            } else if (roleRow.is_leader) {
              activeRole = "Leader";
              redirectUrl = "../leader/login.html";
            } else {
              redirectUrl = "../staff/staff-login.html";
            }
          }
        }
      } catch {
        // ignore
      }
    }
    return json(
      {
        ok: false,
        error: "unauthorized",
        role: activeRole,
        redirect_url: redirectUrl,
        pending_notice: pendingNotice,
      },
      401,
    );
  }

  const sharedActions = [
    "ping",
    "clear_notice",
    "attendance_list",
    "attendance_clock",
  ];
  const leaderExclusiveActions = [
    "leader_boot",
    "leader_leave_review",
    "leader_attendance_bulk",
    "leader_attendance_list",
    "leader_attendance_clock",
  ];
  if (
    (actor.is_leader &&
      ![...sharedActions, ...leaderExclusiveActions].includes(action)) ||
    (!actor.is_leader && leaderExclusiveActions.includes(action)) ||
    (!actor.is_admin &&
      !actor.is_manager &&
      !actor.is_leader &&
      !["ping", "clear_notice"].includes(action))
  ) {
    return json(
      {
        ok: false,
        error: "forbidden",
        pending_notice: actor.pending_notice || null,
      },
      403,
    );
  }

  try {
    switch (action) {
      case "ping":
        return json({ ok: true, pending_notice: actor.pending_notice || null });
      case "clear_notice": {
        await sql!`update public.employee_accounts set pending_notice = null where employee_id = ${actor.employee_id}::uuid`;
        return json({ ok: true });
      }
      case "boot":
        return await bootAction(actor);
      case "leader_boot":
        return await leaderBootAction(actor, body);
      case "attendance_list":
      case "leader_attendance_list":
        return await leaderAttendanceListAction(actor);
      case "attendance_clock":
      case "leader_attendance_clock":
        return await leaderAttendanceClockAction(actor, body);
      case "employee_save":
        return await employeeSaveAction(actor, body);
      case "employee_delete":
        return await employeeDeleteAction(actor, body);
      case "role_assign":
        return await roleAssignAction(actor, body);
      case "permissions_save":
        return await permissionsSaveAction(actor, body);
      case "leave_review":
        return await leaveReviewAction(actor, body);
      case "leader_leave_review":
        return await leaderLeaveReviewAction(actor, body);
      case "attendance_save":
        return await attendanceSaveAction(actor, body);
      case "attendance_bulk":
        return await attendanceBulkSaveAction(actor, body);
      case "leader_attendance_bulk":
        return await attendanceBulkSaveAction(actor, body);
      case "payroll_save":
        return await payrollSaveAction(actor, body);
      default:
        return json({ ok: false, error: "unknown_action" }, 400);
    }
  } catch (err) {
    return dbError(err);
  }
});
