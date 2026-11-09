// POST /functions/v1/staff-portal
// Header: x-admin-token (HS256 session token issued by admin-login portal mode).
// Body:   { action, ... }
//   boot:           employee + contact + position/department + roles + permissions in one call
//   update_profile: own full_name, date_of_birth, phone_number, address, marital_status
//   personal_info:  own identity record, qualifications and status history
//   personal_info_save: own identity fields (national_id, id_type, nationality)
//   qualifications_save: replace own qualification rows
//   status_history_save: replace own status history rows
//   leave_list:     own leave requests with labels
//   leave_create:   submit a leave request (label → leave_types; num_days computed)
//   leave_summary:  KPI summary for the leave panel (quota, used, pending, upcoming)
//   payroll_month:  one payroll row for a year/month
//   payroll_year:   all payroll rows for a year
//   attendance_list: today + recent attendance rows for the clock panel
//   attendance_clock: toggle today's record (clock in -> clock out)
// Every statement is scoped to the session employee; the function connects as
// a trusted backend (RLS bypassed), so scoping is enforced here, not by RLS.
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
const sql = (
  SUPABASE_DB_URL
    ? postgres(SUPABASE_DB_URL, { max: 1, prepare: false, ssl: "require" })
    : null
) as unknown as ReturnType<typeof postgres>;

const JWT_KEY = ADMIN_JWT_SECRET ? new TextEncoder().encode(ADMIN_JWT_SECRET) : null;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MANAGER_ROLE_NAMES = ["manager", "hr_manager", "quản lý", "quản lý nhân sự"];
const MANAGER_PERMISSION_CODES = ["manager", "hr_manager", "manage_staff", "manage_employees"];

type Actor = { employee_id: string; username: string; full_name: string; pending_notice?: unknown };

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

async function activePortalRole(employeeId: string): Promise<string> {
  const [row] = await sql!`
    select
      exists (
        select 1 from public.user_roles ur
        join public.roles r on r.role_id = ur.role_id
        where ur.employee_id = ${employeeId}::uuid and r.role_name = 'Admin'
          and ur.valid_from <= (now() at time zone 'Asia/Ho_Chi_Minh')::date
          and (ur.valid_to is null or ur.valid_to >= (now() at time zone 'Asia/Ho_Chi_Minh')::date)
      ) as is_admin,
      exists (
        select 1 from public.user_roles ur
        join public.roles r on r.role_id = ur.role_id
        where ur.employee_id = ${employeeId}::uuid
          and lower(r.role_name) = any(${sql.array(MANAGER_ROLE_NAMES)})
          and ur.valid_from <= (now() at time zone 'Asia/Ho_Chi_Minh')::date
          and (ur.valid_to is null or ur.valid_to >= (now() at time zone 'Asia/Ho_Chi_Minh')::date)
      ) or exists (
        select 1 from public.user_roles ur
        join public.role_permissions rp on rp.role_id = ur.role_id
        join public.permissions p on p.permission_id = rp.permission_id
        where ur.employee_id = ${employeeId}::uuid
          and lower(p.permission_code) = any(${sql.array(MANAGER_PERMISSION_CODES)})
          and ur.valid_from <= (now() at time zone 'Asia/Ho_Chi_Minh')::date
          and (ur.valid_to is null or ur.valid_to >= (now() at time zone 'Asia/Ho_Chi_Minh')::date)
      ) as is_manager`;
  if (row?.is_admin) return "Admin";
  if (row?.is_manager) return "Manager";
  return "";
}

function isRealDate(value: string): boolean {
  if (!DATE_RE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
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
    console.error("staff-portal: ensureNoticeColumn failed", err);
  }
  try {
    await sql!`
      alter table if exists public.payroll
        drop column if exists overtime_pay cascade,
        drop column if exists night_pay cascade,
        drop column if exists payment_date cascade`;
  } catch (err) {
    console.warn("staff-portal: drop payroll columns failed", err);
  }
  noticeColumnChecked = true;
}

