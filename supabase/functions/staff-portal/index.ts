// POST /functions/v1/staff-portal
// Header: x-admin-token (HS256 session token issued by admin-login portal mode).
// Body:   { action, ... }
//   boot:           employee + contact + position/department + roles + permissions in one call
//   update_profile: own full_name, date_of_birth, phone_number, address, marital_status
//   personal_info:  own identity record, qualifications and status history (read only)
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
const sql = SUPABASE_DB_URL
  ? postgres(SUPABASE_DB_URL, { max: 1, prepare: false, ssl: "require" })
  : null;

const JWT_KEY = ADMIN_JWT_SECRET ? new TextEncoder().encode(ADMIN_JWT_SECRET) : null;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

type Actor = { employee_id: string; username: string; full_name: string };

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
    select e.employee_id, a.username, e.full_name
    from public.employees e
    join public.employee_accounts a on a.employee_id = e.employee_id
    where e.employee_id = ${employeeId}::uuid
      and a.is_active is true
      and a.deleted_at is null
      and e.employment_status = 'Active'
    limit 1`;

  return (rows[0] as Actor | undefined) ?? null;
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
           hire_date, employment_status, current_position_id as position_id
    from public.employees
    where employee_id = ${employeeId}::uuid`;
  return rows[0] ?? null;
}

async function ownContact(tx: typeof sql, employeeId: string) {
  const rows = await tx!`
    select employee_id, phone_number, address
    from public.employee_contacts
    where employee_id = ${employeeId}::uuid`;
  return rows[0] ?? null;
}

async function bootAction(actor: Actor): Promise<Response> {
  const [contact, position, roleRows] = await Promise.all([
    ownContact(sql, actor.employee_id),
    sql!`
      select p.position_id, p.position_title, p.department_id, d.department_name
      from public.positions p
      left join public.departments d on d.department_id = p.department_id
      where p.position_id = (select current_position_id from public.employees where employee_id = ${actor.employee_id}::uuid)
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
    position: position ?? null,
    roleNames: roleRows.map((row) => String(row.role_name)),
    permissionCodes: permissionRows.map((row) => String(row.permission_code).toLowerCase()),
  });
}

async function updateProfileAction(actor: Actor, body: Record<string, unknown>): Promise<Response> {
  const fullName = str(body.full_name);
  const phoneNumber = str(body.phone_number);
  const address = str(body.address);
  const dob = str(body.date_of_birth);

  if (!fullName || !isRealDate(dob)) return json({ ok: false, error: "invalid_profile" }, 400);

  await sql!.begin(async (tx) => {
    await tx`
      update public.employees
      set full_name = ${fullName},
          date_of_birth = ${dob}::date,
          updated_at = now()
      where employee_id = ${actor.employee_id}::uuid`;

    const existing = await ownContact(tx, actor.employee_id);
    if (existing) {
      await tx`
        update public.employee_contacts
        set phone_number = ${phoneNumber},
            address = ${address}
        where employee_id = ${actor.employee_id}::uuid`;
    } else {
      await tx`
        insert into public.employee_contacts (employee_id, phone_number, address)
        values (${actor.employee_id}::uuid, ${phoneNumber}, ${address})`;
    }
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

  return json({ ok: true, employee, contact: contact ?? null });
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
    select status, to_char(effective_date, 'YYYY-MM-DD') as effective_date, reason
    from public.employee_status_history
    where employee_id = ${actor.employee_id}::uuid
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
           r.reason, r.status, r.requested_at, r.decided_at, r.medical_ref,
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
    await sql`
      insert into public.leave_requests
        (employee_id, leave_type_id, start_date, end_date, num_days, reason, status, requested_at)
      values
        (${actor.employee_id}::uuid, ${leaveType.leave_type_id}::uuid,
         ${startDate}::date, ${resignation ? null : endDate}::date, ${numDays},
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
           bonus, overtime_pay, night_pay, gross_salary, net_salary,
           work_days, standard_days, insurance_amount, personal_income_tax,
           payment_date, payment_status, payment_method
    from public.payroll
    where employee_id = ${actor.employee_id}::uuid
      and pay_year = ${year} and pay_month = ${month}`;
  const payrollRow = rows[0] ?? null;
  // Itemized breakdown (allowance / insurance per component / tax) lives in
  // payroll_details; empty payroll rows mean empty details.
  const details = payrollRow
    ? await sql!`
        select detail_id, item_type, item_name, amount, payer, quantity, rate_multiplier
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
    limit 30`;
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
    // overtime_hours/night_hours default to 0, satisfying the check constraints.
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
    tax_code: text(body.tax_code, 30),
    social_insurance_no: text(body.social_insurance_no, 30),
    health_insurance_no: text(body.health_insurance_no, 30)
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

async function payrollYearAction(actor: Actor, body: Record<string, unknown>): Promise<Response> {
  const year = Number(body.year);
  if (!Number.isInteger(year)) return json({ ok: false, error: "invalid_period" }, 400);
  const rows = await sql!`
    select payroll_id, employee_id, pay_month, pay_year, base_salary,
           total_allowance as allowance, total_deduction as total_deductions,
           bonus, overtime_pay, night_pay, gross_salary, net_salary,
           work_days, standard_days, insurance_amount, personal_income_tax,
           payment_date, payment_status, payment_method
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
      default: return json({ ok: false, error: "unknown_action" }, 400);
    }
  } catch (err) {
    return dbError(err);
  }
});
