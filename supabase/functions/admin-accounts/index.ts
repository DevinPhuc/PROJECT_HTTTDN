// POST /functions/v1/admin-accounts
// Header: x-admin-token (HS256 session token issued by admin-login).
// Body:   { action, ... }
//   boot:      init (accounts + staff + roles + permissions in one call)
//   accounts:  options | list | staff | create | update | set_active | delete | restore
//   roles:     roles | permissions | create_role | update_role | assign_role
// All HRM data access lives here; the browser never touches the tables directly.
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
  ? postgres(SUPABASE_DB_URL, { max: 1, prepare: false, ssl: "require" })
  : null;

const JWT_KEY = ADMIN_JWT_SECRET
  ? new TextEncoder().encode(ADMIN_JWT_SECRET)
  : null;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Vietnam calendar date (YYYY-MM-DD), shared by every date-sensitive query.
// Computed in JS on purpose: a module-level query would start an unhandled
// database round-trip during boot and can wedge the isolate on a cold start.
const VN_TODAY = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Ho_Chi_Minh",
}).format(new Date());

type Actor = { employee_id: string; username: string; full_name: string };

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function isRealDate(value: string): boolean {
  if (!DATE_RE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return (
    !Number.isNaN(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value
  );
}

function readProfile(body: Record<string, unknown>) {
  const fields = {
    employee_code: str(body.employee_code),
    full_name: str(body.full_name),
    email: str(body.email).toLowerCase(),
    phone_number: str(body.phone_number).trim(),
    gender: str(body.gender),
    date_of_birth: str(body.date_of_birth),
    hire_date: str(body.hire_date),
    department_id: str(body.department_id),
    position_id: str(body.position_id),
  };

  if (
    !fields.employee_code ||
    !fields.full_name ||
    !fields.email ||
    !fields.gender ||
    !fields.date_of_birth ||
    !fields.hire_date ||
    !fields.department_id
  )
    return { error: "missing_fields" } as const;

  if (!EMAIL_RE.test(fields.email)) return { error: "invalid_email" } as const;
  if (fields.phone_number && !/^\d{10}$/.test(fields.phone_number)) {
    return { error: "invalid_phone" } as const;
  }
  if (!isRealDate(fields.date_of_birth))
    return { error: "invalid_date_of_birth" } as const;
  if (!isRealDate(fields.hire_date))
    return { error: "invalid_hire_date" } as const;
  if (!UUID_RE.test(fields.department_id)) {
    return { error: "invalid_reference" } as const;
  }
  if (fields.position_id && !UUID_RE.test(fields.position_id)) {
    return { error: "invalid_reference" } as const;
  }

  // Mirrors ck_employees_min_working_age: hire_date >= date_of_birth + 15 years.
  const dob = new Date(`${fields.date_of_birth}T00:00:00Z`);
  const earliest = Date.UTC(
    dob.getUTCFullYear() + 15,
    dob.getUTCMonth(),
    dob.getUTCDate(),
  );
  if (new Date(`${fields.hire_date}T00:00:00Z`).getTime() < earliest) {
    return { error: "under_min_age" } as const;
  }

  return { fields } as const;
}

// Returns department details and position name plus reference validity.
async function loadDepartmentAndRefs(departmentId: string, positionId: string) {
  if (!positionId) {
    const rows = await sql!`
      select d.department_name, d.description, null as position_title, true as position_ok
      from public.departments d
      where d.department_id = ${departmentId}::uuid`;
    return rows[0] ?? null;
  }
  const rows = await sql!`
    select d.department_name, d.description, p.position_title,
           exists(
             select 1 from public.department_positions dp
             where dp.position_id = ${positionId}::uuid and dp.department_id = ${departmentId}::uuid
           ) as position_ok
    from public.departments d
    left join public.positions p on p.position_id = ${positionId}::uuid
    where d.department_id = ${departmentId}::uuid`;
  return rows[0] ?? null;
}

async function resolveProfile(body: Record<string, unknown>) {
  const parsed = readProfile(body);
  if ("error" in parsed) return { error: parsed.error } as const;

  const ref = await loadDepartmentAndRefs(
    parsed.fields.department_id,
    parsed.fields.position_id,
  );
  if (!ref) return { error: "unknown_department" } as const;
  if (!ref.position_ok)
    return { error: "position_department_mismatch" } as const;

  return {
    fields: parsed.fields,
    departmentName: String(ref.department_name),
    departmentDescription: String(ref.description || ""),
    positionName: String(ref.position_title || ""),
  } as const;
}

function abbreviatePosition(positionName: string) {
  const role = positionName.trim().toLowerCase();
  if (role === "admin") return "AD";
  if (role === "nhân viên") return "NV";
  if (role === "quản lý") return "QL";
  if (role === "trưởng nhóm") return "TN";

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
  roleName: string,
  departmentDescription: string,
  dateOfBirth: string,
): string {
  const positionPrefix = abbreviatePosition(roleName);
  const departmentPrefix = departmentDescription
    .trim()
    .slice(0, 3)
    .toLowerCase();
  const [year, month, day] = dateOfBirth.split("-");
  return `${positionPrefix}${departmentPrefix}@${day}${month}${year}`;
}

let noticeColumnChecked = false;
async function ensureNoticeColumn() {
  if (noticeColumnChecked) return;
  try {
    await sql!`alter table public.employee_accounts add column if not exists pending_notice jsonb`;
    noticeColumnChecked = true;
  } catch (err) {
    console.error("ensureNoticeColumn failed", err);
  }
}

function getLoginUrlForRole(roleName: string): string {
  const norm = (roleName || "").trim().toLowerCase();
  if (norm === "admin") return "../admin/login.html";
  if (["manager", "hr_manager", "quản lý", "quản lý nhân sự"].includes(norm)) {
    return "../manager/login.html";
  }
  return "../staff/staff-login.html";
}

async function updateAccountPassword(
  tx: postgres.TransactionSql,
  employeeId: string,
  roleId: string,
  passwordOverride = "",
): Promise<string> {
  const [details] = await tx`
    select r.role_name,
           coalesce(d.description, '') as department_description,
           to_char(e.date_of_birth, 'YYYY-MM-DD') as date_of_birth
    from public.employees e
    left join public.departments d on d.department_id = e.current_department_id
    join public.roles r on r.role_id = ${roleId}::uuid
    where e.employee_id = ${employeeId}::uuid
    limit 1`;
  if (!details) return "";

  const generatedPassword = generateAccountPassword(
    String(details.role_name || ""),
    String(details.department_description || ""),
    String(details.date_of_birth || ""),
  );
  const password = passwordOverride || generatedPassword;
  await tx`
    update public.employee_accounts
    set password_hash = extensions.crypt(${password}, extensions.gen_salt('bf', 10))
    where employee_id = ${employeeId}::uuid`;
  return password;
}

// A missing role falls back to the default "Nhân viên" role.
async function resolveRoleId(value: unknown): Promise<string | null> {
  const roleId = str(value);
  const rows = UUID_RE.test(roleId)
    ? await sql!`select role_id from public.roles where role_id = ${roleId}::uuid limit 1`
    : await sql!`select role_id from public.roles where role_name = 'Nhân viên' limit 1`;
  return rows.length ? String(rows[0].role_id) : null;
}

// Shared by account updates and the assign_role action: the active user_roles row is
// corrected in place when it started today, otherwise closed and replaced.
async function setActiveRole(
  tx: postgres.TransactionSql,
  employeeId: string,
  roleId: string,
  actor: Actor,
): Promise<void> {
  const [current] = await tx`
    select ur.user_role_id, ur.role_id
    from public.user_roles ur
    where ur.employee_id = ${employeeId}::uuid
      and ur.valid_from <= ${VN_TODAY}::date
      and (ur.valid_to is null or ur.valid_to >= ${VN_TODAY}::date)
    order by ur.valid_from desc, ur.user_role_id desc
    limit 1`;

  if (current && String(current.role_id) === roleId) return;

  if (!current) {
    await tx`
      insert into public.user_roles (employee_id, role_id, valid_from, assigned_by, reason)
      values (${employeeId}::uuid, ${roleId}::uuid, ${VN_TODAY}::date,
              ${actor.employee_id}::uuid, 'Role assigned from admin dashboard')`;
    return;
  }

  const swapped = await tx`
    update public.user_roles
    set role_id = ${roleId}::uuid
    where user_role_id = ${current.user_role_id}::uuid
      and valid_from >= ${VN_TODAY}::date
    returning user_role_id`;

  if (swapped.length === 0) {
    await tx`
      update public.user_roles
      set valid_to = ${VN_TODAY}::date - 1
      where user_role_id = ${current.user_role_id}::uuid`;
    await tx`
      insert into public.user_roles (employee_id, role_id, valid_from, assigned_by, reason)
      values (${employeeId}::uuid, ${roleId}::uuid, ${VN_TODAY}::date,
              ${actor.employee_id}::uuid, 'Role changed from admin dashboard')`;
  }
}

function readPermissionIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const ids = value.filter(
    (item): item is string => typeof item === "string" && UUID_RE.test(item),
  );
  return [...new Set(ids)];
}

async function replaceRolePermissions(
  tx: postgres.TransactionSql,
  roleId: string,
  permissionIds: string[],
): Promise<void> {
  await tx`delete from public.role_permissions where role_id = ${roleId}::uuid`;
  if (permissionIds.length === 0) return;
  await tx`
    insert into public.role_permissions (role_id, permission_id)
    select ${roleId}::uuid, p.permission_id
    from public.permissions p
    where p.permission_id = any(${tx.array(permissionIds)}::uuid[])`;
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

  const rows = await sql!`
    select e.employee_id, a.username, e.full_name, e.updated_at
    from public.employees e
    join public.employee_accounts a on a.employee_id = e.employee_id
    where e.employee_id = ${employeeId}::uuid
      and a.is_active is true
      and e.employment_status = 'Active'
      and exists (
        select 1
        from public.user_roles ur
        join public.roles r on r.role_id = ur.role_id
        where ur.employee_id = e.employee_id
          and r.role_name = 'Admin'
          and ur.valid_from <= ${VN_TODAY}::date
          and (ur.valid_to is null or ur.valid_to >= ${VN_TODAY}::date)
      )
    limit 1`;

  const row = rows[0];
  if (!row) return null;

  // TÍNH NĂNG MỚI: Kiểm tra Token cũ hay mới so với lần cập nhật cuối
  if (row.updated_at && iat > 0) {
    const lastUpdated = Math.floor(new Date(row.updated_at).getTime() / 1000);
    // Độ trễ 5 giây để tránh lỗi sai số đồng hồ lúc vừa cấp token
    if (iat < lastUpdated - 5) {
      return null; // Trả về null -> Hệ thống báo 401 Unauthorized -> Văng ra login
    }
  }

  // (Return giữ nguyên theo file cũ của bạn)
  return {
    employee_id: row.employee_id,
    username: row.username,
    full_name: row.full_name,
  } as Actor;
}

const DB_ERRORS: Record<string, string> = {
  "23505": "duplicate", // unique_violation
  "23503": "invalid_reference", // foreign_key_violation
  "23514": "check_violation", // check_violation
  "23P01": "role_overlap", // exclusion_violation (ex_user_roles_no_overlap)
};

function dbError(err: unknown): Response {
  const code = (err as { code?: string })?.code ?? "";
  if (DB_ERRORS[code]) return json({ ok: false, error: DB_ERRORS[code] }, 400);
  console.error("admin-accounts: unhandled database error", err);
  return json({ ok: false, error: "server_error" }, 500);
}

async function optionsAction(): Promise<Response> {
  const [departments, positions] = await Promise.all([
    departmentRows(),
    sql!`
      select p.position_id, p.position_title,
             coalesce(
               (select json_agg(dp.department_id)
                from public.department_positions dp
                where dp.position_id = p.position_id), '[]'::json
             ) as department_ids
      from public.positions p
      order by p.position_title`,
  ]);

  return json({ ok: true, departments, positions });
}

async function departmentRows() {
  return await sql!`
    select department_id, department_name, description
    from public.departments
    order by department_name`;
}

async function rolesRows() {
  return await sql!`
    select r.role_id,
           r.role_name,
           r.description,
           coalesce(
             json_agg(rp.permission_id) filter (where rp.permission_id is not null),
             '[]'::json
           ) as permission_ids
    from public.roles r
    left join public.role_permissions rp on rp.role_id = r.role_id
    group by r.role_id, r.role_name, r.description
    order by r.role_name`;
}

async function rolesAction(): Promise<Response> {
  return json({ ok: true, roles: await rolesRows() });
}

async function permissionsRows() {
  return await sql!`
    select permission_id, permission_code, module_name, action, description
    from public.permissions
    order by module_name, action`;
}

async function permissionsAction(): Promise<Response> {
  return json({ ok: true, permissions: await permissionsRows() });
}

async function createRoleAction(
  body: Record<string, unknown>,
): Promise<Response> {
  const roleName = str(body.role_name);
  const description = str(body.description);
  const permissionIds = readPermissionIds(body.permission_ids);
  if (!roleName) return json({ ok: false, error: "missing_fields" }, 400);
  if (roleName.toLowerCase() === "admin")
    return json({ ok: false, error: "role_name_reserved" }, 400);

  const created = await sql!.begin(async (tx) => {
    const [role] = await tx`
      insert into public.roles (role_name, description)
      values (${roleName}, ${description || null})
      returning role_id`;
    await replaceRolePermissions(tx, String(role.role_id), permissionIds);
    return { role_id: String(role.role_id) };
  });

  return json({ ok: true, ...created });
}

async function updateRoleAction(
  body: Record<string, unknown>,
): Promise<Response> {
  const roleId = str(body.role_id);
  if (!UUID_RE.test(roleId))
    return json({ ok: false, error: "invalid_role" }, 400);

  const roleName = str(body.role_name);
  const description = str(body.description);
  const permissionIds = readPermissionIds(body.permission_ids);
  if (!roleName) return json({ ok: false, error: "missing_fields" }, 400);
  if (roleName.toLowerCase() === "admin")
    return json({ ok: false, error: "role_name_reserved" }, 400);

  const result = await sql!.begin(async (tx) => {
    const [role] = await tx`
      update public.roles
      set role_name = ${roleName}, description = ${description || null}
      where role_id = ${roleId}::uuid and role_name <> 'Admin'
      returning role_id`;
    if (!role) return { error: "not_found" } as const;
    await replaceRolePermissions(tx, roleId, permissionIds);
    return { ok: true } as const;
  });

  if ("error" in result) return json({ ok: false, error: result.error }, 400);
  return json({ ok: true, role_id: roleId });
}

async function assignRoleAction(
  body: Record<string, unknown>,
  actor: Actor,
): Promise<Response> {
  await ensureNoticeColumn();
  const employeeId = str(body.employee_id);
  const roleId = str(body.role_id);
  if (!UUID_RE.test(employeeId))
    return json({ ok: false, error: "invalid_employee" }, 400);
  if (!UUID_RE.test(roleId))
    return json({ ok: false, error: "invalid_reference" }, 400);

  if (employeeId === actor.employee_id) {
    return json({ ok: false, error: "forbidden_self_role_change" }, 403);
  }

  const result = await sql!.begin(async (tx) => {
    const [employee] = await tx`
      select employee_id from public.employees where employee_id = ${employeeId}::uuid limit 1`;
    if (!employee) return { error: "not_found" } as const;

    const [currentUr] = await tx`
      select r.role_id, r.role_name
      from public.user_roles ur
      join public.roles r on r.role_id = ur.role_id
      where ur.employee_id = ${employeeId}::uuid
        and ur.valid_from <= ${VN_TODAY}::date
        and (ur.valid_to is null or ur.valid_to >= ${VN_TODAY}::date)
      order by ur.valid_from desc
      limit 1`;
    if (currentUr?.role_name === "Admin") {
      return { error: "forbidden_admin_role_change" } as const;
    }

    const [role] = await tx`
      select role_id, role_name from public.roles
      where role_id = ${roleId}::uuid limit 1`;
    if (!role) return { error: "unknown_role" } as const;
    if (role.role_name === "Admin") {
      return { error: "cannot_create_admin" } as const;
    }

    await setActiveRole(tx, employeeId, roleId, actor);
    await tx`
      update public.employees
      set updated_at = now()
      where employee_id = ${employeeId}::uuid`;
    const newPassword = await updateAccountPassword(tx, employeeId, roleId);

    if (currentUr?.role_name !== role.role_name) {
      await tx`
        update public.employee_accounts
        set pending_notice = ${JSON.stringify({
          type: "role_changed",
          new_role: role.role_name,
          new_password: newPassword,
          redirect_url: getLoginUrlForRole(role.role_name),
        })}::jsonb
        where employee_id = ${employeeId}::uuid`;
    }

    return { ok: true } as const;
  });

  if ("error" in result) return json({ ok: false, error: result.error }, 400);
  return json({ ok: true, employee_id: employeeId, role_id: roleId });
}

async function latestActivitiesAction(): Promise<Response> {
  const rows = await sql!`
    select a.employee_id,
           to_char(a.last_login at time zone 'Asia/Ho_Chi_Minh', 'DD/MM/YYYY HH24:MI') as last_login
    from public.employee_accounts a
    where a.last_login is not null`;
  return json({ ok: true, activities: rows });
}

async function listRows() {
  return await sql!`
    select e.employee_id,
           e.employee_code,
           e.full_name,
           e.email,
           e.gender,
           contact.phone_number,
           to_char(e.date_of_birth, 'YYYY-MM-DD') as date_of_birth,
           to_char(e.hire_date, 'YYYY-MM-DD') as hire_date,
           coalesce(e.current_department_id, position_department.department_id) as department_id,
           e.current_position_id as position_id,
           d.department_name,
           p.position_title,
           a.username,
           a.is_active,
           to_char(a.last_login at time zone 'Asia/Ho_Chi_Minh', 'DD/MM/YYYY HH24:MI') as last_login,
           a.deleted_at,
           active_role.role_id,
           active_role.role_name
    from public.employees e
    left join lateral (
      select c.phone_number
      from public.employee_contacts c
      where c.employee_id = e.employee_id
      limit 1
    ) contact on true
    left join lateral (
      select dp.department_id
      from public.department_positions dp
      where dp.position_id = e.current_position_id
      order by dp.department_id
      limit 1
    ) position_department on true
    left join public.departments d
      on d.department_id = coalesce(e.current_department_id, position_department.department_id)
    left join public.positions p on p.position_id = e.current_position_id
    join public.employee_accounts a on a.employee_id = e.employee_id
    left join lateral (
      select ur.role_id, r.role_name
      from public.user_roles ur
      join public.roles r on r.role_id = ur.role_id
      where ur.employee_id = e.employee_id
        and ur.valid_from <= ${VN_TODAY}::date
        and (ur.valid_to is null or ur.valid_to >= ${VN_TODAY}::date)
      order by ur.valid_from desc, ur.user_role_id desc
      limit 1
    ) active_role on true
    order by (active_role.role_name = 'Admin') desc, e.full_name`;
}

async function listAction(): Promise<Response> {
  return json({ ok: true, accounts: await listRows() });
}

// Staff summary for the overview panel: every active employee, with or without a login account.
async function staffRows() {
  return await sql!`
    select e.employee_id, e.full_name, p.position_title
    from public.employees e
    join public.positions p on p.position_id = e.current_position_id
    where e.employment_status = 'Active'
    order by e.full_name`;
}

async function staffAction(): Promise<Response> {
  return json({ ok: true, staff: await staffRows() });
}

// Everything the dashboard needs on boot, in one round trip: the browser would
// otherwise open four cold isolates (and four database connections) at once.
async function initAction(): Promise<Response> {
  return json({
    ok: true,
    accounts: await listRows(),
    staff: await staffRows(),
    roles: await rolesRows(),
    permissions: await permissionsRows(),
    departments: await departmentRows(),
  });
}

async function createAction(
  body: Record<string, unknown>,
  actor: Actor,
): Promise<Response> {
  const resolved = await resolveProfile(body);
  if ("error" in resolved)
    return json({ ok: false, error: resolved.error }, 400);

  const fields = resolved.fields;
  const isActive = body.is_active !== false;

  const roleId = await resolveRoleId(body.role_id);
  if (!roleId) return json({ ok: false, error: "unknown_role" }, 400);

  const [role] = await sql!`
    select role_name
    from public.roles
    where role_id = ${roleId}::uuid
    limit 1`;
  if (role?.role_name === "Admin") {
    return json({ ok: false, error: "cannot_create_admin" }, 400);
  }

  const username = fields.email.split("@")[0].toLowerCase();

  const password = generateAccountPassword(
    String(role?.role_name || ""),
    resolved.departmentDescription,
    fields.date_of_birth,
  );
  const submittedPassword = str(body.generated_password);

  const created = await sql!.begin(async (tx) => {
    const [employee] = await tx`
      insert into public.employees
        (employee_code, full_name, date_of_birth, gender, email, hire_date,
         current_position_id, current_department_id, employment_status)
      values
        (${fields.employee_code}, ${fields.full_name}, ${fields.date_of_birth}, ${fields.gender},
         ${fields.email}, ${fields.hire_date}, ${(fields.position_id || null)}::uuid,
         ${fields.department_id}::uuid, 'Active')
      returning employee_id`;

    if (fields.phone_number) {
      await tx`
        insert into public.employee_contacts (employee_id, phone_number)
        values (${employee.employee_id}::uuid, ${fields.phone_number})`;
    }

    await tx`
      insert into public.employee_accounts (employee_id, username, password_hash, is_active)
      values (${employee.employee_id}::uuid, ${username},
              extensions.crypt(${submittedPassword || password}, extensions.gen_salt('bf', 10)), ${isActive})`;

    await tx`
      insert into public.user_roles (employee_id, role_id, valid_from, assigned_by, reason)
      values (${employee.employee_id}::uuid, ${roleId}::uuid, ${VN_TODAY}::date,
              ${actor.employee_id}::uuid, 'Created from admin dashboard')`;

    return { employee_id: employee.employee_id as string, username };
  });

  return json({
    ok: true,
    employee_id: created.employee_id,
    username: created.username,
  });
}

async function updateAction(
  body: Record<string, unknown>,
  actor: Actor,
): Promise<Response> {
  await ensureNoticeColumn();
  const employeeId = str(body.employee_id);
  if (!UUID_RE.test(employeeId))
    return json({ ok: false, error: "invalid_employee" }, 400);

  const resolved = await resolveProfile(body);
  if ("error" in resolved)
    return json({ ok: false, error: resolved.error }, 400);

  const fields = resolved.fields;
  const isActive = body.is_active !== false;
  const roleId = str(body.role_id);

  const result = await sql!.begin(async (tx) => {
    const [beforeEmp] = await tx`
      select to_char(e.date_of_birth, 'YYYY-MM-DD') as old_dob,
             e.current_department_id as old_dept_id,
             coalesce(d.description, '') as old_dept_desc,
             coalesce(r.role_id::text, '') as old_role_id,
             coalesce(r.role_name, 'Nhân viên') as old_role_name
      from public.employees e
      left join public.departments d on d.department_id = e.current_department_id
      left join lateral (
        select ur.role_id, r.role_name
        from public.user_roles ur
        join public.roles r on r.role_id = ur.role_id
        where ur.employee_id = e.employee_id
          and ur.valid_from <= ${VN_TODAY}::date
          and (ur.valid_to is null or ur.valid_to >= ${VN_TODAY}::date)
        order by ur.valid_from desc, ur.user_role_id desc
        limit 1
      ) r on true
      where e.employee_id = ${employeeId}::uuid
      limit 1`;
    if (!beforeEmp) return { error: "not_found" } as const;

    const oldGeneratedPassword = generateAccountPassword(
      String(beforeEmp.old_role_name || "Nhân viên"),
      String(beforeEmp.old_dept_desc || ""),
      String(beforeEmp.old_dob || ""),
    );

    const [employee] = await tx`
      update public.employees
      set employee_code = ${fields.employee_code},
          full_name = ${fields.full_name},
          email = ${fields.email},
          gender = ${fields.gender},
          date_of_birth = ${fields.date_of_birth},
          hire_date = ${fields.hire_date},
          current_position_id = ${(fields.position_id || null)}::uuid,
          current_department_id = ${fields.department_id}::uuid,
          updated_at = now()
      where employee_id = ${employeeId}::uuid
      returning employee_id`;
    if (!employee) return { error: "not_found" } as const;

    const [account] = await tx`
      update public.employee_accounts
      set is_active = ${isActive}
      where employee_id = ${employeeId}::uuid
      returning employee_id`;
    if (!account) return { error: "account_not_found" } as const;

    if (body.phone_number !== undefined) {
      const [existingContact] = await tx`
        select employee_id from public.employee_contacts
        where employee_id = ${employeeId}::uuid limit 1`;
      if (existingContact) {
        await tx`
          update public.employee_contacts
          set phone_number = ${fields.phone_number || null}
          where employee_id = ${employeeId}::uuid`;
      } else if (fields.phone_number) {
        await tx`
          insert into public.employee_contacts (employee_id, phone_number)
          values (${employeeId}::uuid, ${fields.phone_number})`;
      }
    }

    let roleChanged = false;
    let newRoleName = String(beforeEmp.old_role_name || "Nhân viên");

    // Role is owned by the "Vai trò & Quyền" section; only touch it when supplied.
    if (roleId) {
      const [currentUr] = await tx`
        select ur.role_id, r.role_name
        from public.user_roles ur
        join public.roles r on r.role_id = ur.role_id
        where ur.employee_id = ${employeeId}::uuid
          and ur.valid_from <= ${VN_TODAY}::date
          and (ur.valid_to is null or ur.valid_to >= ${VN_TODAY}::date)
        order by ur.valid_from desc
        limit 1`;

      if (!currentUr || String(currentUr.role_id) !== roleId) {
        if (employeeId === actor.employee_id) {
          return { error: "forbidden_self_role_change" } as const;
        }
        if (currentUr?.role_name === "Admin") {
          return { error: "forbidden_admin_role_change" } as const;
        }
        const [role] = await tx`
          select role_id, role_name from public.roles
          where role_id = ${roleId}::uuid limit 1`;
        if (!role) return { error: "unknown_role" } as const;
        if (role.role_name === "Admin") {
          return { error: "cannot_create_admin" } as const;
        }
        await setActiveRole(tx, employeeId, roleId, actor);
        if (currentUr?.role_name !== role.role_name) {
          roleChanged = true;
          newRoleName = role.role_name;
        }
      }
    }

    const submittedPassword = str(body.generated_password);
    let finalPassword = "";

    if (submittedPassword) {
      finalPassword = submittedPassword;
      await tx`
        update public.employee_accounts
        set password_hash = extensions.crypt(${submittedPassword}, extensions.gen_salt('bf', 10))
        where employee_id = ${employeeId}::uuid`;
    } else {
      if (roleId) {
        finalPassword = await updateAccountPassword(tx, employeeId, roleId);
      } else {
        const [activeRole] = await tx`
          select role_id
          from public.user_roles
          where employee_id = ${employeeId}::uuid
            and valid_from <= ${VN_TODAY}::date
            and (valid_to is null or valid_to >= ${VN_TODAY}::date)
          order by valid_from desc, user_role_id desc
          limit 1`;
        if (activeRole) {
          finalPassword = await updateAccountPassword(
            tx,
            employeeId,
            String(activeRole.role_id),
          );
        }
      }
    }

    if (roleChanged) {
      await tx`
        update public.employee_accounts
        set pending_notice = ${JSON.stringify({
          type: "role_changed",
          new_role: newRoleName,
          new_password: finalPassword,
          redirect_url: getLoginUrlForRole(newRoleName),
        })}::jsonb
        where employee_id = ${employeeId}::uuid`;
    } else if (finalPassword && finalPassword !== oldGeneratedPassword) {
      await tx`
        update public.employee_accounts
        set pending_notice = ${JSON.stringify({
          type: "admin_password_changed",
          new_password: finalPassword,
          redirect_url: getLoginUrlForRole(beforeEmp.old_role_name),
        })}::jsonb
        where employee_id = ${employeeId}::uuid`;
    }

    return { ok: true } as const;
  });

  if ("error" in result) return json({ ok: false, error: result.error }, 400);
  return json({ ok: true, employee_id: employeeId });
}

// Lock/unlock a single account. The row stays in the list, only the login state changes.
async function setActiveAction(
  body: Record<string, unknown>,
): Promise<Response> {
  const employeeId = str(body.employee_id);
  if (!UUID_RE.test(employeeId))
    return json({ ok: false, error: "invalid_employee" }, 400);

  const isActive = body.is_active !== false;
  const rows = await sql!`
    update public.employee_accounts
    set is_active = ${isActive}
    where employee_id = ${employeeId}::uuid
      and deleted_at is null
    returning employee_id, is_active`;
  if (rows.length === 0) return json({ ok: false, error: "not_found" }, 400);

  return json({
    ok: true,
    employee_id: rows[0].employee_id,
    is_active: rows[0].is_active,
  });
}

// Soft delete only: the row stays visible in the list with is_active = false,
// while admin_login refuses it because it never accepts an inactive account.
async function deleteAction(body: Record<string, unknown>): Promise<Response> {
  const employeeId = str(body.employee_id);
  if (!UUID_RE.test(employeeId))
    return json({ ok: false, error: "invalid_employee" }, 400);

  const rows = await sql!`
    update public.employee_accounts
    set deleted_at = now(), is_active = false
    where employee_id = ${employeeId}::uuid
      and deleted_at is null
    returning employee_id`;
  if (rows.length === 0) return json({ ok: false, error: "not_found" }, 400);

  return json({ ok: true, employee_id: rows[0].employee_id });
}

// Undo a soft delete: clear the marker and give the account a usable state again.
async function restoreAction(body: Record<string, unknown>): Promise<Response> {
  const employeeId = str(body.employee_id);
  if (!UUID_RE.test(employeeId))
    return json({ ok: false, error: "invalid_employee" }, 400);

  const rows = await sql!`
    update public.employee_accounts
    set deleted_at = null, is_active = true
    where employee_id = ${employeeId}::uuid
      and deleted_at is not null
    returning employee_id, is_active`;
  if (rows.length === 0) return json({ ok: false, error: "not_found" }, 400);

  return json({
    ok: true,
    employee_id: rows[0].employee_id,
    is_active: rows[0].is_active,
  });
}

async function permanentDeleteAction(
  body: Record<string, unknown>,
  actor: Actor,
): Promise<Response> {
  const employeeId = str(body.employee_id);
  if (!UUID_RE.test(employeeId))
    return json({ ok: false, error: "invalid_employee" }, 400);

  if (employeeId === actor.employee_id) {
    return json({ ok: false, error: "forbidden_self_delete" }, 403);
  }

  // Prevent deleting admin account
  const [adminCheck] = await sql!`
    select 1
    from public.user_roles ur
    join public.roles r on r.role_id = ur.role_id
    where ur.employee_id = ${employeeId}::uuid
      and r.role_name = 'Admin'
      and ur.valid_from <= ${VN_TODAY}::date
      and (ur.valid_to is null or ur.valid_to >= ${VN_TODAY}::date)
    limit 1`;
  if (adminCheck) {
    return json({ ok: false, error: "forbidden_cannot_delete_admin" }, 403);
  }

  let result;
  try {
    result = await sql!.begin(async (tx) => {
      const [emp] = await tx`
        select employee_id
        from public.employees
        where employee_id = ${employeeId}::uuid
        for update`;
      if (!emp) return { error: "not_found" } as const;

      // 1. Delete payroll_details (FK to payroll)
      await tx`
        delete from public.payroll_details
        where payroll_id in (
          select payroll_id from public.payroll where employee_id = ${employeeId}::uuid
        )`;

      // 2. Delete payroll
      await tx`
        delete from public.payroll
        where employee_id = ${employeeId}::uuid`;

      // 3. Nullify attendance ot_approved_by, then delete attendance_records
      await tx`
        update public.attendance_records
        set ot_approved_by = null
        where ot_approved_by = ${employeeId}::uuid`;
      await tx`
        delete from public.attendance_records
        where employee_id = ${employeeId}::uuid`;

      // 4. Nullify leave_requests approved_by, then delete leave_requests
      await tx`
        update public.leave_requests
        set approved_by = null
        where approved_by = ${employeeId}::uuid`;
      await tx`
        delete from public.leave_requests
        where employee_id = ${employeeId}::uuid`;

      // 5. Nullify career_history approved_by, then delete career_history
      await tx`
        update public.career_history
        set approved_by = null
        where approved_by = ${employeeId}::uuid`;
      await tx`
        delete from public.career_history
        where employee_id = ${employeeId}::uuid`;

      // 6. Nullify employee_status_history recorded_by, then delete employee_status_history
      await tx`
        update public.employee_status_history
        set recorded_by = null
        where recorded_by = ${employeeId}::uuid`;
      await tx`
        delete from public.employee_status_history
        where employee_id = ${employeeId}::uuid`;

      // 7. Nullify hr_employment_status_history changed_by, then delete hr_employment_status_history
      await tx`
        update public.hr_employment_status_history
        set changed_by = null
        where changed_by = ${employeeId}::uuid`;
      await tx`
        delete from public.hr_employment_status_history
        where employee_id = ${employeeId}::uuid`;

      // 8. Delete personal, qualification, and payroll info
      await tx`
        delete from public.employee_payroll_info
        where employee_id = ${employeeId}::uuid`;
      await tx`
        delete from public.employee_personal_info
        where employee_id = ${employeeId}::uuid`;
      await tx`
        delete from public.employee_qualifications
        where employee_id = ${employeeId}::uuid`;

      // 9. Delete employee_contacts
      await tx`
        delete from public.employee_contacts
        where employee_id = ${employeeId}::uuid`;

      // 10. Nullify user_roles assigned_by, then delete employee's user_roles
      await tx`
        update public.user_roles
        set assigned_by = null
        where assigned_by = ${employeeId}::uuid`;
      await tx`
        delete from public.user_roles
        where employee_id = ${employeeId}::uuid`;

      // 11. Delete employee_accounts
      await tx`
        delete from public.employee_accounts
        where employee_id = ${employeeId}::uuid`;

      // 12. Delete employees
      const [deletedEmp] = await tx`
        delete from public.employees
        where employee_id = ${employeeId}::uuid
        returning employee_id`;

      if (!deletedEmp) return { error: "not_found" } as const;

      return { ok: true, employee_id: deletedEmp.employee_id } as const;
    });
  } catch (error) {
    console.error("admin-accounts: permanent delete failed", {
      employee_id: employeeId,
      code: (error as { code?: string })?.code,
      message: (error as { message?: string })?.message,
      detail: (error as { detail?: string })?.detail,
    });
    return json({ ok: false, error: "permanent_delete_failed" }, 400);
  }
  if ("error" in result) return json({ ok: false, error: result.error }, 400);

  return json({ ok: true, employee_id: result.employee_id });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS")
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (req.method !== "POST")
    return json({ ok: false, error: "method_not_allowed" }, 405);

  if (!sql || !JWT_KEY) {
    console.error(
      "admin-accounts: SUPABASE_DB_URL or ADMIN_JWT_SECRET is not set",
    );
    return json({ ok: false, error: "server_not_configured" }, 500);
  }

  

  const token = req.headers.get("x-admin-token") ?? "";

  let actor: Actor | null;
  try {
    actor = token ? await getActor(token) : null;
  } catch (err) {
    return dbError(err); // database trouble is not a bad token
  }
  if (!actor) {
    let redirectUrl = "login.html";
    let activeRole = "";
    if (token) {
      try {
        const { payload } = await jwtVerify(token, JWT_KEY!, { algorithms: ["HS256"] });
        const employeeId = typeof payload.employee_id === "string" ? payload.employee_id : "";
        if (UUID_RE.test(employeeId)) {
          const [roleRow] = await sql!`
            select r.role_name
            from public.user_roles ur
            join public.roles r on r.role_id = ur.role_id
            where ur.employee_id = ${employeeId}::uuid
              and ur.valid_from <= ${VN_TODAY}::date
              and (ur.valid_to is null or ur.valid_to >= ${VN_TODAY}::date)
            order by ur.valid_from desc, ur.user_role_id desc
            limit 1`;
          if (roleRow) {
            activeRole = String(roleRow.role_name);
            const lower = activeRole.toLowerCase();
            if (lower === "admin") {
              redirectUrl = "login.html";
            } else if (["manager", "hr_manager", "quản lý", "quản lý nhân sự"].includes(lower)) {
              redirectUrl = "../manager/login.html";
            } else {
              redirectUrl = "../staff/staff-login.html";
            }
          }
        }
      } catch {
        // ignore
      }
    }
    return json({ ok: false, error: "unauthorized", role: activeRole, redirect_url: redirectUrl }, 401);
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: "bad_request" }, 400);
  }
  if (!body || typeof body !== "object")
    return json({ ok: false, error: "bad_request" }, 400);

  try {
    switch (body.action) {
      case "ping":
        return json({ ok: true });
      case "init":
        return await initAction();
      case "options":
        return await optionsAction();
      
      case "latest_activities":
        return await latestActivitiesAction();
      case "list":
        return await listAction();
      case "staff":
        return await staffAction();
      case "create":
        return await createAction(body, actor);
      case "update":
        return await updateAction(body, actor);
      case "set_active":
        return await setActiveAction(body);
      case "delete":
        return await deleteAction(body);
      case "restore":
        return await restoreAction(body);
      case "permanent_delete":
        return await permanentDeleteAction(body, actor);
      case "roles":
        return await rolesAction();
      case "permissions":
        return await permissionsAction();
      case "create_role":
        return await createRoleAction(body);
      case "update_role":
        return await updateRoleAction(body);
      case "assign_role":
        return await assignRoleAction(body, actor);
      default:
        return json({ ok: false, error: "unknown_action" }, 400);
    }
  } catch (err) {
    return dbError(err);
  }
});