async function getActor(token: string): Promise<Actor | null> {
  let employeeId = "";
  let iat = 0;
  try {
    const { payload } = await jwtVerify(token, JWT_KEY!, { algorithms: ["HS256"] });
    employeeId = typeof payload.employee_id === "string" ? payload.employee_id : "";
    iat = typeof payload.iat === "number" ? payload.iat : 0;
  } catch (err) {
    console.error("staff-portal: JWT verification failed", {
      name: err instanceof Error ? err.name : "UnknownError",
      message: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
  if (!UUID_RE.test(employeeId)) return null;

  let rows;
  try {
    rows = await sql!`
      select e.employee_id, a.username, e.full_name, a.pending_notice
      from public.employees e
      join public.employee_accounts a on a.employee_id = e.employee_id
      where e.employee_id = ${employeeId}::uuid
        and a.is_active is true
        and a.deleted_at is null
        and e.employment_status = 'Active'
      limit 1`;
  } catch (err) {
    const code = (err as { code?: string })?.code ?? "";
    if (code === "42703") {
      rows = await sql!`
        select e.employee_id, a.username, e.full_name, null as pending_notice
        from public.employees e
        join public.employee_accounts a on a.employee_id = e.employee_id
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
    | { employee_id: string; username: string; full_name: string; pending_notice?: unknown }
    | undefined;
  if (!row) return null;

  // Privileged accounts must use their dedicated portal; reject old staff sessions too.
  if (["Admin", "Manager"].includes(await activePortalRole(employeeId))) return null;

  return {
    employee_id: row.employee_id,
    username: row.username,
    full_name: row.full_name,
    pending_notice: parseNotice(row.pending_notice),
  };
}

const DB_ERRORS: Record<string, string> = {
  "23505": "duplicate",
  "23503": "invalid_reference",
  "23514": "leave_rule",
  "23P01": "leave_rule",
};

function dbError(err: unknown): Response {
  const code = (err as { code?: string })?.code ?? "";
  if (DB_ERRORS[code]) return json({ ok: false, error: DB_ERRORS[code] }, 400);
  console.error("staff-portal: unhandled database error", err);
  return json({ ok: false, error: "server_error" }, 500);
}

// Column lists are inlined in each statement (same style as admin-accounts);
// sql.raw fragments proved unreliable under npm:postgres in Deno.
async function ownEmployee(tx: typeof sql, employeeId: string) {
  const rows = await tx!`
    select employee_id, employee_code, full_name, date_of_birth, email, gender,
           hire_date, employment_status, current_position_id as position_id, education
    from public.employees
    where employee_id = ${employeeId}::uuid`;
  return rows[0] ?? null;
}

async function ownContact(tx: typeof sql, employeeId: string) {
  const rows = await tx!`
    select employee_id, phone_number, address
    from public.employees
    where employee_id = ${employeeId}::uuid`;
  return rows[0] ?? null;
}

async function bootAction(actor: Actor): Promise<Response> {
  const [contact, position, roleRows] = await Promise.all([
    ownContact(sql, actor.employee_id),
    sql!`
      select p.position_id, p.position_title, e.current_department_id as department_id, d.department_name
      from public.employees e
      join public.positions p on p.position_id = e.current_position_id
      left join public.departments d on d.department_id = e.current_department_id
      where e.employee_id = ${actor.employee_id}::uuid
      limit 1`,
    sql!`
      select r.role_id, r.role_name
      from public.user_roles ur
      join public.roles r on r.role_id = ur.role_id
      where ur.employee_id = ${actor.employee_id}::uuid
        and ur.valid_from <= (now() at time zone 'Asia/Ho_Chi_Minh')::date
        and (ur.valid_to is null or ur.valid_to >= (now() at time zone 'Asia/Ho_Chi_Minh')::date)`,
  ]);

  const roleIds = roleRows.map((row) => String(row.role_id));
  const permissionRows = roleIds.length
    ? await sql!`
        select p.permission_code
        from public.role_permissions rp
        join public.permissions p on p.permission_id = rp.permission_id
        where rp.role_id = any(${sql.array(roleIds)}::uuid[])`
    : [];

  const employee = await ownEmployee(sql, actor.employee_id);

  return json({
    ok: true,
    employee,
    contact: contact ?? null,
    position: (position as any[])[0] ?? null,
    roleNames: roleRows.map((row) => String(row.role_name)),
    permissionCodes: permissionRows.map((row) => String(row.permission_code).toLowerCase()),
    pending_notice: actor.pending_notice || null,
  });
}

function abbreviatePosition(positionName: string): string {
  const normalized = positionName.trim().toLowerCase();
  if (normalized.includes("admin")) return "AD";
  if (normalized.includes("quản lý") || normalized.includes("manager")) return "QL";
  if (normalized.includes("nhân viên") || normalized.includes("staff")) return "NV";
  return (
    normalized
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((word) => word[0])
      .join("") || "NV"
  ).toUpperCase();
}

function generateAccountPassword(
  roleName: string,
  departmentDescription: string,
  dateOfBirth: string,
): string {
  const positionPrefix = abbreviatePosition(roleName);
  const departmentPrefix = (departmentDescription || "")
    .trim()
    .slice(0, 3)
    .toLowerCase();
  const [year, month, day] = dateOfBirth.split("-");
  return `${positionPrefix}${departmentPrefix}@${day}${month}${year}`;
}

async function updateProfileAction(actor: Actor, body: Record<string, unknown>): Promise<Response> {
  // Slices match the column limits so an oversized payload fails cleanly, not 500.
  const fullName = str(body.full_name).slice(0, 150);
  const phoneNumber = str(body.phone_number).trim();
  const address = str(body.address).slice(0, 180);
  const dob = str(body.date_of_birth);

  if (!fullName || !isRealDate(dob)) return json({ ok: false, error: "invalid_profile" }, 400);
  if (phoneNumber && !/^\d{10}$/.test(phoneNumber)) return json({ ok: false, error: "invalid_phone" }, 400);

  const [currentEmp] = await sql!`
    select to_char(e.date_of_birth, 'YYYY-MM-DD') as old_dob,
           coalesce(r.role_name, 'Nhân viên') as role_name,
           coalesce(d.description, d.department_name, '') as department_description
    from public.employees e
    left join public.departments d on d.department_id = e.current_department_id
    left join lateral (
      select r.role_name
      from public.user_roles ur
      join public.roles r on r.role_id = ur.role_id
      where ur.employee_id = e.employee_id
        and ur.valid_from <= (now() at time zone 'Asia/Ho_Chi_Minh')::date
        and (ur.valid_to is null or ur.valid_to >= (now() at time zone 'Asia/Ho_Chi_Minh')::date)
      order by ur.valid_from desc, ur.user_role_id desc
      limit 1
    ) r on true
    where e.employee_id = ${actor.employee_id}::uuid
    limit 1`;

  const dobChanged = Boolean(currentEmp?.old_dob && currentEmp.old_dob !== dob);
  const newPassword = dobChanged
    ? generateAccountPassword(
        String(currentEmp?.role_name || "Nhân viên"),
        String(currentEmp?.department_description || ""),
        dob,
      )
    : "";

  await sql!.begin(async (tx) => {
    await tx`
      update public.employees
      set full_name = ${fullName},
          date_of_birth = ${dob}::date,
          updated_at = now()
      where employee_id = ${actor.employee_id}::uuid`;

    if (dobChanged && newPassword) {
      await tx`
        update public.employee_accounts
        set password_hash = extensions.crypt(${newPassword}, extensions.gen_salt('bf', 10))
        where employee_id = ${actor.employee_id}::uuid`;
    }

    await tx`
      update public.employees
      set phone_number = ${phoneNumber || null},
          address = ${address || null}
      where employee_id = ${actor.employee_id}::uuid`;
    // Marital status is the only identity field the employee may self-edit;
    // no insert — the row is HR-seeded (national_id is NOT NULL).
    const marital = str(body.marital_status);
    if (marital) {
      await tx`
        update public.employee_personal_info
        set marital_status = ${marital}
        where employee_id = ${actor.employee_id}::uuid`;
    }
  });

  const [employee, contact] = await Promise.all([
    ownEmployee(sql, actor.employee_id),
    ownContact(sql, actor.employee_id),
  ]);

  return json({
    ok: true,
    employee,
    contact: contact ?? null,
    password_changed: dobChanged,
    new_password: dobChanged ? newPassword : null,
  });
}

// Own identity + qualification + status-history payload for the profile menu.
// Read only besides marital_status in updateProfileAction; the rest is HR data.
async function personalInfoAction(actor: Actor): Promise<Response> {
  const [personal] = await sql!`
    select national_id, id_type, nationality, marital_status,
           is_disabled, to_char(protected_until, 'YYYY-MM-DD') as protected_until
    from public.employee_personal_info
    where employee_id = ${actor.employee_id}::uuid
    limit 1`;
  const qualifications = await sql!`
    select qualification_level, major_field, institution_name, graduation_year
    from public.employee_qualifications
    where employee_id = ${actor.employee_id}::uuid
    order by graduation_year desc nulls last`;
  const history = await sql!`
    select status, effective_date, end_date, reason
    from (
      select 'OnLeave' as status,
             to_char(start_date, 'YYYY-MM-DD') as effective_date,
             to_char(end_date, 'YYYY-MM-DD') as end_date,
             coalesce(reason, 'Nghỉ phép') as reason
      from public.leave_requests
      where employee_id = ${actor.employee_id}::uuid
        and lower(status::text) = 'approved'
      union
      select 'OnLeave' as status,
             to_char(effective_date, 'YYYY-MM-DD') as effective_date,
             null as end_date,
             reason
      from public.employee_status_history
      where employee_id = ${actor.employee_id}::uuid
        and (status = 'OnLeave' or status = 'Đang nghỉ phép')
    ) s
    order by effective_date desc`;
  return json({
    ok: true,
    personal_info: personal ?? null,
    qualifications,
    status_history: history,
  });
}

async function leaveListAction(actor: Actor): Promise<Response> {
  const rows = await sql!`
    select r.leave_request_id, r.employee_id, r.start_date, r.end_date, r.num_days,
           r.reason, r.status, r.requested_at, r.decided_at,
           case t.type_name
             when 'Nghỉ phép' then 'annual'
             when 'Nghỉ ốm đau' then 'sick'
             when 'Nghỉ thai sản' then 'maternity'
             when 'Xin nghỉ việc' then 'resignation'
             else t.type_name
           end as leave_type,
           t.type_name as leave_type_label
    from public.leave_requests r
    left join public.leave_types t on t.leave_type_id = r.leave_type_id
    where r.employee_id = ${actor.employee_id}::uuid
    order by r.start_date desc`;
  return json({ ok: true, requests: rows });
}

// KPI source for the four leave cards. Definitions mirror the business rules
// already enforced in leaveCreateAction and the manager portal:
// - annual quota uses pending + approved sum of the year (same as the quota check);
// - used days only count approved, non-resignation leave that has actually
//   started, clamped to today (calendar days, same num_days rule);
// - upcoming is the nearest approved leave that has not finished yet.
async function leaveSummaryAction(actor: Actor): Promise<Response> {
  const [todayRow] = await sql!`
    select (now() at time zone 'Asia/Ho_Chi_Minh')::date::text as today`;
  const today = String(todayRow.today);
  const year = Number(today.slice(0, 4));

  const [quota] = await sql!`
    select coalesce(max_days_per_year, 0)::int as granted
    from public.leave_types
    where type_name = 'Nghỉ phép'
    limit 1`;

  const [annual] = await sql!`
    select coalesce(sum(r.num_days), 0)::int as committed
    from public.leave_requests r
    join public.leave_types t on t.leave_type_id = r.leave_type_id
    where r.employee_id = ${actor.employee_id}::uuid
      and t.type_name = 'Nghỉ phép'
      and date_part('year', r.start_date) = ${year}
      and lower(r.status::text) in ('pending', 'approved')`;

  const [rest] = await sql!`
    select coalesce(sum(
      greatest(least(coalesce(r.end_date, r.start_date), ${today}::date) - r.start_date + 1, 0)
    ), 0)::int as used_days
    from public.leave_requests r
    join public.leave_types t on t.leave_type_id = r.leave_type_id
    where r.employee_id = ${actor.employee_id}::uuid
      and lower(r.status::text) = 'approved'
      and t.type_name <> 'Xin nghỉ việc'
      and r.start_date <= ${today}::date`;

  // Count covers every pending request (incl. resignation — it is still an
  // unanswered request); days exclude resignation since it has no leave period.
  const [pending] = await sql!`
    select count(*)::int as total,
           coalesce(sum(r.num_days) filter (where t.type_name <> 'Xin nghỉ việc'), 0)::int as days,
           coalesce(sum(r.num_days) filter (where t.type_name = 'Nghỉ phép'), 0)::int as annual_days
    from public.leave_requests r
    join public.leave_types t on t.leave_type_id = r.leave_type_id
    where r.employee_id = ${actor.employee_id}::uuid
      and lower(r.status::text) = 'pending'`;

  const [upcoming] = await sql!`
    select r.leave_request_id::text as leave_request_id,
           to_char(r.start_date, 'YYYY-MM-DD') as start_date,
           to_char(r.end_date, 'YYYY-MM-DD') as end_date,
           r.num_days::int as num_days,
           case t.type_name
             when 'Nghỉ phép' then 'annual'
             when 'Nghỉ ốm đau' then 'sick'
             when 'Nghỉ thai sản' then 'maternity'
             when 'Xin nghỉ việc' then 'resignation'
             else t.type_name
           end as leave_type,
           t.type_name as leave_type_label
    from public.leave_requests r
    join public.leave_types t on t.leave_type_id = r.leave_type_id
    where r.employee_id = ${actor.employee_id}::uuid
      and lower(r.status::text) = 'approved'
      and r.end_date >= ${today}::date
    order by r.start_date asc
    limit 1`;

  return json({
    ok: true,
    summary: {
      today,
      year,
      annual_granted: Number(quota?.granted ?? 0),
      annual_committed: Number(annual?.committed ?? 0),
      used_days: Number(rest?.used_days ?? 0),
      pending_count: Number(pending?.total ?? 0),
      pending_days: Number(pending?.days ?? 0),
      annual_pending_days: Number(pending?.annual_days ?? 0),
      upcoming: upcoming ?? null,
    },
  });
}

async function leaveCreateAction(actor: Actor, body: Record<string, unknown>): Promise<Response> {
  const typeLabel = str(body.type);
  const startDate = str(body.start_date);
  const endDate = str(body.end_date);
  const reason = str(body.reason);

  const [leaveType] = await sql!`
    select leave_type_id, type_name, fixed_days, max_days_per_year
    from public.leave_types
    where type_name = ${typeLabel}
    limit 1`;
  if (!leaveType) return json({ ok: false, error: "invalid_type" }, 400);
  if (!isRealDate(startDate)) return json({ ok: false, error: "invalid_dates" }, 400);

  const resignation = str(leaveType.type_name) === "Xin nghỉ việc";
  let numDays = 1;
  const effectiveEndDate = resignation ? startDate : endDate;
  if (!resignation) {
    if (!isRealDate(endDate) || endDate < startDate) return json({ ok: false, error: "invalid_dates" }, 400);
    numDays = Math.round(
      (Date.parse(`${endDate}T00:00:00Z`) - Date.parse(`${startDate}T00:00:00Z`)) / 86400000
    ) + 1;
  }
  if (reason === "") return json({ ok: false, error: "missing_reason" }, 400);
  if (leaveType.fixed_days != null && numDays > Number(leaveType.fixed_days)) {
    return json({ ok: false, error: "leave_rule" }, 400);
  }
  // Yearly quota: pending + approved days of the same type in the start-date's
  // year must fit max_days_per_year (null = uncapped, e.g. maternity).
  if (leaveType.max_days_per_year != null) {
    const year = Number(startDate.slice(0, 4));
    const [used] = await sql!`
      select coalesce(sum(num_days), 0)::int as used
      from public.leave_requests
      where employee_id = ${actor.employee_id}::uuid
        and leave_type_id = ${leaveType.leave_type_id}::uuid
        and date_part('year', start_date) = ${year}
        and lower(status::text) in ('pending', 'approved')`;
    if (Number(used.used) + numDays > Number(leaveType.max_days_per_year)) {
      return json({ ok: false, error: "leave_rule" }, 400);
    }
  }

  try {
    await sql!`
      insert into public.leave_requests
        (employee_id, leave_type_id, start_date, end_date, num_days, reason, status, requested_at)
      values
        (${actor.employee_id}::uuid, ${leaveType.leave_type_id}::uuid,
         ${startDate}::date, ${effectiveEndDate}::date, ${numDays},
         ${reason}, 'Pending', now())`;
  } catch (err) {
    return dbError(err);
  }

  return leaveListAction(actor);
}

async function payrollMonthAction(actor: Actor, body: Record<string, unknown>): Promise<Response> {
  const year = Number(body.year);
  const month = Number(body.month);
  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
    return json({ ok: false, error: "invalid_period" }, 400);
  }
  const rows = await sql!`
    select payroll_id, employee_id, pay_month, pay_year, base_salary,
           total_allowance as allowance, total_deduction as total_deductions,
           bonus, gross_salary, net_salary,
           work_days, standard_days, insurance_amount, personal_income_tax,
           payment_status, payment_method
    from public.payroll
    where employee_id = ${actor.employee_id}::uuid
      and pay_year = ${year} and pay_month = ${month}`;
  const payrollRow = rows[0] ?? null;
  // Itemized breakdown (allowance / insurance per component / tax) lives in
  // payroll_details; empty payroll rows mean empty details.
  const details = payrollRow
    ? await sql!`
        select detail_id, item_type, item_name, amount, payer
        from public.payroll_details
        where payroll_id = ${payrollRow.payroll_id}::uuid
        order by item_type, item_name`
    : [];
  return json({ ok: true, payroll: payrollRow, details });
}

// Chấm công: employee self clock-in/out. A day has at most one row
// (unique employee_id + work_date), so the button alternates: first press
// fills check_in_time, second press check_out_time, then refuse. Rows
// already saved by HR (e.g. OnLeave) keep their status; only a fresh
// insert marks 'Present'. Times are stored in Asia/Ho_Chi_Minh.
async function attendanceListAction(actor: Actor): Promise<Response> {
  const [todayRow] = await sql!`
    select (now() at time zone 'Asia/Ho_Chi_Minh')::date::text as today`;
  const rows = await sql!`
    select attendance_id,
           to_char(work_date, 'YYYY-MM-DD') as work_date,
           to_char(check_in_time, 'HH24:MI:SS') as check_in,
           to_char(check_out_time, 'HH24:MI:SS') as check_out,
           status
    from public.attendance_records
    where employee_id = ${actor.employee_id}::uuid
    order by work_date desc
    limit 400`; // month/week pickers span a year+; 400 rows ≈ that history
  return json({ ok: true, today: todayRow.today, records: rows });
}

async function attendanceClockAction(actor: Actor): Promise<Response> {
  const [existing] = await sql!`
    select attendance_id, check_in_time, check_out_time
    from public.attendance_records
    where employee_id = ${actor.employee_id}::uuid
      and work_date = (now() at time zone 'Asia/Ho_Chi_Minh')::date
    limit 1`;
  if (!existing) {
    try {
      await sql!`
        insert into public.attendance_records
          (employee_id, work_date, status, check_in_time)
        values (${actor.employee_id}::uuid,
                (now() at time zone 'Asia/Ho_Chi_Minh')::date, 'Present',
                (now() at time zone 'Asia/Ho_Chi_Minh')::time)`;
    } catch (err) {
      return dbError(err); // rapid double-click loses the unique-constraint race
    }
    return attendanceListAction(actor);
  }
  if (existing.check_in_time == null) {
    await sql!`
      update public.attendance_records
      set check_in_time = (now() at time zone 'Asia/Ho_Chi_Minh')::time
      where attendance_id = ${existing.attendance_id}`;
    return attendanceListAction(actor);
  }
  if (existing.check_out_time == null) {
    await sql!`
      update public.attendance_records
      set check_out_time = (now() at time zone 'Asia/Ho_Chi_Minh')::time
      where attendance_id = ${existing.attendance_id}`;
    return attendanceListAction(actor);
  }
  return json({ ok: false, error: "already_clocked_out" }, 400);
}

async function payrollInfoAction(actor: Actor): Promise<Response> {
  // Own bank/tax record; most employees have no row yet -> info: null.
  const [row] = await sql!`
    select bank_name, bank_account_no, social_insurance_no,
           health_insurance_no, tax_code
    from public.employee_payroll_info
    where employee_id = ${actor.employee_id}::uuid
    limit 1`;
  return json({ ok: true, info: row ?? null });
}

async function payrollInfoSaveAction(actor: Actor, body: Record<string, unknown>): Promise<Response> {
  // Employee keeps their own bank/tax record; pk is employee_id so upsert applies.
  const text = (value: unknown, max: number) => {
    const s = typeof value === "string" ? value.trim() : "";
    return s ? s.slice(0, max) : null;
  };
  const values = {
    bank_name: text(body.bank_name, 100),
    bank_account_no: text(body.bank_account_no, 30),
    // tax/social/health numbers are varchar(20) in the DB.
    tax_code: text(body.tax_code, 20),
    social_insurance_no: text(body.social_insurance_no, 20),
    health_insurance_no: text(body.health_insurance_no, 20)
  };
  if (Object.values(values).every((v) => v === null)) {
    // Every field cleared -> no record to keep.
    await sql!`
      delete from public.employee_payroll_info
      where employee_id = ${actor.employee_id}::uuid`;
    return json({ ok: true, info: null });
  }
  const [row] = await sql!`
    insert into public.employee_payroll_info
      (employee_id, bank_name, bank_account_no, tax_code, social_insurance_no, health_insurance_no)
    values (
      ${actor.employee_id}::uuid,
      ${values.bank_name}, ${values.bank_account_no}, ${values.tax_code},
      ${values.social_insurance_no}, ${values.health_insurance_no})
    on conflict (employee_id) do update
      set bank_name = excluded.bank_name,
          bank_account_no = excluded.bank_account_no,
          tax_code = excluded.tax_code,
          social_insurance_no = excluded.social_insurance_no,
          health_insurance_no = excluded.health_insurance_no
    returning bank_name, bank_account_no, tax_code, social_insurance_no, health_insurance_no`;
  return json({ ok: true, info: row });
}

// Identity fields the employee may self-edit (national_id / id_type /
// nationality). is_disabled and protected_until stay HR-owned and are never
// touched here. national_id is NOT NULL: without an existing row a save
// needs all three fields, otherwise it is skipped (nothing to create).
async function personalInfoSaveAction(actor: Actor, body: Record<string, unknown>): Promise<Response> {
  const idType = str(body.id_type);
  const nationalId = str(body.national_id);
  const nationality = str(body.nationality);
  const marital = str(body.marital_status);

  const result = await sql!.begin(async (tx) => {
    const [existing] = await tx`
      select id_type, national_id, nationality, marital_status
      from public.employee_personal_info
      where employee_id = ${actor.employee_id}::uuid
      limit 1`;

    const finalType = (idType || String(existing?.id_type ?? "")).trim();
    const finalNationalId = (nationalId || String(existing?.national_id ?? "")).trim();
    // nationality is NOT NULL with default 'Vietnam': invent nothing smarter.
    const finalNationality = (nationality || String(existing?.nationality ?? "") || "Vietnam").trim();
    const finalMarital = (marital || String(existing?.marital_status ?? "")).trim();

    if (!nationalId && !idType) {
      if (existing) {
        if (finalMarital) {
          await tx`
            update public.employee_personal_info
            set marital_status = ${finalMarital}
            where employee_id = ${actor.employee_id}::uuid`;
          return { created: false, updated: true };
        }
        return { created: false, updated: false };
      }
      return { created: false, updated: false };
    }

    if (!["CCCD", "CMND", "Passport"].includes(finalType) || !finalNationalId) {
      return null;
    }

    if (existing) {
      if (finalMarital) {
        await tx`
          update public.employee_personal_info
          set id_type = ${finalType}, national_id = ${finalNationalId}, nationality = ${finalNationality}, marital_status = ${finalMarital}
          where employee_id = ${actor.employee_id}::uuid`;
      } else {
        await tx`
          update public.employee_personal_info
          set id_type = ${finalType}, national_id = ${finalNationalId}, nationality = ${finalNationality}
          where employee_id = ${actor.employee_id}::uuid`;
      }
    } else {
      await tx`
        insert into public.employee_personal_info
          (employee_id, id_type, national_id, nationality, marital_status)
        values
          (${actor.employee_id}::uuid, ${finalType}, ${finalNationalId}, ${finalNationality}, ${finalMarital || null})`;
    }
    return { created: !existing, updated: Boolean(existing) };
  });

  if (result === null) return json({ ok: false, error: "invalid_identity" }, 400);
  if (!result.updated && !result.created) return json({ ok: true, personal_info: null });

  const [row] = await sql!`
    select id_type, national_id, nationality, marital_status,
           is_disabled, to_char(protected_until, 'YYYY-MM-DD') as protected_until
    from public.employee_personal_info
    where employee_id = ${actor.employee_id}::uuid
    limit 1`;
  return json({ ok: true, personal_info: row ?? null });
}

// Qualifications and status history are full-replacement saves: delete the
// own rows, then insert what the form holds — own rows only, scoped to the
// session employee.
async function qualificationsSaveAction(actor: Actor, body: Record<string, unknown>): Promise<Response> {
  const rows = Array.isArray(body.rows) ? body.rows : null;
  if (!rows) return json({ ok: false, error: "bad_request" }, 400);

  const mapped = rows.map((raw) => {
    const row = raw as Record<string, unknown>;
    const year = row.graduation_year == null || row.graduation_year === "" ? null : Number(row.graduation_year);
    return {
      qualification_level: str(row.qualification_level).slice(0, 50),
      major_field: str(row.major_field).slice(0, 150),
      institution_name: str(row.institution_name).slice(0, 150),
      graduation_year: year != null && Number.isInteger(year) ? year : null,
    };
  });
  if (mapped.some(
    (row) =>
      (!row.qualification_level && (row.major_field || row.institution_name || row.graduation_year != null)) ||
      (row.graduation_year != null && (row.graduation_year < 1950 || row.graduation_year > 2100)),
  )) return json({ ok: false, error: "invalid_qualification" }, 400);
  const kept = mapped.filter((row) => row.qualification_level);

  await sql!.begin(async (tx) => {
    await tx`delete from public.employee_qualifications where employee_id = ${actor.employee_id}::uuid`;
    for (const row of kept) {
      await tx`
        insert into public.employee_qualifications
          (employee_id, qualification_level, major_field, institution_name, graduation_year)
        values
          (${actor.employee_id}::uuid, ${row.qualification_level}, ${row.major_field},
           ${row.institution_name}, ${row.graduation_year})`;
    }
  });

  const saved = await sql!`
    select qualification_level, major_field, institution_name, graduation_year
    from public.employee_qualifications
    where employee_id = ${actor.employee_id}::uuid
    order by graduation_year desc nulls last`;
  return json({ ok: true, rows: saved });
}

async function statusHistorySaveAction(actor: Actor, _body: Record<string, unknown>): Promise<Response> {
  const saved = await sql!`
    select status, effective_date, end_date, reason
    from (
      select 'OnLeave' as status,
             to_char(start_date, 'YYYY-MM-DD') as effective_date,
             to_char(end_date, 'YYYY-MM-DD') as end_date,
             coalesce(reason, 'Nghỉ phép') as reason
      from public.leave_requests
      where employee_id = ${actor.employee_id}::uuid
        and lower(status::text) = 'approved'
      union
      select 'OnLeave' as status,
             to_char(effective_date, 'YYYY-MM-DD') as effective_date,
             null as end_date,
             reason
      from public.employee_status_history
      where employee_id = ${actor.employee_id}::uuid
        and (status = 'OnLeave' or status = 'Đang nghỉ phép')
    ) s
    order by effective_date desc`;
  return json({ ok: true, rows: saved });
}

async function payrollYearAction(actor: Actor, body: Record<string, unknown>): Promise<Response> {
  const year = Number(body.year);
  if (!Number.isInteger(year)) return json({ ok: false, error: "invalid_period" }, 400);
  const rows = await sql!`
    select payroll_id, employee_id, pay_month, pay_year, base_salary,
           total_allowance as allowance, total_deduction as total_deductions,
           bonus, gross_salary, net_salary,
           work_days, standard_days, insurance_amount, personal_income_tax,
           payment_status, payment_method
    from public.payroll
    where employee_id = ${actor.employee_id}::uuid
      and pay_year = ${year}
    order by pay_month`;
  return json({ ok: true, payroll: rows });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);

  if (!sql || !JWT_KEY) {
    console.error("staff-portal: SUPABASE_DB_URL or ADMIN_JWT_SECRET is not set");
    return json({ ok: false, error: "server_not_configured" }, 500);
  }

  await ensureNoticeColumn();

  const token = req.headers.get("x-admin-token") ?? "";

  let actor: Actor | null;
  try {
    actor = token ? await getActor(token) : null;
  } catch (err) {
    return dbError(err); // database trouble is not a bad token
  }
  if (!actor) {
    let redirectUrl = "staff-login.html";
    let activeRole = "";
    let pendingNotice: unknown = null;
    if (token) {
      try {
        const { payload } = await jwtVerify(token, JWT_KEY!, { algorithms: ["HS256"] });
        const employeeId = typeof payload.employee_id === "string" ? payload.employee_id : "";
        if (UUID_RE.test(employeeId)) {
          const [acc] = await sql!`
            select pending_notice from public.employee_accounts where employee_id = ${employeeId}::uuid limit 1`;
          if (acc?.pending_notice) {
            pendingNotice = parseNotice(acc.pending_notice);
          }
          activeRole = await activePortalRole(employeeId);
          if (activeRole === "Admin") {
            redirectUrl = "../admin/login.html";
          } else if (activeRole === "Manager") {
            redirectUrl = "../manager/login.html";
          }
        }
      } catch {
        // ignore
      }
    }
    return json({ ok: false, error: "unauthorized", role: activeRole, redirect_url: redirectUrl, pending_notice: pendingNotice }, 401);
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: "bad_request" }, 400);
  }

  try {
    switch (body.action) {
      case "ping": return json({ ok: true, pending_notice: actor.pending_notice || null });
      case "clear_notice": {
        await sql!`update public.employee_accounts set pending_notice = null where employee_id = ${actor.employee_id}::uuid`;
        return json({ ok: true });
      }
      case "boot": return await bootAction(actor);
      case "update_profile": return await updateProfileAction(actor, body);
      case "personal_info": return await personalInfoAction(actor);
      case "leave_list": return await leaveListAction(actor);
      case "leave_summary": return await leaveSummaryAction(actor);
      case "leave_create": return await leaveCreateAction(actor, body);
      case "payroll_month": return await payrollMonthAction(actor, body);
      case "payroll_year": return await payrollYearAction(actor, body);
      case "attendance_list": return await attendanceListAction(actor);
      case "attendance_clock": return await attendanceClockAction(actor);
      case "payroll_info": return await payrollInfoAction(actor);
      case "payroll_info_save": return await payrollInfoSaveAction(actor, body);
      case "personal_info_save": return await personalInfoSaveAction(actor, body);
      case "qualifications_save": return await qualificationsSaveAction(actor, body);
      case "status_history_save": return await statusHistorySaveAction(actor, body);
      default: return json({ ok: false, error: "unknown_action" }, 400);
    }
  } catch (err) {
    return dbError(err);
  }
});
