// POST /functions/v1/leader-portal
// Header: x-admin-token (HS256 session token issued by admin-login leader portal mode).
// Body:   { action, ... }
//   ping:                      ultra-lightweight token & pending_notice check
//   clear_notice:              dismiss the pending modal notice
//   boot / leader_boot:        fetch team employees, attendance sheet, and leave requests
//   attendance_list:           fetch leader's own clock-in/out records
//   attendance_clock:          in/out punch for leader themselves
//   attendance_bulk:           save team attendance sheet codes
//   leave_review:              approve/reject team member leave request
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

const sql = SUPABASE_DB_URL
  ? postgres(SUPABASE_DB_URL, {
      max: 3,
      idle_timeout: 20,
      connect_timeout: 10,
      prepare: false,
      ssl: "require",
    })
  : (null as unknown as postgres.Sql);

const JWT_KEY = ADMIN_JWT_SECRET
  ? new TextEncoder().encode(ADMIN_JWT_SECRET)
  : null;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

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
const MANAGER_ROLES = ["manager", "hr_manager", "quản lý", "quản lý nhân sự"];
const MANAGER_PERMISSIONS = [
  "manager",
  "hr_manager",
  "manage_staff",
  "manage_employees",
];

const DAY_CODE_STATUS: Record<string, { status: string }> = {
  X: { status: "Present" },
  CT: { status: "Present" },
  P: { status: "OnLeave" },
  L: { status: "OnLeave" },
  O: { status: "Absent" },
  KP: { status: "Absent" },
};

type LeaderActor = {
  employee_id: string;
  full_name: string;
  email: string;
  department_id: string | null;
  pending_notice?: unknown;
};

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
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
  const anyErr = err as Record<string, unknown>;
  const constraint = (anyErr?.constraint_name || anyErr?.constraint || "") as string;
  const message = (err as Error)?.message || String(err);
  const detail = (anyErr?.detail || "") as string;

  console.error("leader-portal: database error:", { code, message, detail, constraint, err });

  if (code === "forbidden") return json({ ok: false, error: "forbidden", message }, 403);
  if (DB_ERRORS[code]) {
    return json(
      {
        ok: false,
        error: DB_ERRORS[code],
        code,
        message,
        detail,
        constraint,
      },
      400,
    );
  }
  return json(
    {
      ok: false,
      error: "server_error",
      code,
      message,
      detail,
      constraint,
    },
    500,
  );
}

