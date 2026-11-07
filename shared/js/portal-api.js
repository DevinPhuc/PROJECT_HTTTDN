// Shared token plumbing for the staff and manager portals: the same HS256
// session token the admin portal stores, keyed per portal, issued by
// admin-login (portal mode) and verified server-side by each portal's
// edge function. Browsers never touch the tables directly.
(function () {
  function storageKey(portal) {
    return `jewels-portal-token-${portal}`;
  }

  function decodeToken(token) {
    try {
      const segment = String(token).split(".")[1] || "";
      const bytes = Uint8Array.from(atob(segment.replace(/-/g, "+").replace(/_/g, "/")), (char) => char.charCodeAt(0));
      return JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      return null;
    }
  }

  function getSession(portal) {
    try {
      return JSON.parse(localStorage.getItem(storageKey(portal)) || "null");
    } catch {
      return null;
    }
  }

  // Returns the session only if its token decodes and has not expired.
  function validSession(portal) {
    const session = getSession(portal);
    const payload = session?.token ? decodeToken(session.token) : null;
    if (!payload || typeof payload.exp !== "number" || payload.exp * 1000 <= Date.now()) return null;
    return session;
  }

  function saveSession(portal, data) {
    localStorage.setItem(storageKey(portal), JSON.stringify(data));
  }

  function clearSession(portal) {
    localStorage.removeItem(storageKey(portal));
  }

  function requireSession(portal, loginUrl) {
    const session = validSession(portal);
    if (!session) {
      clearSession(portal);
      window.location.replace(loginUrl);
      return null;
    }
    return session;
  }

  function getLoginUrlForRole(role) {
    const norm = String(role || "").trim().toLowerCase();
    if (norm === "admin") return "../admin/login.html";
    if (["manager", "hr_manager", "quản lý", "quản lý nhân sự"].includes(norm)) return "../manager/login.html";
    return "../staff/staff-login.html";
  }

  // All portal data access goes through one edge function per portal.
  // A 401 ends the session and sends the user back to the login page of their active role.
  async function callPortal(portal, name, body, { loginUrl } = {}) {
    const session = validSession(portal);
    const { data, error } = await window.sbInvoke(name, {
      headers: { "x-admin-token": session?.token || "" },
      body,
    });

    if (!error) return { ok: true, status: 200, data };

    if (error.name === "FunctionsHttpError" && error.context) {
      const status = error.context.status;
      let payload = null;
      try {
        payload = await error.context.json();
      } catch {
        payload = null;
      }
      if (status === 401) {
        clearSession(portal);
        let targetUrl = payload?.redirect_url;
        if (!targetUrl && payload?.role) {
          targetUrl = getLoginUrlForRole(payload.role);
        }
        if (!targetUrl) targetUrl = loginUrl;
        if (targetUrl) window.location.replace(targetUrl);
      }
      return { ok: false, status, error: payload?.error || "server_error" };
    }

    return { ok: false, status: 0, error: "network_error" };
  }

  // Sign in through admin-login (portal mode) and store the session.
  async function signIn(portal, credentials) {
    const { data, error } = await window.sbInvoke("admin-login", { body: { ...credentials, portal } });
    let payload = data ?? null;
    if (error) {
      payload = null;
      if (error.name === "FunctionsHttpError" && error.context) {
        try {
          payload = await error.context.json();
        } catch {
          payload = null;
        }
      } else {
        return { error: "network_error" };
      }
    }
    if (!payload?.ok) return { error: payload?.error || "server_error" };
    saveSession(portal, { token: payload.token, user: payload.user, portals: payload.portals });
    try {
      if (window.sb && typeof window.sb.channel === "function" && payload.user?.employee_id) {
        const nowFormatted = new Intl.DateTimeFormat("en-GB", {
          timeZone: "Asia/Ho_Chi_Minh",
          year: "numeric", month: "2-digit", day: "2-digit",
          hour: "2-digit", minute: "2-digit", hour12: false,
        }).format(new Date()).replace(",", "");
        window.sb.channel("portal-activities").send({
          type: "broadcast",
          event: "activity",
          payload: { employee_id: payload.user.employee_id, last_login: nowFormatted }
        });
      }
    } catch (e) {}
    return { user: payload.user, portals: payload.portals || [] };
  }

  window.jewelsPortal = {
    decodeToken,
    getSession,
    validSession,
    saveSession,
    clearSession,
    requireSession,
    callPortal,
    signIn,
    storageKey,
  };
})();
