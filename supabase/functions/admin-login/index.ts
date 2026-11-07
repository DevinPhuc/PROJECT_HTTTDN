// POST /functions/v1/admin-login  { username, password }
// Verifies against public.admin_login() and returns a signed 8h HS256 session token.
import postgres from "npm:postgres@3";
import { SignJWT } from "npm:jose@5";

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

type LoginResult = {
  ok?: boolean;
  error?: string;
  employee_id?: string;
  username?: string;
  full_name?: string;
  role?: string;
};

// portal_login extends admin_login with a portals mapping instead of the
// Admin-only requirement; used by the staff/manager portals.
type PortalLoginResult = {
  ok?: boolean;
  error?: string;
  employee_id?: string;
  username?: string;
  full_name?: string;
  portals?: unknown;
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);

  if (!sql || !JWT_KEY) {
    console.error("admin-login: SUPABASE_DB_URL or ADMIN_JWT_SECRET is not set");
    return json({ ok: false, error: "server_not_configured" }, 500);
  }

  let body: { username?: unknown; password?: unknown; warm?: unknown; portal?: unknown };
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: "bad_request" }, 400);
  }

  // The login page calls this while the user types: it opens the database
  // connection so the real submit does not pay the ~1s cold-start cost.
  if (body.warm === true) {
    await sql`select 1`;
    return json({ ok: true });
  }

  const username = typeof body.username === "string" ? body.username.trim() : "";
  const password = typeof body.password === "string" ? body.password : "";
  if (!username || !password) return json({ ok: false, error: "invalid_credentials" }, 401);

  // Portal mode: staff/manager/leader sign-in against portal_login, gated by the
  // portals the account may enter. Response keeps the same shape plus portals.
  const portal = typeof body.portal === "string" ? body.portal.trim().toLowerCase() : "";
  if (portal) {
    if (!["staff", "manager", "leader", "hr"].includes(portal)) {
      return json({ ok: false, error: "invalid_portal" }, 400);
    }

    let portalResult: PortalLoginResult;
    try {
      const rows = await sql`select public.portal_login(${username}, ${password}) as result`;
      portalResult = (rows[0]?.result ?? { ok: false, error: "invalid_credentials" }) as PortalLoginResult;
    } catch (err) {
      console.error("admin-login: public.portal_login failed", err);
      return json({ ok: false, error: "server_error" }, 500);
    }

    if (portalResult.ok !== true) {
      return json({ ok: false, error: portalResult.error ?? "invalid_credentials" }, 401);
    }

    const portals = Array.isArray(portalResult.portals)
      ? portalResult.portals.filter((p): p is string => typeof p === "string")
      : [];
    const [activeAccess] = await sql`
      select
        exists (
          select 1
          from public.user_roles ur
          join public.roles r on r.role_id = ur.role_id
          where ur.employee_id = ${portalResult.employee_id}::uuid
            and r.role_name = 'Admin'
            and ur.valid_from <= (now() at time zone 'Asia/Ho_Chi_Minh')::date
            and (ur.valid_to is null or ur.valid_to >= (now() at time zone 'Asia/Ho_Chi_Minh')::date)
        ) as is_admin,
        exists (
          select 1
          from public.user_roles ur
          join public.roles r on r.role_id = ur.role_id
          where ur.employee_id = ${portalResult.employee_id}::uuid
            and lower(r.role_name) in ('manager', 'hr_manager', 'quản lý', 'quản lý nhân sự')
            and ur.valid_from <= (now() at time zone 'Asia/Ho_Chi_Minh')::date
            and (ur.valid_to is null or ur.valid_to >= (now() at time zone 'Asia/Ho_Chi_Minh')::date)
        ) or exists (
          select 1
          from public.user_roles ur
          join public.role_permissions rp on rp.role_id = ur.role_id
          join public.permissions p on p.permission_id = rp.permission_id
          where ur.employee_id = ${portalResult.employee_id}::uuid
            and lower(p.permission_code) in ('manager', 'hr_manager', 'manage_staff', 'manage_employees')
            and ur.valid_from <= (now() at time zone 'Asia/Ho_Chi_Minh')::date
            and (ur.valid_to is null or ur.valid_to >= (now() at time zone 'Asia/Ho_Chi_Minh')::date)
        ) as is_manager,
        exists (
          select 1
          from public.user_roles ur
          join public.roles r on r.role_id = ur.role_id
          where ur.employee_id = ${portalResult.employee_id}::uuid
            and lower(r.role_name) in ('leader', 'team_lead', 'team lead', 'team_leader', 'team leader', 'trưởng nhóm', 'truong nhom')
            and ur.valid_from <= (now() at time zone 'Asia/Ho_Chi_Minh')::date
            and (ur.valid_to is null or ur.valid_to >= (now() at time zone 'Asia/Ho_Chi_Minh')::date)
        ) or exists (
          select 1
          from public.user_roles ur
          join public.role_permissions rp on rp.role_id = ur.role_id
          join public.permissions p on p.permission_id = rp.permission_id
          where ur.employee_id = ${portalResult.employee_id}::uuid
            and lower(p.permission_code) in ('leader', 'team_lead', 'team_leader', 'team_lead_access', 'team_leader_access', 'approve_team_leave')
            and ur.valid_from <= (now() at time zone 'Asia/Ho_Chi_Minh')::date
            and (ur.valid_to is null or ur.valid_to >= (now() at time zone 'Asia/Ho_Chi_Minh')::date)
        ) as is_leader`;
    if (activeAccess.is_admin) {
      portals.splice(0, portals.length, "admin");
    } else if (activeAccess.is_manager) {
      portals.splice(0, portals.length, "manager");
    } else if (activeAccess.is_leader) {
      portals.splice(0, portals.length, "leader");
    } else {
      portals.splice(0, portals.length, "staff");
    }
    const allowed = portal === "hr"
      ? portals.includes("manager") || portals.includes("leader")
      : portals.includes(portal);
    if (!allowed) {
      return json({ ok: false, error: "forbidden" }, 403);
    }

    const token = await new SignJWT({
      employee_id: portalResult.employee_id,
      username: portalResult.username,
      role: portals.includes("admin") ? "Admin" : "",
    })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime("8h")
      .sign(JWT_KEY);

    try {
      await sql`update public.employee_accounts set pending_notice = null where employee_id = ${portalResult.employee_id}::uuid`;
    } catch (_) {}

    return json({
      ok: true,
      token,
      user: {
        employee_id: portalResult.employee_id,
        username: portalResult.username,
        full_name: portalResult.full_name,
        role: portals.includes("admin") ? "Admin" : "",
      },
      portals,
    });
  }

  let result: LoginResult;
  try {
    const rows = await sql`select public.admin_login(${username}, ${password}) as result`;
    result = (rows[0]?.result ?? { ok: false, error: "invalid_credentials" }) as LoginResult;
  } catch (err) {
    console.error("admin-login: public.admin_login failed", err);
    return json({ ok: false, error: "server_error" }, 500);
  }

  if (result.ok !== true) {
    // Error codes from public.admin_login are passed through unchanged.
    return json({ ok: false, error: result.error ?? "invalid_credentials" }, 401);
  }

  const token = await new SignJWT({
    employee_id: result.employee_id,
    username: result.username,
    role: result.role,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("8h")
    .sign(JWT_KEY);

  try {
    await sql`update public.employee_accounts set pending_notice = null where employee_id = ${result.employee_id}::uuid`;
  } catch (_) {}

  return json({
    ok: true,
    token,
    user: {
      employee_id: result.employee_id,
      username: result.username,
      full_name: result.full_name,
      role: result.role,
    },
  });
});