async function getLeaderActor(token: string): Promise<LeaderActor | null> {
  let employeeId = "";
  try {
    const { payload } = await jwtVerify(token, JWT_KEY!, {
      algorithms: ["HS256"],
    });
    employeeId =
      typeof payload.employee_id === "string" ? payload.employee_id : "";
  } catch {
    return null;
  }
  if (!UUID_RE.test(employeeId)) return null;

  let rows;
  try {
    rows = await sql!`
      select e.employee_id, e.full_name, e.email,
             coalesce(e.current_department_id, position_department.department_id) as current_department_id,
             a.pending_notice
      from public.employees e
      join public.employee_accounts a on a.employee_id = e.employee_id
      left join lateral (
        select (array_agg(distinct dp.department_id))[1] as department_id
        from public.department_positions dp
        where dp.position_id = e.current_position_id
        having count(distinct dp.department_id) = 1
      ) position_department on true
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
               null as pending_notice
        from public.employees e
        join public.employee_accounts a on a.employee_id = e.employee_id
        left join lateral (
          select (array_agg(distinct dp.department_id))[1] as department_id
          from public.department_positions dp
          where dp.position_id = e.current_position_id
          having count(distinct dp.department_id) = 1
        ) position_department on true
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
        pending_notice?: unknown;
      };
  if (!row) return null;

  const [roleCheck] = await sql!`
    select true as has_access
    where exists (
      select 1 from public.user_roles ur
      join public.roles r on r.role_id = ur.role_id
      where ur.employee_id = ${row.employee_id}::uuid
        and (
          r.role_name = 'Admin'
          or lower(r.role_name) = any(${sql.array(MANAGER_ROLES)})
          or lower(r.role_name) = any(${sql.array(LEADER_ROLES)})
        )
        and (ur.valid_from is null or ur.valid_from <= (now() at time zone 'Asia/Ho_Chi_Minh')::date)
        and (ur.valid_to is null or ur.valid_to >= (now() at time zone 'Asia/Ho_Chi_Minh')::date)
    ) or exists (
      select 1 from public.user_roles ur
      join public.role_permissions rp on rp.role_id = ur.role_id
      join public.permissions p on p.permission_id = rp.permission_id
      where ur.employee_id = ${row.employee_id}::uuid
        and (
          lower(p.permission_code) = any(${sql.array(MANAGER_PERMISSIONS)})
          or lower(p.permission_code) = any(${sql.array(LEADER_PERMISSIONS)})
        )
        and (ur.valid_from is null or ur.valid_from <= (now() at time zone 'Asia/Ho_Chi_Minh')::date)
        and (ur.valid_to is null or ur.valid_to >= (now() at time zone 'Asia/Ho_Chi_Minh')::date)
    )`;

  if (!roleCheck) {
    if (row.pending_notice) {
      return {
        employee_id: row.employee_id,
        full_name: row.full_name,
        email: row.email,
        department_id: row.current_department_id ?? null,
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
    pending_notice: parseNotice(row.pending_notice),
  };
}

async function scopedEmployeeIds(actor: LeaderActor): Promise<string[]> {
  if (!actor.department_id || !UUID_RE.test(actor.department_id)) {
    return [];
  }
  const rows = await sql!`
    select e.employee_id
    from public.employees e
    left join lateral (
      select (array_agg(distinct dp.department_id))[1] as department_id
      from public.department_positions dp
      where dp.position_id = e.current_position_id
      having count(distinct dp.department_id) = 1
    ) position_department on true
    where e.employment_status = 'Active'
      and (
        e.employee_id = ${actor.employee_id}::uuid
        or (
          exists (
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
      )`;
  return rows.map((r) => String(r.employee_id));
}

async function leaderBootAction(
  actor: LeaderActor,
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

  const ids = await scopedEmployeeIds(actor);

  if (!ids.length) {
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

  let teamEmployees: readonly unknown[] = [];
  try {
    teamEmployees = await sql!`
      select e.employee_id, e.employee_code, e.full_name, e.email,
             e.employment_status, e.current_position_id as position_id,
             coalesce(e.current_department_id, position_department.department_id) as department_id,
             d.department_name,
             p.position_title,
             coalesce(
               (select array_agg(r.role_name)
                from public.user_roles er
                join public.roles r on r.role_id = er.role_id
                where er.employee_id = e.employee_id),
               array[]::text[]
             ) as role_names
      from public.employees e
      left join lateral (
        select (array_agg(distinct dp.department_id))[1] as department_id
        from public.department_positions dp
        where dp.position_id = e.current_position_id
        having count(distinct dp.department_id) = 1
      ) position_department on true
      left join public.departments d on d.department_id = coalesce(e.current_department_id, position_department.department_id)
      left join public.positions p on p.position_id = e.current_position_id
      left join public.employee_accounts a on a.employee_id = e.employee_id
      where e.employee_id = any(${sql.array(ids)}::uuid[])
        and (e.employee_id = ${actor.employee_id}::uuid or (a.deleted_at is null and a.is_active is true))
        and e.employment_status = 'Active'
      order by (case when e.employee_id = ${actor.employee_id}::uuid then 0 else 1 end), e.full_name`;
  } catch (err) {
    console.warn("leader-portal: teamEmployees query fallback", err);
    teamEmployees = await sql!`
      select e.employee_id, e.employee_code, e.full_name, e.email,
             e.employment_status, e.current_position_id as position_id,
             e.current_department_id as department_id,
             d.department_name,
             '' as position_title
      from public.employees e
      left join public.departments d on d.department_id = e.current_department_id
      where e.employee_id = any(${sql.array(ids)}::uuid[])
      order by (case when e.employee_id = ${actor.employee_id}::uuid then 0 else 1 end), e.full_name`;
  }

  let attendanceRows: Record<string, unknown>[] = [];
  try {
    attendanceRows = (await sql!`
      select ar.attendance_id, ar.employee_id,
             lower(ar.status::text) as status, ar.day_code,
             to_char(ar.work_date, 'YYYY-MM-DD') as work_date,
             to_char(ar.check_in_time, 'HH24:MI:SS') as check_in_time,
             to_char(ar.check_out_time, 'HH24:MI:SS') as check_out_time,
             0 as overtime_hours,
             null as notes
      from public.attendance_records ar
      where ar.employee_id = any(${sql.array(ids)}::uuid[])
        and ar.work_date >= ${`${month}-01`}::date
        and ar.work_date < (${`${month}-01`}::date + interval '1 month')
      order by ar.work_date desc, ar.employee_id`) as Record<string, unknown>[];
  } catch (err) {
    const code = (err as { code?: string })?.code ?? "";
    if (code === "42703") {
      try {
        attendanceRows = (await sql!`
          select ar.attendance_id, ar.employee_id,
                 lower(ar.status::text) as status, null as day_code,
                 to_char(ar.work_date, 'YYYY-MM-DD') as work_date,
                 to_char(ar.check_in_time, 'HH24:MI:SS') as check_in_time,
                 to_char(ar.check_out_time, 'HH24:MI:SS') as check_out_time,
                 0 as overtime_hours,
                 null as notes
          from public.attendance_records ar
          where ar.employee_id = any(${sql.array(ids)}::uuid[])
            and ar.work_date >= ${`${month}-01`}::date
            and ar.work_date < (${`${month}-01`}::date + interval '1 month')
          order by ar.work_date desc, ar.employee_id`) as Record<string, unknown>[];
      } catch (err2) {
        console.error("leader-portal: attendance fallback failed", err2);
        attendanceRows = [];
      }
    } else {
      console.error("leader-portal: attendanceRows query failed", err);
      attendanceRows = [];
    }
  }

  let leaveRows: readonly unknown[] = [];
  try {
    leaveRows = await sql!`
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
      where lr.employee_id = any(${sql.array(ids)}::uuid[]) and lr.employee_id <> ${actor.employee_id}::uuid
      order by lr.requested_at desc nulls last, lr.start_date desc`;
  } catch (err) {
    const code = (err as { code?: string })?.code ?? "";
    if (code === "42703") {
      try {
        leaveRows = await sql!`
          select lr.leave_request_id, lr.employee_id, e.full_name, e.employee_code,
                 to_char(lr.start_date, 'YYYY-MM-DD') as start_date,
                 to_char(lr.end_date, 'YYYY-MM-DD') as end_date,
                 lr.reason,
                 lower(lr.status::text) as status, null as leader_status,
                 null as leader_reviewed_at,
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
          order by lr.start_date desc`;
      } catch (err2) {
        console.error("leader-portal: leave fallback failed", err2);
        leaveRows = [];
      }
    } else {
      console.error("leader-portal: leaveRows query failed", err);
      leaveRows = [];
    }
  }

  for (const row of attendanceRows) {
    row.work_date = String(row.work_date || "").slice(0, 10);
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

async function leaderAttendanceListAction(
  actor: LeaderActor,
): Promise<Response> {
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
  actor: LeaderActor,
  body: Record<string, unknown>,
): Promise<Response> {
  const phase = str(body.phase).toLowerCase();
  if (phase !== "in" && phase !== "out") {
    return json({ ok: false, error: "invalid_phase" }, 400);
  }

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
            (employee_id, work_date, check_in_time, status)
          values
            (${actor.employee_id}::uuid,
             (now() at time zone 'Asia/Ho_Chi_Minh')::date,
             (now() at time zone 'Asia/Ho_Chi_Minh')::time,
             'Present')`;
        return;
      }

      if (phase === "in") {
        if (existing.check_in_time != null && existing.check_out_time == null) {
          clockError = "already_in";
          return;
        }
        await tx`
          update public.attendance_records
          set check_in_time = (now() at time zone 'Asia/Ho_Chi_Minh')::time,
              check_out_time = null,
              status = 'Present'
          where attendance_id = ${existing.attendance_id}`;
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

async function leaderLeaveReviewAction(
  actor: LeaderActor,
  body: Record<string, unknown>,
): Promise<Response> {
  const requestId = str(body.leave_request_id);
  const statusInput = str(body.status).toLowerCase();
  if (!UUID_RE.test(requestId)) {
    return json({ ok: false, error: "invalid_request" }, 400);
  }
  if (!["approved", "rejected"].includes(statusInput)) {
    return json({ ok: false, error: "invalid_status" }, 400);
  }

  try {
    let leaveRow: {
      leave_request_id: string;
      employee_id: string;
      status: string;
      leader_status: string | null;
    } | null = null;

    try {
      const rows = await sql!`
        select lr.leave_request_id, lr.employee_id, lower(lr.status::text) as status, lr.leader_status
        from public.leave_requests lr
        where lr.leave_request_id = ${requestId}::uuid
        limit 1`;
      leaveRow = (rows[0] as typeof leaveRow) || null;
    } catch (err) {
      const code = (err as { code?: string })?.code ?? "";
      if (code === "42703") {
        const rows = await sql!`
          select lr.leave_request_id, lr.employee_id, lower(lr.status::text) as status, null as leader_status
          from public.leave_requests lr
          where lr.leave_request_id = ${requestId}::uuid
          limit 1`;
        leaveRow = (rows[0] as typeof leaveRow) || null;
      } else {
        throw err;
      }
    }

    if (!leaveRow) {
      return json({ ok: false, error: "not_found" }, 404);
    }

    if (String(leaveRow.employee_id) === actor.employee_id) {
      return json({ ok: false, error: "forbidden" }, 403);
    }

    const scopedIds = await scopedEmployeeIds(actor);
    if (!scopedIds.includes(String(leaveRow.employee_id))) {
      return json({ ok: false, error: "forbidden" }, 403);
    }

    if (leaveRow.status !== "pending" || leaveRow.leader_status != null) {
      return json({ ok: false, error: "already_decided" }, 400);
    }

    if (statusInput === "approved") {
      try {
        await sql!`
          update public.leave_requests
          set leader_status = 'approved',
              leader_reviewed_by = ${actor.employee_id}::uuid,
              leader_reviewed_at = now()
          where leave_request_id = ${requestId}::uuid`;
      } catch (appErr) {
        const code = (appErr as { code?: string })?.code ?? "";
        if (code === "23514") {
          // If check constraint requires 'Approved'
          await sql!`
            update public.leave_requests
            set leader_status = 'Approved',
                leader_reviewed_by = ${actor.employee_id}::uuid,
                leader_reviewed_at = now()
            where leave_request_id = ${requestId}::uuid`;
        } else {
          throw appErr;
        }
      }
    } else {
      try {
        await sql!`
          update public.leave_requests
          set leader_status = 'rejected',
              leader_reviewed_by = ${actor.employee_id}::uuid,
              leader_reviewed_at = now(),
              status = 'Rejected',
              decided_at = now()
          where leave_request_id = ${requestId}::uuid`;
      } catch (rejectErr) {
        const code = (rejectErr as { code?: string })?.code ?? "";
        if (code === "23514") {
          await sql!`
            update public.leave_requests
            set leader_status = 'Rejected',
                leader_reviewed_by = ${actor.employee_id}::uuid,
                leader_reviewed_at = now(),
                status = 'Rejected',
                decided_at = now()
            where leave_request_id = ${requestId}::uuid`;
        } else if (code === "42703") {
          await sql!`
            update public.leave_requests
            set leader_status = 'rejected',
                leader_reviewed_by = ${actor.employee_id}::uuid,
                leader_reviewed_at = now(),
                status = 'Rejected'
            where leave_request_id = ${requestId}::uuid`;
        } else {
          throw rejectErr;
        }
      }
    }
  } catch (err) {
    const anyErr = err as Record<string, unknown>;
    const constraintName = (anyErr?.constraint_name || anyErr?.constraint || "") as string;
    const message = (err as Error)?.message || String(err);
    console.error("leader-portal: leave review update error:", { constraintName, message, err });
    return json({
      ok: false,
      error: DB_ERRORS[anyErr?.code as string] || "rule_violation",
      code: anyErr?.code,
      message,
      constraint: constraintName,
      detail: anyErr?.detail,
    }, 400);
  }

  return json({ ok: true });
}

async function leaderAttendanceBulkSaveAction(
  actor: LeaderActor,
  body: Record<string, unknown>,
): Promise<Response> {
  const ym = str(body.ym);
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(ym)) {
    return json({ ok: false, error: "invalid_period" }, 400);
  }
  const items = Array.isArray(body.items) ? body.items : [];
  if (!items.length) return json({ ok: true, count: 0 });

  const scoped = new Set(await scopedEmployeeIds(actor));
  type CleanItem = {
    employee_id: string;
    work_date: string;
    day_code: string;
    status: string;
  };
  const clean: CleanItem[] = [];

  for (const raw of items) {
    if (!raw || typeof raw !== "object") continue;
    const employeeId = str((raw as Record<string, unknown>).employee_id);
    const workDate = str((raw as Record<string, unknown>).work_date);
    const dayCode = str((raw as Record<string, unknown>).day_code).toUpperCase();
    if (!UUID_RE.test(employeeId) || !DATE_RE.test(workDate)) continue;
    if (!workDate.startsWith(ym)) continue;
    if (!scoped.has(employeeId)) {
      return json({ ok: false, error: "forbidden" }, 403);
    }
    const mapped = DAY_CODE_STATUS[dayCode] ?? { status: "Absent" };
    clean.push({
      employee_id: employeeId,
      work_date: workDate,
      day_code: dayCode,
      status: mapped.status,
    });
  }

  if (!clean.length) return json({ ok: true, count: 0 });

  // Trưởng nhóm chỉ được phép chấm công cho nhân viên và bản thân, không được chấm công cho các trưởng nhóm khác hoặc quản lý
  const otherEmployeeIds = [...new Set(clean.map((it) => it.employee_id))].filter(
    (id) => id !== actor.employee_id
  );
  if (otherEmployeeIds.length > 0) {
    const forbiddenRows = await sql!`
      select e.employee_id
      from public.employees e
      where e.employee_id = any(${sql.array(otherEmployeeIds)}::uuid[])
        and exists (
          select 1 from public.user_roles er
          join public.roles r on r.role_id = er.role_id
          where er.employee_id = e.employee_id
            and (
              lower(r.role_name) like '%trưởng nhóm%'
              or lower(r.role_name) like '%truong nhom%'
              or lower(r.role_name) like '%leader%'
              or lower(r.role_name) like '%quản lý%'
              or lower(r.role_name) like '%quan ly%'
              or lower(r.role_name) like '%manager%'
              or lower(r.role_name) like '%admin%'
            )
        )
      limit 1`;
    if (forbiddenRows.length > 0) {
      return json({
        ok: false,
        error: "forbidden",
        message: "Trưởng nhóm chỉ được phép sửa chấm công cho nhân viên và bản thân, không được sửa chấm công cho trưởng nhóm khác."
      }, 403);
    }
  }

  try {
    await sql!.begin(async (tx) => {
      for (const item of clean) {
        if (!item.day_code) {
          await tx`
            delete from public.attendance_records
            where employee_id = ${item.employee_id}::uuid
              and work_date = ${item.work_date}::date`;
          continue;
        }

        const existing = await tx`
          select attendance_id from public.attendance_records
          where employee_id = ${item.employee_id}::uuid
            and work_date = ${item.work_date}::date
          limit 1`;

        if (existing.length > 0) {
          await tx`
            update public.attendance_records
            set day_code = ${item.day_code},
                status = ${item.status},
                check_in_time = case
                  when ${item.day_code} = 'X' then coalesce(check_in_time, '07:00:00'::time)
                  else check_in_time
                end,
                check_out_time = case
                  when ${item.day_code} = 'X' then coalesce(check_out_time, '17:00:00'::time)
                  else check_out_time
                end
            where attendance_id = ${existing[0].attendance_id}`;
        } else {
          await tx`
            insert into public.attendance_records
              (employee_id, work_date, status, day_code, check_in_time, check_out_time)
            values
              (${item.employee_id}::uuid, ${item.work_date}::date,
               ${item.status}, ${item.day_code},
               case when ${item.day_code} = 'X' then '07:00:00'::time else null end,
               case when ${item.day_code} = 'X' then '17:00:00'::time else null end)`;
        }
      }
    });
  } catch (err) {
    return dbError(err);
  }

  return json({ ok: true, count: clean.length });
}

let leaderSchemaChecked = false;
async function ensureLeaderSchema() {
  if (leaderSchemaChecked) return;
  try {
    await sql!`alter table public.employee_accounts add column if not exists pending_notice jsonb`;
  } catch (_) {}
  try {
    await sql!`alter publication supabase_realtime add table public.attendance_records`;
  } catch (_) {}
  try {
    await sql!`
      alter table public.leave_requests
        add column if not exists leader_status text,
        add column if not exists leader_reviewed_by uuid references public.employees(employee_id) on delete set null,
        add column if not exists leader_reviewed_at timestamptz,
        add column if not exists decided_at timestamptz`;
  } catch (_) {}
  try {
    await sql!`
      alter table public.leave_requests
        drop constraint if exists leave_requests_leader_status_check`;
    await sql!`
      alter table public.leave_requests
        add constraint leave_requests_leader_status_check
        check (leader_status is null or lower(leader_status) in ('approved', 'rejected'))`;
  } catch (err) {
    console.warn("leader-portal: recreate leave_requests_leader_status_check failed", err);
  }
  leaderSchemaChecked = true;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  if (req.method !== "POST") {
    return json({ ok: false, error: "method_not_allowed" }, 405);
  }
  if (!sql || !JWT_KEY) {
    console.error("leader-portal: SUPABASE_DB_URL or ADMIN_JWT_SECRET is not set");
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
      const { payload } = await jwtVerify(token, JWT_KEY, { algorithms: ["HS256"] });
      const employeeId = typeof payload.employee_id === "string" ? payload.employee_id : "";
      if (!UUID_RE.test(employeeId)) return json({ ok: false, error: "unauthorized" }, 401);
      const [acc] = await sql`
        select is_active, deleted_at, pending_notice
        from public.employee_accounts
        where employee_id = ${employeeId}::uuid
        limit 1`;
      if (!acc || acc.deleted_at || !acc.is_active) {
        return json({ ok: false, error: "unauthorized", pending_notice: parseNotice(acc?.pending_notice) }, 401);
      }
      return json({ ok: true, pending_notice: parseNotice(acc.pending_notice) });
    } catch {
      return json({ ok: false, error: "unauthorized" }, 401);
    }
  }

  await ensureLeaderSchema();

  let actor: LeaderActor | null;
  try {
    actor = token ? await getLeaderActor(token) : null;
  } catch (err) {
    return dbError(err);
  }

  if (!actor) {
    let pendingNotice: unknown = null;
    if (token) {
      try {
        const { payload } = await jwtVerify(token, JWT_KEY, { algorithms: ["HS256"] });
        const employeeId = typeof payload.employee_id === "string" ? payload.employee_id : "";
        if (UUID_RE.test(employeeId)) {
          const [acc] = await sql`
            select pending_notice from public.employee_accounts where employee_id = ${employeeId}::uuid limit 1`;
          if (acc?.pending_notice) pendingNotice = parseNotice(acc.pending_notice);
        }
      } catch {
        // ignore
      }
    }
    return json({ ok: false, error: "unauthorized", redirect_url: "../leader/login.html", pending_notice: pendingNotice }, 401);
  }

  try {
    switch (action) {
      case "clear_notice": {
        await sql`update public.employee_accounts set pending_notice = null where employee_id = ${actor.employee_id}::uuid`;
        return json({ ok: true });
      }
      case "boot":
      case "leader_boot":
        return await leaderBootAction(actor, body);
      case "attendance_list":
      case "leader_attendance_list":
        return await leaderAttendanceListAction(actor);
      case "attendance_clock":
      case "leader_attendance_clock":
        return await leaderAttendanceClockAction(actor, body);
      case "attendance_bulk":
      case "leader_attendance_bulk":
        return await leaderAttendanceBulkSaveAction(actor, body);
      case "leave_review":
      case "leader_leave_review":
        return await leaderLeaveReviewAction(actor, body);
      default:
        return json({ ok: false, error: "unknown_action" }, 400);
    }
  } catch (err) {
    return dbError(err);
  }
});
