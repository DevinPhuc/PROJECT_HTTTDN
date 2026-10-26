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

  // Portal mode: staff/manager sign-in against portal_login, gated by the
  // portals the account may enter. Response keeps the same shape plus portals.
  const portal = typeof body.portal === "string" ? body.portal.trim().toLowerCase() : "";
  if (portal) {
    if (!["staff", "manager"].includes(portal)) {
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
    if (!portals.includes(portal)) {
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
