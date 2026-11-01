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
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Vietnam calendar date (YYYY-MM-DD), shared by every date-sensitive query.
// Computed in JS on purpose: a module-level query would start an unhandled
// database round-trip during boot and can wedge the isolate on a cold start.
const VN_TODAY = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ho_Chi_Minh" }).format(new Date());

type Actor = { employee_id: string; username: string; full_name: string };

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function isRealDate(value: string): boolean {
  if (!DATE_RE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function readProfile(body: Record<string, unknown>) {
  const fields = {
    employee_code: str(body.employee_code),
    full_name: str(body.full_name),
    email: str(body.email).toLowerCase(),
    gender: str(body.gender),
    date_of_birth: str(body.date_of_birth),
    hire_date: str(body.hire_date),
    department_id: str(body.department_id),
    position_id: str(body.position_id),
  };

  if (
    !fields.employee_code || !fields.full_name || !fields.email || !fields.gender ||
    !fields.date_of_birth || !fields.hire_date
  ) return { error: "missing_fields" } as const;

  if (!EMAIL_RE.test(fields.email)) return { error: "invalid_email" } as const;
  if (!isRealDate(fields.date_of_birth)) return { error: "invalid_date_of_birth" } as const;
  if (!isRealDate(fields.hire_date)) return { error: "invalid_hire_date" } as const;
  if (![fields.department_id, fields.position_id].every((v) => UUID_RE.test(v))) {
    return { error: "invalid_reference" } as const;
  }

  // Mirrors ck_employees_min_working_age: hire_date >= date_of_birth + 15 years.
  const dob = new Date(`${fields.date_of_birth}T00:00:00Z`);
  const earliest = Date.UTC(dob.getUTCFullYear() + 15, dob.getUTCMonth(), dob.getUTCDate());
  if (new Date(`${fields.hire_date}T00:00:00Z`).getTime() < earliest) {
    return { error: "under_min_age" } as const;
  }

  return { fields } as const;
}

// Returns the department name (needed for the password rule) plus reference validity.
async function loadDepartmentAndRefs(departmentId: string, positionId: string) {
  const rows = await sql!`
    select d.department_name,
           exists(
             select 1 from public.positions p
             where p.position_id = ${positionId}::uuid and p.department_id = ${departmentId}::uuid
           ) as position_ok
    from public.departments d
    where d.department_id = ${departmentId}::uuid`;
  return rows[0] ?? null;
}

async function resolveProfile(body: Record<string, unknown>) {
  const parsed = readProfile(body);
  if ("error" in parsed) return { error: parsed.error } as const;

  const ref = await loadDepartmentAndRefs(parsed.fields.department_id, parsed.fields.position_id);
  if (!ref) return { error: "unknown_department" } as const;
  if (!ref.position_ok) return { error: "position_department_mismatch" } as const;

  return { fields: parsed.fields, departmentName: String(ref.department_name) } as const;
}

// Admin is never assignable; a missing role falls back to the default "Nhân viên" role.
async function resolveRoleId(value: unknown): Promise<string | null> {
  const roleId = str(value);
  const rows = UUID_RE.test(roleId)
    ? await sql!`select role_id from public.roles where role_id = ${roleId}::uuid and role_name <> 'Admin' limit 1`
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
  const ids = value.filter((item): item is string => typeof item === "string" && UUID_RE.test(item));
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

  return (rows[0] as Actor | undefined) ?? null;
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
  const rows = await sql!`
    select
      coalesce((
        select json_agg(json_build_object(
          'department_id', d.department_id,
          'department_name', d.department_name
        ) order by d.department_name)
        from public.departments d
      ), '[]'::json) as departments,
      coalesce((
        select json_agg(json_build_object(
          'position_id', p.position_id,
          'position_title', p.position_title,
          'department_id', p.department_id
        ) order by p.position_title)
        from public.positions p
      ), '[]'::json) as positions`;
  return json({ ok: true, ...(rows[0] ?? {}) });
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
    where r.role_name <> 'Admin'
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

async function createRoleAction(body: Record<string, unknown>): Promise<Response> {
  const roleName = str(body.role_name);
  const description = str(body.description);
  const permissionIds = readPermissionIds(body.permission_ids);
  if (!roleName) return json({ ok: false, error: "missing_fields" }, 400);
  if (roleName.toLowerCase() === "admin") return json({ ok: false, error: "role_name_reserved" }, 400);

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

async function updateRoleAction(body: Record<string, unknown>): Promise<Response> {
  const roleId = str(body.role_id);
  if (!UUID_RE.test(roleId)) return json({ ok: false, error: "invalid_role" }, 400);

  const roleName = str(body.role_name);
  const description = str(body.description);
  const permissionIds = readPermissionIds(body.permission_ids);
  if (!roleName) return json({ ok: false, error: "missing_fields" }, 400);
  if (roleName.toLowerCase() === "admin") return json({ ok: false, error: "role_name_reserved" }, 400);

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

async function assignRoleAction(body: Record<string, unknown>, actor: Actor): Promise<Response> {
  const employeeId = str(body.employee_id);
  const roleId = str(body.role_id);
  if (!UUID_RE.test(employeeId)) return json({ ok: false, error: "invalid_employee" }, 400);
  if (!UUID_RE.test(roleId)) return json({ ok: false, error: "invalid_reference" }, 400);

  const result = await sql!.begin(async (tx) => {
    const [employee] = await tx`
      select employee_id from public.employees where employee_id = ${employeeId}::uuid limit 1`;
    if (!employee) return { error: "not_found" } as const;

    const [role] = await tx`
      select role_id from public.roles
      where role_id = ${roleId}::uuid and role_name <> 'Admin' limit 1`;
    if (!role) return { error: "unknown_role" } as const;

    await setActiveRole(tx, employeeId, roleId, actor);
    return { ok: true } as const;
  });

  if ("error" in result) return json({ ok: false, error: result.error }, 400);
  return json({ ok: true, employee_id: employeeId, role_id: roleId });
}

async function listRows() {
  return await sql!`
    select e.employee_id,
           e.employee_code,
           e.full_name,
           e.email,
           e.gender,
           to_char(e.date_of_birth, 'YYYY-MM-DD') as date_of_birth,
           to_char(e.hire_date, 'YYYY-MM-DD') as hire_date,
           e.current_department_id as department_id,
           e.current_position_id as position_id,
           a.username,
           a.is_active,
           to_char(a.last_login at time zone 'Asia/Ho_Chi_Minh', 'DD/MM/YYYY HH24:MI') as last_login,
           a.deleted_at,
           active_role.role_id,
           active_role.role_name
    from public.employees e
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
  });
}

async function createAction(body: Record<string, unknown>, actor: Actor): Promise<Response> {
  const resolved = await resolveProfile(body);
  if ("error" in resolved) return json({ ok: false, error: resolved.error }, 400);

  const fields = resolved.fields;
  const isActive = body.is_active !== false;

  const roleId = await resolveRoleId(body.role_id);
  if (!roleId) return json({ ok: false, error: "unknown_role" }, 400);

  // Username = lowercase local part of the email. Password is derived from the
  // department name and date of birth, hashed in SQL and never returned.
  const username = fields.email.split("@")[0].toLowerCase();
  const [year, month, day] = fields.date_of_birth.split("-");
  const password = `${resolved.departmentName.slice(0, 3).toLowerCase()}@${day}${month}${year}`;

  const created = await sql!.begin(async (tx) => {
    const [employee] = await tx`
      insert into public.employees
        (employee_code, full_name, date_of_birth, gender, email, hire_date,
         current_position_id, current_department_id, employment_status)
      values
        (${fields.employee_code}, ${fields.full_name}, ${fields.date_of_birth}, ${fields.gender},
         ${fields.email}, ${fields.hire_date}, ${fields.position_id}::uuid,
         ${fields.department_id}::uuid, 'Active')
      returning employee_id`;

    await tx`
      insert into public.employee_accounts (employee_id, username, password_hash, is_active)
      values (${employee.employee_id}::uuid, ${username},
              extensions.crypt(${password}, extensions.gen_salt('bf', 10)), ${isActive})`;

    await tx`
      insert into public.user_roles (employee_id, role_id, valid_from, assigned_by, reason)
      values (${employee.employee_id}::uuid, ${roleId}::uuid, ${VN_TODAY}::date,
              ${actor.employee_id}::uuid, 'Created from admin dashboard')`;

    return { employee_id: employee.employee_id as string, username };
  });

  return json({ ok: true, employee_id: created.employee_id, username: created.username });
}

async function updateAction(body: Record<string, unknown>, actor: Actor): Promise<Response> {
  const employeeId = str(body.employee_id);
  if (!UUID_RE.test(employeeId)) return json({ ok: false, error: "invalid_employee" }, 400);

  const resolved = await resolveProfile(body);
  if ("error" in resolved) return json({ ok: false, error: resolved.error }, 400);

  const fields = resolved.fields;
  const isActive = body.is_active !== false;
  const roleId = str(body.role_id);

  const result = await sql!.begin(async (tx) => {
    const [employee] = await tx`
      update public.employees
      set employee_code = ${fields.employee_code},
          full_name = ${fields.full_name},
          email = ${fields.email},
          gender = ${fields.gender},
          date_of_birth = ${fields.date_of_birth},
          hire_date = ${fields.hire_date},
          current_position_id = ${fields.position_id}::uuid,
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

    // Role is owned by the "Vai trò & Quyền" section; only touch it when supplied.
    if (roleId) {
      const [role] = await tx`
        select role_id from public.roles
        where role_id = ${roleId}::uuid and role_name <> 'Admin' limit 1`;
      if (!role) return { error: "unknown_role" } as const;
      await setActiveRole(tx, employeeId, roleId, actor);
    }

    return { ok: true } as const;
  });

  if ("error" in result) return json({ ok: false, error: result.error }, 400);
  return json({ ok: true, employee_id: employeeId });
}

// Lock/unlock a single account. The row stays in the list, only the login state changes.
async function setActiveAction(body: Record<string, unknown>): Promise<Response> {
  const employeeId = str(body.employee_id);
  if (!UUID_RE.test(employeeId)) return json({ ok: false, error: "invalid_employee" }, 400);

  const isActive = body.is_active !== false;
  const rows = await sql!`
    update public.employee_accounts
    set is_active = ${isActive}
    where employee_id = ${employeeId}::uuid
      and deleted_at is null
    returning employee_id, is_active`;
  if (rows.length === 0) return json({ ok: false, error: "not_found" }, 400);

  return json({ ok: true, employee_id: rows[0].employee_id, is_active: rows[0].is_active });
}

// Soft delete only: the row stays visible in the list with is_active = false,
// while admin_login refuses it because it never accepts an inactive account.
async function deleteAction(body: Record<string, unknown>): Promise<Response> {
  const employeeId = str(body.employee_id);
  if (!UUID_RE.test(employeeId)) return json({ ok: false, error: "invalid_employee" }, 400);

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
  if (!UUID_RE.test(employeeId)) return json({ ok: false, error: "invalid_employee" }, 400);

  const rows = await sql!`
    update public.employee_accounts
    set deleted_at = null, is_active = true
    where employee_id = ${employeeId}::uuid
      and deleted_at is not null
    returning employee_id, is_active`;
  if (rows.length === 0) return json({ ok: false, error: "not_found" }, 400);

  return json({ ok: true, employee_id: rows[0].employee_id, is_active: rows[0].is_active });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);

  if (!sql || !JWT_KEY) {
    console.error("admin-accounts: SUPABASE_DB_URL or ADMIN_JWT_SECRET is not set");
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
  if (!body || typeof body !== "object") return json({ ok: false, error: "bad_request" }, 400);

  try {
    switch (body.action) {
      case "init": return await initAction();
      case "options": return await optionsAction();
      case "list": return await listAction();
      case "staff": return await staffAction();
      case "create": return await createAction(body, actor);
      case "update": return await updateAction(body, actor);
      case "set_active": return await setActiveAction(body);
      case "delete": return await deleteAction(body);
      case "restore": return await restoreAction(body);
      case "roles": return await rolesAction();
      case "permissions": return await permissionsAction();
      case "create_role": return await createRoleAction(body);
      case "update_role": return await updateRoleAction(body);
      case "assign_role": return await assignRoleAction(body, actor);
      default: return json({ ok: false, error: "unknown_action" }, 400);
    }
  } catch (err) {
    return dbError(err);
  }
});
