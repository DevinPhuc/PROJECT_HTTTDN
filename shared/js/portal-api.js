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

  function parseNotice(notice) {
    if (!notice) return null;
    let obj = notice;
    while (typeof obj === "string") {
      try {
        const parsed = JSON.parse(obj);
        if (parsed && typeof parsed === "object") {
          obj = parsed;
        } else {
          break;
        }
      } catch {
        break;
      }
    }
    return obj && typeof obj === "object" ? obj : null;
  }

  let activeNotice = null;

  function showNoticeModal(rawNotice, portal, edgeFunctionName) {
    const notice = parseNotice(rawNotice);
    if (!notice || activeNotice) return;

    const newPassword = String(
      notice.new_password || notice.password || notice.generated_password || ""
    ).trim();
    const roleText = String(notice.new_role || notice.role || "").trim();
    const noticeType = String(notice.type || "").trim();

    // If notice has no password and no role changed, it is invalid/stale.
    // Silently clear it and never block or lock out the user!
    if (!newPassword && !roleText && noticeType !== "account_locked") {
      try {
        const session = getSession(portal);
        if (session?.token && edgeFunctionName) {
          window.sbInvoke(edgeFunctionName, {
            headers: { "x-admin-token": session.token },
            body: { action: "clear_notice" },
          }).catch(() => {});
        }
      } catch (_) {}
      return;
    }

    activeNotice = notice;

    let modal = document.getElementById("passwordChangedModal");
    let titleEl = document.getElementById("passwordChangedTitle");
    let confirmBtn = document.getElementById("confirmPasswordChangeBtn");

    if (!modal) {
      modal = document.createElement("div");
      modal.className = "logout-modal";
      modal.id = "passwordChangedModal";
      modal.setAttribute("role", "dialog");
      modal.setAttribute("aria-modal", "true");
      modal.style.zIndex = "99999";
      modal.innerHTML = `
        <div class="logout-modal-content" style="width: min(100%, 460px); max-width: 460px;">
          <h2 id="passwordChangedTitle" style="font-size: 23px; line-height: 1.4; margin: 0 0 24px; font-weight: 500;"></h2>
          <div class="logout-modal-actions" style="display: flex; justify-content: center;">
            <button
              type="button"
              class="admin-secondary-btn"
              id="confirmPasswordChangeBtn"
              style="min-width: 100px; padding: 8px 24px;"
            >
              Đồng ý
            </button>
          </div>
        </div>`;
      document.body.appendChild(modal);
      titleEl = modal.querySelector("#passwordChangedTitle");
      confirmBtn = modal.querySelector("#confirmPasswordChangeBtn");
    }

    if (modal) {
      modal.style.zIndex = "99999";
    }

    if (noticeType === "account_locked") {
      if (titleEl) {
        titleEl.innerHTML = `Bạn đã bị khóa tài khoản,<br />vui lòng liên hệ với Trưởng nhóm hoặc Quản lý để giải quyết nếu như có sự nhầm lẫn`;
      }
    } else if (noticeType === "role_changed") {
      if (titleEl) {
        titleEl.innerHTML = `Chức vụ bạn đã bị thay đổi,<br />Hiện giờ bạn là ${roleText || "mới"} , Mật khẩu mới của bạn là: <span id="passwordChangedValue" style="color: #278a4b; font-weight: 600;">${newPassword}</span>`;
      }
    } else if (noticeType === "admin_password_changed") {
      if (titleEl) {
        titleEl.innerHTML = `Mật khẩu bạn đã bị thay đổi do cập nhật thông tin mới,<br />Sau đây là mật khẩu mới của bạn: <span id="passwordChangedValue" style="color: #278a4b; font-weight: 600;">${newPassword}</span>`;
      }
    } else {
      if (titleEl) {
        titleEl.innerHTML = `Mật khẩu bạn đã bị thay đổi,<br />Sau đây là mật khẩu mới của bạn: <span id="passwordChangedValue" style="color: #278a4b; font-weight: 600;">${newPassword}</span>`;
      }
    }

    if (modal) {
      const valEl = modal.querySelector("#passwordChangedValue");
      if (valEl && newPassword) {
        valEl.textContent = newPassword;
      }
      modal.hidden = false;
      modal.style.display = "grid";
    }

    // Prevent closing via backdrop click or Escape key
    const stopClose = (e) => {
      e.stopPropagation();
      e.stopImmediatePropagation();
    };
    modal.addEventListener("click", (e) => {
      if (e.target === modal) stopClose(e);
    }, true);

    const onKeydown = (e) => {
      if (e.key === "Escape") {
        stopClose(e);
      }
    };
    window.addEventListener("keydown", onKeydown, true);

    const determineRedirect = () => {
      if (notice.redirect_url) return notice.redirect_url;
      if (notice.type === "role_changed" && notice.new_role) {
        return getLoginUrlForRole(notice.new_role);
      }
      return portal === "manager" ? "../manager/login.html" : "../staff/staff-login.html";
    };

    if (confirmBtn) {
      const newBtn = confirmBtn.cloneNode(true);
      confirmBtn.parentNode.replaceChild(newBtn, confirmBtn);

      newBtn.addEventListener("click", async () => {
        newBtn.disabled = true;
        try {
          const session = getSession(portal);
          if (session?.token && edgeFunctionName) {
            await window.sbInvoke(edgeFunctionName, {
              headers: { "x-admin-token": session.token },
              body: { action: "clear_notice" },
            });
          }
        } catch (_) {}

        window.removeEventListener("keydown", onKeydown, true);

        if (noticeType === "role_changed" || noticeType === "account_locked") {
          clearSession(portal);
          const redirectUrl = determineRedirect();
          const currentPath = window.location.pathname.toLowerCase();
          if (currentPath.endsWith("login.html") || currentPath.endsWith("staff-login.html")) {
            if (modal) {
              modal.hidden = true;
              modal.style.display = "none";
            }
            activeNotice = null;
            newBtn.disabled = false;
          } else {
            window.location.replace(redirectUrl);
          }
        } else {
          // If only password was notified, close modal so user can proceed into dashboard
          if (modal) {
            modal.hidden = true;
            modal.style.display = "none";
          }
          activeNotice = null;
          newBtn.disabled = false;
        }
      });
    }
  }

  // All portal data access goes through one edge function per portal.
  // A 401 ends the session and sends the user back to the login page of their active role.
  async function callPortal(portal, name, body, { loginUrl } = {}) {
    const session = validSession(portal);
    const { data, error } = await window.sbInvoke(name, {
      headers: { "x-admin-token": session?.token || "" },
      body,
    });

    if (!error) {
      if (data && data.pending_notice) {
        showNoticeModal(data.pending_notice, portal, name);
      }
      return { ok: true, status: 200, data };
    }

    if (error.name === "FunctionsHttpError" && error.context) {
      const status = error.context.status;
      let payload = null;
      try {
        payload = await error.context.json();
      } catch {
        payload = null;
      }
      if (payload?.pending_notice) {
        showNoticeModal(payload.pending_notice, portal, name);
        return { ok: false, status, error: payload?.error || "unauthorized" };
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
      return { ok: false, status, error: payload?.error || "server_error", message: payload?.message, detail: payload?.detail };
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
    showNoticeModal,
    signIn,
    storageKey,
  };
})();
