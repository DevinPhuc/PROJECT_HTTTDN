
function isCurrentAdminAccount(account) {
  if (!account) return false;
  const currentEmpId =
    currentSession?.user?.employee_id ||
    decodeToken(currentSession?.token)?.employee_id;
  if (currentEmpId && String(account.employee_id) === String(currentEmpId)) {
    return true;
  }
  const currentEmail = (currentSession?.user?.email || "").trim().toLowerCase();
  const currentUsername = (currentSession?.user?.username || "").trim().toLowerCase();
  const accEmail = (account.email || "").trim().toLowerCase();
  const accUsername = (account.username || "").trim().toLowerCase();
  if (currentEmail && accEmail && currentEmail === accEmail) {
    return true;
  }
  if (currentUsername && (accUsername === currentUsername || accEmail === currentUsername)) {
    return true;
  }
  return false;
}

function formatActivityTime(isoString) {
  if (!isoString) return "—";
  try {
    const d = new Date(isoString);
    if (Number.isNaN(d.getTime())) return isoString;
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Ho_Chi_Minh",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).formatToParts(d);
    const map = {};
    parts.forEach((p) => (map[p.type] = p.value));
    return `${map.day}/${map.month}/${map.year} ${map.hour}:${map.minute}`;
  } catch {
    return isoString;
  }
}

function updateAccountActivityTime(employeeId, newLastLogin) {
  if (!employeeId || !newLastLogin) return;

  // 1. Update in memory state.accounts
  const account = state.accounts.find(
    (item) => String(item.employee_id) === String(employeeId),
  );
  if (account) {
    if (account.last_login === newLastLogin) return;
    account.last_login = newLastLogin;
  }

  // 2. Direct DOM cell update without reloading the page or list
  const row = document.querySelector(
    `#overviewAccounts [data-overview-employee="${CSS.escape(employeeId)}"]`,
  );
  if (row) {
    const cell = row.querySelector(".overview-activity-cell");
    if (cell && cell.textContent.trim() !== newLastLogin) {
      cell.textContent = newLastLogin;
      cell.classList.remove("activity-pulse");
      void cell.offsetWidth; // trigger reflow
      cell.classList.add("activity-pulse");
      window.setTimeout(() => cell.classList.remove("activity-pulse"), 2000);
    }
  }
}

function initRealtimeActivities() {
  if (window.sb && typeof window.sb.channel === "function") {
    try {
      const channel = window.sb.channel("portal-activities");
      channel
        .on("broadcast", { event: "activity" }, (data) => {
          const { employee_id, last_login } = data.payload || {};
          if (employee_id && last_login) {
            updateAccountActivityTime(employee_id, last_login);
          }
        })
        .on(
          "postgres_changes",
          { event: "UPDATE", schema: "public", table: "employee_accounts" },
          (payload) => {
            const newRow = payload.new;
            if (newRow?.employee_id && newRow?.last_login) {
              const formatted = formatActivityTime(newRow.last_login);
              updateAccountActivityTime(newRow.employee_id, formatted);
            }
          },
        )
        .subscribe();
    } catch (err) {
      console.warn("Realtime subscription error:", err);
    }
  }

  // Periodic polling every 2.5s: ensures instant update without reload even if socket reconnects
  setInterval(async () => {
    if (!currentSession) return;
    try {
      const res = await callAdmin({ action: "latest_activities" });
      if (res.ok && Array.isArray(res.data?.activities)) {
        for (const act of res.data.activities) {
          updateAccountActivityTime(act.employee_id, act.last_login);
        }
      }
    } catch (e) {
      // Ignore network errors
    }
  }, 2500);
}

const ADMIN_TOKEN_KEY = "jewels-admin-token";

function getSession() {
  try {
    return JSON.parse(localStorage.getItem(ADMIN_TOKEN_KEY) || "null");
  } catch {
    return null;
  }
}

function getAccountDepartmentName(account) {
  return (
    account.department_name ||
    state.departments.find(
      (department) =>
        String(department.department_id) === String(account.department_id),
    )?.department_name ||
    ""
  );
}

function clearSession() {
  localStorage.removeItem(ADMIN_TOKEN_KEY);
}

function decodeToken(token) {
  try {
    const segment = String(token).split(".")[1] || "";
    const bytes = Uint8Array.from(
      atob(segment.replace(/-/g, "+").replace(/_/g, "/")),
      (char) => char.charCodeAt(0),
    );
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

function requireSession() {
  const session = getSession();
  const payload = session?.token ? decodeToken(session.token) : null;
  if (
    !payload ||
    typeof payload.exp !== "number" ||
    payload.exp * 1000 <= Date.now()
  ) {
    clearSession();
    window.location.replace("login.html");
    return null;
  }
  return session;
}

const currentSession = requireSession();

// Sidebar identity, taken from the session the login function issued out of the database.
function renderProfile() {
  const user = currentSession?.user ?? {};
  const fullName = String(user.full_name || user.username || "");
  const nameEl = document.getElementById("adminName");
  if (nameEl) nameEl.textContent = fullName || "Quản trị viên";
  const roleEl = document.getElementById("adminRole");
  if (roleEl) roleEl.textContent = user.role || "";
  const avatar = document.getElementById("adminAvatar");
  if (avatar) {
    avatar.textContent = fullName
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((part) => part[0] || "")
      .join("")
      .toUpperCase();
  }
}

const state = {
  accounts: [],
  accountsLoading: false,
  accountsError: "",
  options: null,
  roles: [],
  permissions: [],
  staff: [],
  departments: [],
  accountsPage: 1,
  accountsPageSize: 10,
  accountSort: { key: "", direction: 1 },
  overviewAccountsPage: 1,
  overviewAccountsPageSize: 10,
  overviewStaffPage: 1,
  overviewStaffPageSize: 10,
  staffPage: 1,
  staffPageSize: 10,
};

const ACCOUNT_ERRORS = {
  missing_fields: "Vui lòng nhập đầy đủ thông tin bắt buộc.",
  invalid_email: "Email không hợp lệ.",
  invalid_date_of_birth: "Ngày sinh không hợp lệ.",
  invalid_hire_date: "Ngày vào làm không hợp lệ.",
  invalid_reference: "Phòng ban, vị trí hoặc vai trò không hợp lệ.",
  under_min_age: "Ngày vào làm phải cách ngày sinh ít nhất 15 năm.",
  unknown_department: "Không tìm thấy phòng ban.",
  unknown_role: "Không tìm thấy vai trò.",
  invalid_role: "Vai trò không hợp lệ.",
  forbidden_self_role_change: "Bạn không thể tự cập nhật vai trò của chính mình.",
  forbidden_admin_role_change: "Không thể thay đổi vai trò của tài khoản Admin.",
  cannot_create_admin: "Chỉ cho phép duy nhất một tài khoản vai trò Admin.",
  role_name_reserved: 'Không thể dùng tên vai trò "Admin".',
  position_department_mismatch: "Vị trí không thuộc phòng ban đã chọn.",
  invalid_phone: "Số điện thoại phải gồm đúng 10 chữ số.",
  duplicate: "Email hoặc mã nhân viên đã tồn tại.",
  check_violation: "Dữ liệu không hợp lệ.",
  role_overlap: "Không thể đổi vai trò do trùng khoảng thời gian hiệu lực.",
  not_found: "Không tìm thấy tài khoản.",
  account_not_found: "Không tìm thấy tài khoản đăng nhập.",
  unauthorized: "Phiên đăng nhập đã hết hạn.",
  network_error: "Không thể kết nối máy chủ. Vui lòng thử lại sau.",
  server_error: "Máy chủ gặp lỗi. Vui lòng thử lại sau.",
  server_not_configured: "Máy chủ chưa được cấu hình.",
};

function accountErrorMessage(code) {
  return ACCOUNT_ERRORS[code] || "Đã xảy ra lỗi. Vui lòng thử lại.";
}

function escapeHtml(value) {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (char) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[char],
  );
}

// Date inputs and the API both use yyyy-mm-dd.
function toDisplayDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value || "") ? value : value || "";
}

function toIsoDate(value) {
  const iso = String(value || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return "";
  const date = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== iso
    ? ""
    : iso;
}

function getLocalDateIso(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function getDateInputLimits() {
  const today = new Date();
  const dateOfBirthLimit = new Date(today);
  dateOfBirthLimit.setFullYear(today.getFullYear() - 18);
  return {
    dateOfBirth: getLocalDateIso(dateOfBirthLimit),
    hireDate: getLocalDateIso(today),
  };
}

function updateAccountDateLimits() {
  const form = document.getElementById("accountForm");
  if (!form) return;
  const limits = getDateInputLimits();
  form.elements.date_of_birth.max = limits.dateOfBirth;
  form.elements.hire_date.max = limits.hireDate;
}

function getStatusClass(status) {
  const lower = String(status || "").toLowerCase();
  if (["hoạt động", "làm việc"].some((value) => lower.includes(value)))
    return "status-online";
  if (["chờ duyệt"].some((value) => lower.includes(value)))
    return "status-progress";
  return "status-away";
}

function accountStatusLabel(isActive) {
  return isActive ? "Hoạt động" : "Khóa";
}

// A soft-deleted account stays in the list, so it needs its own label.
function accountStatusText(account) {
  return account.deleted_at ? "Đã xóa" : accountStatusLabel(account.is_active);
}

let toastTimeouts = {};
function showAccountSuccessToast() {
  showAccountToast("accountSuccessToast");
}

function showAccountUpdateToast() {
  showAccountToast("accountUpdateToast");
}

function showAccountDeleteToast() {
  showAccountToast("accountDeleteToast");
}

function showAccountToast(id) {
  const toast = document.getElementById(id);
  if (!toast) return;
  if (toastTimeouts[id]) {
    clearTimeout(toastTimeouts[id]);
  }
  toast.classList.add("show");
  toastTimeouts[id] = window.setTimeout(() => {
    toast.classList.remove("show");
    delete toastTimeouts[id];
  }, 5000);
}

function confirmPermanentAccountDelete() {
  const modal = document.getElementById("permanentDeleteModal");
  if (!modal) return Promise.resolve(false);
  modal.hidden = false;
  return new Promise((resolve) => {
    const finish = (confirmed) => {
      modal.hidden = true;
      resolve(confirmed);
    };
    modal.querySelector("[data-permanent-delete-cancel]").onclick = () =>
      finish(false);
    modal.querySelector("[data-permanent-delete-confirm]").onclick = () =>
      finish(true);
  });
}

function iconSprite(name) {
  return `<svg aria-hidden="true"><use href="#admin-icon-${name}"></use></svg>`;
}

function buildRowHeader(columns) {
  return `
    <div class="admin-row admin-row-header">
      ${columns.map((column) => `<span>${column}</span>`).join("")}
    </div>
  `;
}

function setModule(moduleName) {
  document.querySelectorAll(".admin-module").forEach((module) => {
    const active = module.dataset.module === moduleName;
    module.hidden = !active;
    module.classList.toggle("active", active);
  });

  document.querySelectorAll(".admin-nav-item").forEach((item) => {
    const active = item.getAttribute("href") === `#${moduleName}`;
    item.classList.toggle("is-active", active);
  });
}

function bindModuleNavigation() {
  document.querySelectorAll(".admin-nav-item").forEach((item) => {
    item.addEventListener("click", (event) => {
      event.preventDefault();
      const target = item.getAttribute("href").replace("#", "");
      setModule(target);
      window.location.hash = `#${target}`;
    });
  });
}

function resetForm(formId) {
  const form = document.getElementById(formId);
  if (!form) return;
  form.reset();
  const idField = form.querySelector(
    'input[name="employee_id"], input[name="id"], input[name="role_id"]',
  );
  if (idField) idField.value = "";
}

async function callAdmin(body) {
  const { data, error } = await window.sbInvoke("admin-accounts", {
    headers: { "x-admin-token": currentSession?.token || "" },
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
      clearSession();
      const redirectUrl = payload?.redirect_url || "login.html";
      window.location.replace(redirectUrl);
    }
    return { ok: false, status, error: payload?.error || "server_error" };
  }

  return { ok: false, status: 0, error: "network_error" };
}

async function loadAccounts() {
  state.accountsLoading = true;
  state.accountsError = "";
  renderTables();

  const response = await callAdmin({ action: "list" });
  state.accountsLoading = false;

  if (!response.ok) {
    if (response.status === 401) return;
    state.accountsError = accountErrorMessage(response.error);
    renderTables();
    return;
  }

  state.accounts = Array.isArray(response.data?.accounts)
    ? response.data.accounts
    : [];
  renderTables();
}

// One call for the whole dashboard boot (accounts, staff, roles, permissions).
async function loadInitialData() {
  state.accountsLoading = true;
  state.accountsError = "";
  renderTables();

  const response = await callAdmin({ action: "init" });
  state.accountsLoading = false;

  if (!response.ok) {
    if (response.status === 401) return;
    state.accountsError = accountErrorMessage(response.error);
    renderTables();
    return;
  }

  state.accounts = Array.isArray(response.data?.accounts)
    ? response.data.accounts
    : [];
  state.staff = Array.isArray(response.data?.staff) ? response.data.staff : [];
  state.roles = Array.isArray(response.data?.roles) ? response.data.roles : [];
  state.permissions = Array.isArray(response.data?.permissions)
    ? response.data.permissions
    : [];
  state.departments = Array.isArray(response.data?.departments)
    ? response.data.departments
    : [];
  renderTables();
}

async function refreshAccountData(button) {
  if (state.accountsLoading) return;
  const btn = button || document.getElementById("accountRefreshBtn");
  if (btn) {
    btn.disabled = true;
    btn.classList.add("is-loading");
  }
  try {
    await loadInitialData();
    showAccountToast("refreshToast");
  } catch (err) {
    console.error("Refresh failed", err);
  } finally {
    if (btn) {
      btn.classList.remove("is-loading");
      btn.disabled = false;
    }
  }
}

async function loadOptions() {
  if (state.options) return state.options;

  const response = await callAdmin({ action: "options" });
  if (!response.ok) {
    if (response.status !== 401) {
      state.accountsError = accountErrorMessage(response.error);
      renderTables();
    }
    return null;
  }

  state.options = response.data;
  return state.options;
}

function renderOverviewBlocks() {
  const overviewAccounts = document.getElementById("overviewAccounts");
  const activeAccounts = state.accounts.filter(
    (item) => !item.deleted_at && item.is_active && !isCurrentAdminAccount(item),
  );
  if (overviewAccounts) {
    const totalPages = Math.max(
      1,
      Math.ceil(activeAccounts.length / state.overviewAccountsPageSize),
    );
    state.overviewAccountsPage = Math.min(
      state.overviewAccountsPage,
      totalPages,
    );
    const start =
      (state.overviewAccountsPage - 1) * state.overviewAccountsPageSize;
    const rows = activeAccounts.slice(
      start,
      start + state.overviewAccountsPageSize,
    );
    overviewAccounts.innerHTML =
      buildRowHeader(["Người dùng", "Vai trò", "Trạng thái", "Hoạt động"]) +
      rows
        .map(
          (item) => `
      <div class="admin-row">
        <span>${escapeHtml(item.full_name)}</span>
        <span>${escapeHtml(item.role_name || "—")}</span>
        <span><em class="${getStatusClass(accountStatusText(item))}">${escapeHtml(accountStatusText(item))}</em></span>
        <span>${escapeHtml(item.last_login || "—")}</span>
      </div>
    `,
        )
        .join("");
    renderOverviewAccountsPagination(
      activeAccounts.length,
      start + 1,
      start + rows.length,
      totalPages,
    );
  }

  const overviewAccountsCount = document.getElementById(
    "overviewAccountsCount",
  );
  if (overviewAccountsCount)
    overviewAccountsCount.textContent = `${activeAccounts.length} tài khoản`;

  const overviewStaff = document.getElementById("overviewStaff");
  if (overviewStaff) {
    const totalPages = Math.max(
      1,
      Math.ceil(state.staff.length / state.overviewStaffPageSize),
    );
    state.overviewStaffPage = Math.min(state.overviewStaffPage, totalPages);
    const start = (state.overviewStaffPage - 1) * state.overviewStaffPageSize;
    const rows = state.staff.slice(start, start + state.overviewStaffPageSize);
    overviewStaff.innerHTML = rows
      .map(
        (item) => `
      <div class="mini-row">
        <span>${escapeHtml(item.full_name)}</span>
        <strong>${escapeHtml(item.position_title)}</strong>
      </div>
    `,
      )
      .join("");
    renderOverviewStaffPagination(
      state.staff.length,
      start + 1,
      start + rows.length,
      totalPages,
    );
  }

  function renderOverviewAccountsPagination(total, first, last, totalPages) {
    const pagination = document.getElementById("overviewAccountsPagination");
    if (!pagination) return;
    const pageButtons = Array.from({ length: totalPages }, (_, index) => {
      const page = index + 1;
      return `<button type="button" class="page-btn ${page === state.overviewAccountsPage ? "is-active" : ""}" data-overview-page="${page}" aria-label="Trang ${page}" aria-current="${page === state.overviewAccountsPage ? "page" : "false"}">${page}</button>`;
    }).join("");
    pagination.innerHTML = `
      <span class="pagination-summary">Hiển thị ${total ? `${first}–${last}` : "0"} / ${total} tài khoản</span>
      <div class="account-page-actions">
        <label class="page-size-label">Số dòng/trang
          <select id="overviewAccountsPageSize" aria-label="Số dòng mỗi trang của tổng quan">
            ${[10, 20, 50].map((size) => `<option value="${size}" ${size === state.overviewAccountsPageSize ? "selected" : ""}>${size}</option>`).join("")}
          </select>
        </label>
        <div class="page-controls">
          <button type="button" class="page-btn" data-overview-page="${Math.max(1, state.overviewAccountsPage - 1)}" ${state.overviewAccountsPage === 1 ? "disabled" : ""} aria-label="Trang trước">‹</button>
          ${pageButtons}
          <button type="button" class="page-btn" data-overview-page="${Math.min(totalPages, state.overviewAccountsPage + 1)}" ${state.overviewAccountsPage === totalPages ? "disabled" : ""} aria-label="Trang sau">›</button>
        </div>
      </div>`;
  }

  const overviewStaffCount = document.getElementById("overviewStaffCount");
  if (overviewStaffCount)
    overviewStaffCount.textContent = `${state.staff.length} người`;
}

function renderOverviewStaffPagination(total, first, last, totalPages) {
  const pagination = document.getElementById("overviewStaffPagination");
  if (!pagination) return;
  const pageButtons = Array.from({ length: totalPages }, (_, index) => {
    const page = index + 1;
    return `<button type="button" class="page-btn ${page === state.overviewStaffPage ? "is-active" : ""}" data-overview-staff-page="${page}" aria-label="Trang ${page}" aria-current="${page === state.overviewStaffPage ? "page" : "false"}">${page}</button>`;
  }).join("");
  pagination.innerHTML = `
    <span class="pagination-summary">Hiển thị ${total ? `${first}–${last}` : "0"} / ${total} nhân viên</span>
    <div class="account-page-actions">
      <label class="page-size-label">Số dòng/trang
        <select id="overviewStaffPageSize" aria-label="Số dòng mỗi trang của danh sách nhân sự">
          ${[10, 20, 50].map((size) => `<option value="${size}" ${size === state.overviewStaffPageSize ? "selected" : ""}>${size}</option>`).join("")}
        </select>
      </label>
      <div class="page-controls">
        <button type="button" class="page-btn" data-overview-staff-page="${Math.max(1, state.overviewStaffPage - 1)}" ${state.overviewStaffPage === 1 ? "disabled" : ""} aria-label="Trang trước">‹</button>
        ${pageButtons}
        <button type="button" class="page-btn" data-overview-staff-page="${Math.min(totalPages, state.overviewStaffPage + 1)}" ${state.overviewStaffPage === totalPages ? "disabled" : ""} aria-label="Trang sau">›</button>
      </div>
    </div>`;
}

function renderAccountsTable() {
  const table = document.getElementById("accountsTable");
  if (!table) return;
  updateAccountFilterOptions();

  if (state.accountsLoading) {
    table.innerHTML =
      '<div class="admin-row"><span style="grid-column:1/-1">Đang tải danh sách tài khoản…</span></div>';
    return;
  }

  if (state.accountsError) {
    table.innerHTML = `<div class="admin-row"><span style="grid-column:1/-1">${escapeHtml(state.accountsError)}</span></div>`;
    return;
  }

  const search = document.getElementById("accountSearch");
  const department =
    document.getElementById("accountDepartmentFilter")?.value || "";
  const statusFilter =
    document.getElementById("accountStatusFilter")?.value || "";
  const role = document.getElementById("accountRoleFilter")?.value || "";
  const term = (search?.value || "").trim().toLowerCase();
  const filteredRows = state.accounts.filter((item) => {
    if (isCurrentAdminAccount(item)) return false;
    const searchable = [
      item.employee_code,
      item.full_name,
      item.email,
      getAccountDepartmentName(item),
      item.position_title,
      item.role_name,
    ]
      .join(" ")
      .toLowerCase();
    const status = item.deleted_at
      ? "deleted"
      : item.is_active
        ? "active"
        : "inactive";
    return (
      (!term || searchable.includes(term)) &&
      (!department || String(item.department_id) === department) &&
      (!statusFilter || status === statusFilter) &&
      (!role || String(item.role_id) === role)
    );
  });
  const sortKey = state.accountSort.key;
  if (sortKey) {
    filteredRows.sort((left, right) => {
      const leftValue = String(
        accountSortValue(left, sortKey) ?? "",
      ).toLocaleLowerCase("vi");
      const rightValue = String(
        accountSortValue(right, sortKey) ?? "",
      ).toLocaleLowerCase("vi");
      return (
        leftValue.localeCompare(rightValue, "vi", {
          numeric: true,
          sensitivity: "base",
        }) * state.accountSort.direction
      );
    });
  }
  const totalPages = Math.max(
    1,
    Math.ceil(filteredRows.length / state.accountsPageSize),
  );
  state.accountsPage = Math.min(state.accountsPage, totalPages);
  const start = (state.accountsPage - 1) * state.accountsPageSize;
  const rows = filteredRows.slice(start, start + state.accountsPageSize);

  if (!rows.length) {
    const message =
      term || department || statusFilter || role
        ? "Không tìm thấy tài khoản phù hợp."
        : "Chưa có tài khoản nào.";
    table.innerHTML = `<div class="admin-row"><span style="grid-column:1/-1">${message}</span></div>`;
    renderAccountPagination(0, 0, 0);
    return;
  }

  table.innerHTML =
    `<div class="admin-row admin-row-header account-sort-header">
      ${[
        ["employee_code", "Mã nhân viên"],
        ["full_name", "Nhân sự"],
        ["department_name", "Phòng ban"],
        ["hire_date", "Ngày vào làm"],
        ["role_name", "Vai trò"],
        ["status", "Trạng thái"],
      ]
        .map(
          ([key, label]) =>
            `<button type="button" class="account-sort-button ${state.accountSort.key === key ? (state.accountSort.direction === 1 ? "is-ascending" : "is-descending") : ""}" data-account-sort="${key}">${label}</button>`,
        )
        .join("")}
      <span>Thao tác</span>
    </div>` +
    rows
      .map((item) => {
        const status = accountStatusText(item);
        const actions = item.deleted_at
          ? `<button type="button" class="mini-btn icon-btn" data-restore="${escapeHtml(item.employee_id)}" title="Khôi phục tài khoản" aria-label="Khôi phục tài khoản">${iconSprite("restore")}</button>
        <button type="button" class="mini-btn icon-btn danger" data-permanent-delete="${escapeHtml(item.employee_id)}" title="Xóa vĩnh viễn" aria-label="Xóa vĩnh viễn">${iconSprite("delete")}</button>`
          : `
        <button type="button" class="mini-btn icon-btn" data-toggle-lock="${escapeHtml(item.employee_id)}"
          title="${item.is_active ? "Khóa tài khoản" : "Mở khóa tài khoản"}"
          aria-label="${item.is_active ? "Khóa tài khoản" : "Mở khóa tài khoản"}">
          ${iconSprite(item.is_active ? "lock" : "unlock")}
        </button>
        <button type="button" class="mini-btn icon-btn danger" data-delete="accounts" data-id="${escapeHtml(item.employee_id)}" title="Xóa" aria-label="Xóa">
          ${iconSprite("delete")}
        </button>`;

        return `
    <div class="admin-row account-row ${item.deleted_at || !item.is_active ? "account-row-disabled" : ""}" data-account-row="${escapeHtml(item.employee_id)}" ${item.deleted_at || !item.is_active ? "" : 'tabindex="0" role="button"'} aria-label="${item.deleted_at || !item.is_active ? "Tài khoản không khả dụng" : `Xem thông tin ${escapeHtml(item.full_name)}`}">
      <span>${escapeHtml(item.employee_code || "—")}</span>
      <span class="account-person"><strong>${escapeHtml(item.full_name)}</strong><small>${escapeHtml(item.email)}</small></span>
      <span>${escapeHtml(getAccountDepartmentName(item) || "—")}</span>
      <span>${escapeHtml(item.hire_date || "—")}</span>
      <span>${escapeHtml(item.role_name || "—")}</span>
      <span><em class="${getStatusClass(status)}">${escapeHtml(status)}</em></span>
      <span class="table-actions">${actions}</span>
    </div>`;
      })
      .join("");
  renderAccountPagination(
    filteredRows.length,
    start + 1,
    start + rows.length,
    totalPages,
  );
}

function accountSortValue(account, key) {
  if (key === "department_name") return getAccountDepartmentName(account);
  if (key === "status") return accountStatusText(account);
  return account[key];
}

function updateAccountFilterOptions() {
  const departmentSelect = document.getElementById("accountDepartmentFilter");
  const roleSelect = document.getElementById("accountRoleFilter");
  if (departmentSelect) {
    const selected = departmentSelect.value;
    const departments = state.departments.map((item) => [
      String(item.department_id),
      item.department_name,
    ]);

    departments.sort((a, b) => a[1].localeCompare(b[1], "vi"));
    departmentSelect.innerHTML =
      '<option value="">Tất cả phòng ban</option>' +
      departments
        .map(
          ([id, name]) =>
            `<option value="${escapeHtml(id)}">${escapeHtml(name)}</option>`,
        )
        .join("");
    departmentSelect.value = departments.some(([id]) => id === selected)
      ? selected
      : "";
  }
  if (roleSelect) {
    const selected = roleSelect.value;
    const roles = [
      ...new Map(
        state.accounts
          .filter((item) => item.role_id)
          .map((item) => [
            String(item.role_id),
            item.role_name || "Chưa có vai trò",
          ]),
      ).entries(),
    ].sort((a, b) => a[1].localeCompare(b[1], "vi"));
    roleSelect.innerHTML =
      '<option value="">Tất cả vai trò</option>' +
      roles
        .map(
          ([id, name]) =>
            `<option value="${escapeHtml(id)}">${escapeHtml(name)}</option>`,
        )
        .join("");
    roleSelect.value = roles.some(([id]) => id === selected) ? selected : "";
  }
}

function renderAccountPagination(total, first, last, totalPages) {
  const pagination = document.getElementById("accountPagination");
  if (!pagination) return;
  const pageButtons = Array.from({ length: totalPages }, (_, index) => {
    const page = index + 1;
    return `<button type="button" class="page-btn ${page === state.accountsPage ? "is-active" : ""}" data-account-page="${page}" aria-label="Trang ${page}" aria-current="${page === state.accountsPage ? "page" : "false"}">${page}</button>`;
  }).join("");
  pagination.innerHTML = `
    <span class="pagination-summary">Hiển thị ${total ? `${first}–${last}` : "0"} / ${total} tài khoản</span>
    <div class="account-page-actions">
      <label class="page-size-label">Số dòng/trang
        <select id="accountPageSize" aria-label="Số dòng mỗi trang">
          ${[10, 20, 50].map((size) => `<option value="${size}" ${size === state.accountsPageSize ? "selected" : ""}>${size}</option>`).join("")}
        </select>
      </label>
      <div class="page-controls">
        <button type="button" class="page-btn" data-account-page="${Math.max(1, state.accountsPage - 1)}" ${state.accountsPage === 1 ? "disabled" : ""} aria-label="Trang trước">‹</button>
        ${pageButtons}
        <button type="button" class="page-btn" data-account-page="${Math.min(totalPages, state.accountsPage + 1)}" ${state.accountsPage === totalPages ? "disabled" : ""} aria-label="Trang sau">›</button>
      </div>
    </div>`;
}

function roleSelectHtml(account) {
  const isSelf = String(account.employee_id) === String(currentSession?.user?.employee_id);
  if (account.role_name === "Admin" || isSelf) {
    return `<select class="role-select" disabled><option value="">${escapeHtml(account.role_name || "Admin")}</option></select>`;
  }
  const options = ['<option value="">— Chọn vai trò —</option>'].concat(
    state.roles
      .filter((role) => String(role.role_name).toLowerCase() !== "admin")
      .map(
        (role) =>
          `<option value="${escapeHtml(role.role_id)}" ${String(role.role_id) === String(account.role_id) ? "selected" : ""}>${escapeHtml(role.role_name)}</option>`,
      ),
  );
  return `<select class="role-select" data-employee="${escapeHtml(account.employee_id)}">${options.join("")}</select>`;
}

function renderStaffTable() {
  const table = document.getElementById("staffTable");
  if (!table) return;

  if (state.accountsLoading) {
    table.innerHTML =
      '<div class="admin-row"><span style="grid-column:1/-1">Đang tải danh sách nhân viên…</span></div>';
    return;
  }

  if (state.accountsError) {
    table.innerHTML = `<div class="admin-row"><span style="grid-column:1/-1">${escapeHtml(state.accountsError)}</span></div>`;
    return;
  }

  const search = document.getElementById("staffSearch");
  const term = (search?.value || "").trim().toLowerCase();
  const filteredRows = state.accounts.filter((item) =>
    !isCurrentAdminAccount(item) && [item.full_name, item.email].join(" ").toLowerCase().includes(term),
  );
  const totalPages = Math.max(
    1,
    Math.ceil(filteredRows.length / state.staffPageSize),
  );
  state.staffPage = Math.min(state.staffPage, totalPages);
  const start = (state.staffPage - 1) * state.staffPageSize;
  const rows = filteredRows.slice(start, start + state.staffPageSize);

  if (!rows.length) {
    const message = term
      ? "Không tìm thấy nhân viên phù hợp."
      : "Chưa có nhân viên nào.";
    table.innerHTML = `<div class="admin-row"><span style="grid-column:1/-1">${message}</span></div>`;
    renderStaffPagination(0, 0, 0, 0);
    return;
  }

  table.innerHTML =
    buildRowHeader(["Họ tên", "Email", "Vai trò", "Hành động"]) +
    rows
      .map(
        (item) => `
    <div class="admin-row staff-row">
      <span>${escapeHtml(item.full_name)}</span>
      <span>${escapeHtml(item.email)}</span>
      <span>${roleSelectHtml(item)}</span>
      <span class="table-actions">
        <button type="button" class="mini-btn" data-assign-role="${escapeHtml(item.employee_id)}" ${item.role_name === "Admin" || String(item.employee_id) === String(currentSession?.user?.employee_id) ? "disabled" : ""}>Lưu</button>
      </span>
    </div>
  `,
      )
      .join("");
  renderStaffPagination(
    filteredRows.length,
    start + 1,
    start + rows.length,
    totalPages,
  );
}

function renderStaffPagination(total, first, last, totalPages) {
  const pagination = document.getElementById("staffPagination");
  if (!pagination) return;
  const pageButtons = Array.from({ length: totalPages }, (_, index) => {
    const page = index + 1;
    return `<button type="button" class="page-btn ${page === state.staffPage ? "is-active" : ""}" data-staff-page="${page}" aria-label="Trang ${page}" aria-current="${page === state.staffPage ? "page" : "false"}">${page}</button>`;
  }).join("");
  pagination.innerHTML = `
    <span class="pagination-summary">Hiển thị ${total ? `${first}–${last}` : "0"} / ${total} nhân viên</span>
    <div class="account-page-actions">
      <label class="page-size-label">Số dòng/trang
        <select id="staffPageSize" aria-label="Số dòng mỗi trang của danh sách nhân sự">
          ${[10, 20, 50].map((size) => `<option value="${size}" ${size === state.staffPageSize ? "selected" : ""}>${size}</option>`).join("")}
        </select>
      </label>
      <div class="page-controls">
        <button type="button" class="page-btn" data-staff-page="${Math.max(1, state.staffPage - 1)}" ${state.staffPage === 1 ? "disabled" : ""} aria-label="Trang trước">‹</button>
        ${pageButtons}
        <button type="button" class="page-btn" data-staff-page="${Math.min(totalPages, state.staffPage + 1)}" ${state.staffPage === totalPages ? "disabled" : ""} aria-label="Trang sau">›</button>
      </div>
    </div>`;
}

function renderTables() {
  renderOverviewBlocks();
  renderAccountsTable();
  renderStaffTable();
  renderRoleCards();
}

function attachTableSearch() {
  ["accountSearch", "staffSearch"].forEach((inputId) => {
    const input = document.getElementById(inputId);
    if (!input) return;
    input.addEventListener("input", () => {
      if (inputId === "staffSearch") state.staffPage = 1;
      else state.accountsPage = 1;
      renderTables();
    });
  });
  [
    "accountDepartmentFilter",
    "accountStatusFilter",
    "accountRoleFilter",
  ].forEach((id) => {
    document.getElementById(id)?.addEventListener("change", () => {
      state.accountsPage = 1;
      renderAccountsTable();
    });
  });
  document
    .getElementById("accountAdvancedToggle")
    ?.addEventListener("click", (event) => {
      const button = event.currentTarget;
      const panel = document.getElementById("accountFilterPanel");
      const expanded = button.getAttribute("aria-expanded") === "true";
      panel.hidden = expanded;
      button.setAttribute("aria-expanded", String(!expanded));
    });
  document
    .getElementById("accountClearFilters")
    ?.addEventListener("click", () => {
      document.getElementById("accountSearch").value = "";
      [
        "accountDepartmentFilter",
        "accountStatusFilter",
        "accountRoleFilter",
      ].forEach((id) => {
        document.getElementById(id).value = "";
      });
      state.accountsPage = 1;
      renderAccountsTable();
    });
  document
    .getElementById("accountPagination")
    ?.addEventListener("click", (event) => {
      const button = event.target.closest("[data-account-page]");
      if (!button || button.disabled) return;
      state.accountsPage = Number(button.dataset.accountPage);
      renderAccountsTable();
    });
  document
    .getElementById("staffPagination")
    ?.addEventListener("click", (event) => {
      const button = event.target.closest("[data-staff-page]");
      if (!button || button.disabled) return;
      state.staffPage = Number(button.dataset.staffPage);
      renderStaffTable();
    });
  document
    .getElementById("staffPagination")
    ?.addEventListener("change", (event) => {
      if (event.target.id !== "staffPageSize") return;
      state.staffPageSize = Number(event.target.value) || 10;
      state.staffPage = 1;
      renderStaffTable();
    });
  document
    .getElementById("accountPagination")
    ?.addEventListener("change", (event) => {
      if (event.target.id !== "accountPageSize") return;
      state.accountsPageSize = Number(event.target.value) || 10;
      state.accountsPage = 1;
      renderAccountsTable();
    });
  document
    .getElementById("overviewAccountsPagination")
    ?.addEventListener("click", (event) => {
      const button = event.target.closest("[data-overview-page]");
      if (!button || button.disabled) return;
      state.overviewAccountsPage = Number(button.dataset.overviewPage);
      renderOverviewBlocks();
    });
  document
    .getElementById("overviewAccountsPagination")
    ?.addEventListener("change", (event) => {
      if (event.target.id !== "overviewAccountsPageSize") return;
      state.overviewAccountsPageSize = Number(event.target.value) || 10;
      state.overviewAccountsPage = 1;
      renderOverviewBlocks();
    });
  document
    .getElementById("overviewStaffPagination")
    ?.addEventListener("click", (event) => {
      const button = event.target.closest("[data-overview-staff-page]");
      if (!button || button.disabled) return;
      state.overviewStaffPage = Number(button.dataset.overviewStaffPage);
      renderOverviewBlocks();
    });
  document
    .getElementById("overviewStaffPagination")
    ?.addEventListener("change", (event) => {
      if (event.target.id !== "overviewStaffPageSize") return;
      state.overviewStaffPageSize = Number(event.target.value) || 10;
      state.overviewStaffPage = 1;
      renderOverviewBlocks();
    });
}

function fillSelectOptions(select, items, valueKey, labelKey, placeholder) {
  if (!select) return;
  select.replaceChildren();
  if (placeholder) select.append(new Option(placeholder, ""));
  items.forEach((item) => {
    const option = new Option(item[labelKey], item[valueKey]);
    if (item.description != null) {
      option.setAttribute("data-description", String(item.description));
    }
    select.append(option);
  });
}

function renderPositionOptions(departmentId, selectedPositionId) {
  const form = document.getElementById("accountForm");
  if (!form) return;
  const positions = (state.options?.positions || []).filter((item) => {
    if (!departmentId) return true;
    return (item.department_ids || []).some(
      (id) => String(id) === String(departmentId),
    );
  });
  fillSelectOptions(
    form.elements.position_id,
    positions,
    "position_id",
    "position_title",
    "Chọn vị trí",
  );
  form.elements.position_id.value = selectedPositionId || "";
}

function renderDepartmentOptions(positionId, selectedDepartmentId) {
  const form = document.getElementById("accountForm");
  if (!form) return;
  const departments = state.options?.departments || [];
  fillSelectOptions(
    form.elements.department_id,
    departments,
    "department_id",
    "department_name",
    "Chọn phòng ban",
  );
  if (
    selectedDepartmentId &&
    departments.some((item) => String(item.department_id) === String(selectedDepartmentId))
  ) {
    form.elements.department_id.value = selectedDepartmentId;
  } else if (positionId) {
    const selectedPosition = (state.options?.positions || []).find(
      (item) => String(item.position_id) === String(positionId),
    );
    const departmentIds = (selectedPosition?.department_ids || []).map((id) => String(id));
    if (departmentIds.length > 0 && !departmentIds.includes(String(form.elements.department_id.value))) {
      form.elements.department_id.value = departmentIds[0];
    }
  }
}

// The role is assigned separately in the "Vai trò & Quyền" section.
function fillAccountOptions(account) {
  const form = document.getElementById("accountForm");
  if (!form || !state.options) return;
  fillSelectOptions(
    form.elements.department_id,
    state.options.departments || [],
    "department_id",
    "department_name",
    "Chọn phòng ban",
  );
  if (account?.department_id)
    form.elements.department_id.value = account.department_id;
  renderPositionOptions(
    account?.department_id || "",
    account?.position_id || "",
  );
}

function showAccountForm() {
  const form = document.getElementById("accountForm");
  if (!form) return;
  form.hidden = false;
  const firstField = form.querySelector("input:not([type='hidden']), select");
  firstField?.focus();
}

function abbreviatePosition(positionName) {
  const role = String(positionName || "")
    .trim()
    .toLowerCase();
  if (role === "admin") return "AD";
  if (role === "nhân viên") return "NV";
  if (role === "quản lý") return "QL";
  if (role === "trưởng nhóm") return "TN";

  const normalized = String(positionName || "")
    .trim()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\u0111/g, "d")
    .replace(/\u0110/g, "D");
  const words = normalized.split(/\s+/).filter(Boolean);
  return words.length > 1
    ? words
        .slice(0, 2)
        .map((word) => word[0])
        .join("")
        .toUpperCase()
    : normalized.slice(0, 2).toUpperCase();
}

function generateAccountPassword(roleName, departmentDescription, dateOfBirth) {
  const positionPrefix = abbreviatePosition(roleName);
  const departmentPrefix = String(departmentDescription || "")
    .trim()
    .slice(0, 3)
    .toLowerCase();
  const [year, month, day] = String(dateOfBirth || "").split("-");

  if (
    positionPrefix.length < 2 ||
    !departmentPrefix ||
    !/^\d{4}$/.test(year || "") ||
    !/^\d{2}$/.test(month || "") ||
    !/^\d{2}$/.test(day || "")
  ) {
    return "";
  }

  return `${positionPrefix}${departmentPrefix}@${day}${month}${year}`;
}

function updateGeneratedPassword() {
  const form = document.getElementById("accountForm");
  if (!form) return;

  const roleOption = form.elements.role_id.selectedOptions[0];
  const role = roleOption?.value ? roleOption.textContent : "";

  const departmentId = form.elements.department_id.value;

  const department = (state.options?.departments || []).find(
    (d) => String(d.department_id) === String(departmentId),
  );
  const departmentDescription = department?.description || "";

  const dateOfBirth = toIsoDate(form.elements.date_of_birth.value);

  const passwordInput = form.elements.generated_password;
  if (!passwordInput) return;

  passwordInput.value = generateAccountPassword(
    role,
    departmentDescription,
    dateOfBirth,
  );
}

function employeeCodePrefix(roleName) {
  const normalized = String(roleName || "")
    .trim()
    .toLowerCase();
  if (normalized === "admin") return "AD";
  if (normalized === "quản lý") return "QL";
  if (normalized === "trưởng nhóm") return "TN";
  return "NV";
}

function updateGeneratedEmployeeCode() {
  const form = document.getElementById("accountForm");
  if (!form || form.elements.employee_id.value) return;
  const roleName =
    form.elements.role_id.selectedOptions[0]?.textContent || "Nhân viên";
  const prefix = employeeCodePrefix(roleName);
  const pattern = new RegExp(`^${prefix}(\\d+)$`, "i");
  const highest = state.accounts.reduce((max, account) => {
    const match = pattern.exec(String(account.employee_code || ""));
    return match ? Math.max(max, Number(match[1])) : max;
  }, 0);
  form.elements.employee_code.value = `${prefix}${String(highest + 1).padStart(3, "0")}`;
}

function fillRoleOptions(selectedRoleId = "", excludeAdmin = false) {
  const select = document.querySelector("#accountForm select[name='role_id']");
  if (!select) return;
  select.replaceChildren(new Option("Chọn vai trò", ""));
  (state.roles || [])
    .filter((role) => !excludeAdmin || String(role.role_name).toLowerCase() !== "admin")
    .forEach((role) => {
      select.append(new Option(role.role_name, role.role_id));
    });
  if (selectedRoleId) select.value = selectedRoleId;
}

function hideAccountForm() {
  const form = document.getElementById("accountForm");
  if (!form) return;
  form.hidden = true;
  if (form.elements.is_active) form.elements.is_active.disabled = true;
  if (form.elements.role_id) form.elements.role_id.disabled = false;
  resetForm("accountForm");
  const message = document.getElementById("accountFormMessage");
  if (message) message.textContent = "";
}

async function openAccountAdd() {
  const form = document.getElementById("accountForm");
  if (!form) return;
  resetForm("accountForm");
  updateAccountDateLimits();
  const options = await loadOptions();
  if (!options) return;
  if (!state.roles.length) await loadRoles();
  fillAccountOptions(null);
  fillRoleOptions(
    state.roles.find((role) => role.role_name === "Nhân viên")?.role_id || "",
    true,
  );
  form.elements.role_id.disabled = false;
  form.elements.is_active.value = "true";
  form.elements.is_active.disabled = true;
  form.querySelector(".admin-form-header h3").textContent = "Thêm nhân sự mới";
  form.querySelector('button[type="submit"]').textContent = "Thêm nhân sự";
  form.querySelector("#generatedPasswordGroup").hidden = false;
  updateGeneratedEmployeeCode();
  setTimeout(() => {
    updateGeneratedPassword();
  }, 100);
  showAccountForm();
}

async function openAccountEdit(employeeId) {
  const account = state.accounts.find(
    (item) => String(item.employee_id) === String(employeeId),
  );
  if (!account) return;

  const options = await loadOptions();
  if (!options) return;
  if (!state.roles.length) await loadRoles();

  const form = document.getElementById("accountForm");
  if (!form) return;
  resetForm("accountForm");
  updateAccountDateLimits();
  form.elements.employee_id.value = account.employee_id;
  form.elements.employee_code.value = account.employee_code;
  form.elements.full_name.value = account.full_name;
  form.elements.email.value = account.email;
  form.elements.gender.value = account.gender;
  if (form.elements.phone_number) {
    form.elements.phone_number.value = account.phone_number || "";
  }
  form.elements.date_of_birth.value = toDisplayDate(account.date_of_birth);
  form.elements.hire_date.value = toDisplayDate(account.hire_date);
  fillAccountOptions(account);
  const isSelf = String(account.employee_id) === String(currentSession?.user?.employee_id);
  const isAdminAccount = String(account.role_name).toLowerCase() === "admin";
  fillRoleOptions(account.role_id || "", !isAdminAccount);
  form.elements.role_id.disabled = isSelf || isAdminAccount;
  form.elements.is_active.value = account.is_active ? "true" : "false";
  form.elements.is_active.disabled = true;
  form.elements.employee_code.readOnly = true;
  form.querySelector(".admin-form-header h3").textContent =
    "Cập nhật tài khoản";
  form.querySelector('button[type="submit"]').textContent = "Lưu thông tin";

  form.querySelector("#generatedPasswordGroup").hidden = false;

  const roleName =
    state.roles.find((r) => String(r.role_id) === String(account.role_id))
      ?.role_name || "";
  const department = (state.options?.departments || []).find(
    (d) => String(d.department_id) === String(account.department_id),
  );
  const departmentDescription = department?.description || "";
  const dob = toIsoDate(account.date_of_birth);

  form.elements.generated_password.value = generateAccountPassword(
    roleName,
    departmentDescription,
    dob,
  );

  showAccountForm();
}

async function submitAccountForm(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const message = document.getElementById("accountFormMessage");
  const saveButton = form.querySelector('button[type="submit"]');
  const values = Object.fromEntries(new FormData(form).entries());

  const dateOfBirth = toIsoDate(values.date_of_birth);
  const hireDate = toIsoDate(values.hire_date);

  const generatedPasswordInput = form.elements.generated_password;
  const currentPassword = generatedPasswordInput
    ? generatedPasswordInput.value
    : values.generated_password;

  const payload = {
    employee_code: form.elements.employee_code?.value || values.employee_code,
    full_name: values.full_name,
    email: values.email,
    gender: values.gender,
    date_of_birth: dateOfBirth,
    hire_date: hireDate,
    phone_number: String(form.elements.phone_number?.value || values.phone_number || "").trim(),
    department_id: values.department_id,
    position_id: form.elements.position_id?.value || values.position_id || "",
    role_id: form.elements.role_id ? form.elements.role_id.value : values.role_id,
    is_active: form.elements.is_active ? form.elements.is_active.value === "true" : true,
    generated_password: currentPassword,
  };

  if (
    !payload.employee_code ||
    !payload.full_name ||
    !payload.email ||
    !values.date_of_birth ||
    !values.hire_date ||
    !payload.department_id
  ) {
    message.textContent = accountErrorMessage("missing_fields");
    return;
  }

  if (!dateOfBirth) {
    message.textContent = accountErrorMessage("invalid_date_of_birth");
    return;
  }

  if (!hireDate) {
    message.textContent = accountErrorMessage("invalid_hire_date");
    return;
  }

  const rawPhone = String(form.elements.phone_number?.value || values.phone_number || "").trim();
  if (rawPhone && !/^\d{10}$/.test(rawPhone)) {
    message.textContent = accountErrorMessage("invalid_phone");
    form.elements.phone_number?.focus();
    return;
  }

  const dateLimits = getDateInputLimits();
  if (dateOfBirth > dateLimits.dateOfBirth) {
    message.textContent = accountErrorMessage("invalid_date_of_birth");
    return;
  }

  if (hireDate > dateLimits.hireDate) {
    message.textContent = accountErrorMessage("invalid_hire_date");
    return;
  }

  message.textContent = "";
  saveButton.disabled = true;

  const response = await callAdmin(
    values.employee_id
      ? { action: "update", employee_id: values.employee_id, ...payload }
      : { action: "create", ...payload },
  );

  saveButton.disabled = false;

  if (!response.ok) {
    if (response.status === 401) return;
    message.textContent = accountErrorMessage(response.error);
    return;
  }

  const wasCreated = !values.employee_id;
  hideAccountForm();
  await loadAccounts();
  if (wasCreated) {
    showAccountSuccessToast();
  } else {
    showAccountUpdateToast();
  }
}

async function setAccountActive(employeeId, button) {
  const account = state.accounts.find(
    (item) => String(item.employee_id) === String(employeeId),
  );
  if (!account) return;

  button.disabled = true;
  const response = await callAdmin({
    action: "set_active",
    employee_id: employeeId,
    is_active: !account.is_active,
  });
  button.disabled = false;

  if (!response.ok) {
    if (response.status === 401) return;
    state.accountsError = accountErrorMessage(response.error);
    renderTables();
    return;
  }

  account.is_active = !account.is_active;
  state.accountsError = "";
  renderTables();
}

// Recover a soft-deleted account: it comes back active and usable.
async function restoreAccount(employeeId, button) {
  const account = state.accounts.find(
    (item) => String(item.employee_id) === String(employeeId),
  );
  if (!account) return;

  button.disabled = true;
  const response = await callAdmin({
    action: "restore",
    employee_id: employeeId,
  });
  button.disabled = false;

  if (!response.ok) {
    if (response.status === 401) return;
    state.accountsError = accountErrorMessage(response.error);
    renderTables();
    return;
  }

  account.deleted_at = null;
  account.is_active = true;
  state.accountsError = "";
  renderTables();
}

async function removeAccount(employeeId, button) {
  const account = state.accounts.find(
    (item) => String(item.employee_id) === String(employeeId),
  );
  if (!account) return;
  if (
    !window.confirm(
      `Xóa tài khoản của ${account.full_name}? Tài khoản vẫn hiển thị trong danh sách nhưng không thể đăng nhập.`,
    )
  )
    return;

  if (button) button.disabled = true;
  const response = await callAdmin({
    action: "delete",
    employee_id: employeeId,
  });
  if (button) button.disabled = false;
  if (!response.ok) {
    if (response.status === 401) return;
    state.accountsError = accountErrorMessage(response.error);
    renderTables();
    return;
  }

  account.deleted_at = new Date().toISOString();
  account.is_active = false;
  state.accountsError = "";
  renderTables();
  showAccountDeleteToast();
}

async function permanentlyDeleteAccount(employeeId, button) {
  const account = state.accounts.find(
    (item) => String(item.employee_id) === String(employeeId),
  );
  if (!account || !account.deleted_at) return;
  if (!(await confirmPermanentAccountDelete())) return;

  if (button) button.disabled = true;
  const response = await callAdmin({
    action: "permanent_delete",
    employee_id: employeeId,
  });
  if (button) button.disabled = false;
  if (!response.ok) {
    if (response.status === 401) return;
    const errorToast = document.getElementById("accountErrorToast");
    if (errorToast) {
      const message = errorToast.querySelector("span");
      if (message) {
        message.textContent =
          response.error === "not_found"
            ? "Không tìm thấy tài khoản đã xóa."
            : response.error === "permanent_delete_failed"
              ? "Không thể xóa vĩnh viễn do dữ liệu tài khoản còn liên kết."
              : "Không thể xóa tài khoản. Vui lòng thử lại.";
      }
    }
    showAccountToast("accountErrorToast");
    return;
  }

  state.accounts = state.accounts.filter(
    (item) => String(item.employee_id) !== String(employeeId),
  );
  state.staff = state.staff.filter(
    (item) => String(item.employee_id) !== String(employeeId),
  );
  renderTables();
  showAccountDeleteToast();
}

async function loadRoles() {
  const response = await callAdmin({ action: "roles" });
  if (!response.ok) {
    if (response.status !== 401) {
      state.accountsError = accountErrorMessage(response.error);
      renderTables();
    }
    return;
  }
  state.roles = Array.isArray(response.data?.roles) ? response.data.roles : [];
}

async function loadPermissions() {
  if (state.permissions.length) return state.permissions;

  const response = await callAdmin({ action: "permissions" });
  if (!response.ok) {
    if (response.status !== 401) {
      state.accountsError = accountErrorMessage(response.error);
      renderTables();
    }
    return state.permissions;
  }
  state.permissions = Array.isArray(response.data?.permissions)
    ? response.data.permissions
    : [];
  return state.permissions;
}

function renderRoleCards() {
  const container = document.getElementById("roleCards");
  if (!container) return;
  if (!state.roles.length) {
    container.innerHTML = '<p class="panel-note">Chưa có vai trò nào.</p>';
    return;
  }

  const byId = new Map(
    state.permissions.map((permission) => [
      permission.permission_id,
      permission,
    ]),
  );
  const ADMIN_PERMISSIONS = [
    "Thêm tài khoản nhân sự mới",
    "Chỉnh sửa thông tin nhân sự",
    "Phân quyền nhân sự",
    "Xem toàn bộ nhân viên của hệ thống",
    "Xóa/Khôi phục tài khoản nhân sự",
    "Khóa/Mở khóa tài khoản nhân sự",
    "Xóa vĩnh viễn nhân sự",
    "Tìm kiếm nhân sự",
  ];

  container.innerHTML = state.roles
    .map((role) => {
      const isSystemRole = role.role_name.toLowerCase() === "admin";
      let displayItems = [];

      if (isSystemRole) {
        displayItems = ADMIN_PERMISSIONS;
      } else {
        const items = (role.permission_ids || [])
          .map((id) => byId.get(id))
          .filter(Boolean);
        displayItems = items.map((item) => {
          const desc = item.description || item.permission_code;
          if (desc === "Chấm công vào/ra của nhân viên" || desc === "Chấm công ra/vào của nhân viên") {
            return "Chấm công ra/vào";
          }
          return desc;
        });
      }

      const body = displayItems.length
        ? displayItems
            .map(
              (desc) =>
                `<span class="permission-item">${escapeHtml(desc)}</span>`,
            )
            .join("")
        : '<p class="panel-note">Chưa có quyền hạn nào.</p>';

      const actionBtn = isSystemRole
        ? '<span class="status-badge" style="font-size:0.75rem; color:#888;">Hệ thống</span>'
        : `<button type="button" class="mini-btn" data-edit-role="${escapeHtml(role.role_id)}">Sửa</button>`;

      return `
      <article class="role-card">
        <div class="role-card-head">
          <div>
            <strong>${escapeHtml(role.role_name)}</strong>
            ${role.description ? `<span>${escapeHtml(role.description)}</span>` : ""}
          </div>
          ${actionBtn}
        </div>
        <div class="role-card-body">${body}</div>
      </article>`;
    })
    .join("");
}

function renderPermissionGroups(selectedIds) {
  const container = document.getElementById("permissionGroups");
  if (!container) return;
  const selected = new Set(selectedIds || []);
  const groups = new Map();
  state.permissions.forEach((permission) => {
    if (!groups.has(permission.module_name))
      groups.set(permission.module_name, []);
    groups.get(permission.module_name).push(permission);
  });

  container.innerHTML = [...groups.entries()]
    .map(
      ([moduleName, items]) => `
    <div class="permission-group">
      <div class="permission-group-header">
        <strong>${escapeHtml(moduleName)}</strong>
        <button type="button" class="mini-btn" data-select-all="group">Chọn tất cả</button>
      </div>
      <div class="permission-items">
        ${items
          .map(
            (item) => `
          <label class="permission-item">
            <input type="checkbox" name="permission_id" value="${escapeHtml(item.permission_id)}" ${selected.has(item.permission_id) ? "checked" : ""}>
            <span>${escapeHtml(item.description || item.permission_code)}</span>
          </label>`,
          )
          .join("")}
      </div>
    </div>`,
    )
    .join("");
}

function showRoleForm() {
  const form = document.getElementById("roleForm");
  if (!form) return;
  form.hidden = false;
  form.querySelector("input[name='role_name']")?.focus();
}

function hideRoleForm() {
  const form = document.getElementById("roleForm");
  if (!form) return;
  form.hidden = true;
  resetForm("roleForm");
  const message = document.getElementById("roleFormMessage");
  if (message) message.textContent = "";
}

async function openRoleAdd() {
  const form = document.getElementById("roleForm");
  if (!form) return;
  resetForm("roleForm");
  await loadPermissions();
  renderPermissionGroups([]);
  document.getElementById("roleFormTitle").textContent = "Thêm vai trò";
  showRoleForm();
}

async function openRoleEdit(roleId) {
  const role = state.roles.find(
    (item) => String(item.role_id) === String(roleId),
  );
  if (!role) return;

  const form = document.getElementById("roleForm");
  if (!form) return;
  resetForm("roleForm");
  await loadPermissions();
  form.elements.role_id.value = role.role_id;
  form.elements.role_name.value = role.role_name;
  form.elements.description.value = role.description || "";
  renderPermissionGroups(role.permission_ids || []);
  document.getElementById("roleFormTitle").textContent = "Sửa vai trò";
  showRoleForm();
}

async function submitRoleForm(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const message = document.getElementById("roleFormMessage");
  const saveButton = form.querySelector('button[type="submit"]');
  const roleName = form.elements.role_name.value.trim();
  const roleId = form.elements.role_id.value;

  if (!roleName) {
    message.textContent = accountErrorMessage("missing_fields");
    return;
  }

  const permissionIds = [
    ...form.querySelectorAll('input[name="permission_id"]:checked'),
  ].map((input) => input.value);

  message.textContent = "";
  saveButton.disabled = true;
  const response = await callAdmin({
    action: roleId ? "update_role" : "create_role",
    role_id: roleId || undefined,
    role_name: roleName,
    description: form.elements.description.value.trim(),
    permission_ids: permissionIds,
  });
  saveButton.disabled = false;

  if (!response.ok) {
    if (response.status === 401) return;
    message.textContent = accountErrorMessage(response.error);
    return;
  }

  hideRoleForm();
  await loadRoles();
  renderTables();
}

function setRoleTab(tabName) {
  document.querySelectorAll("[data-role-tab]").forEach((tab) => {
    const active = tab.dataset.roleTab === tabName;
    tab.classList.toggle("is-active", active);
    tab.setAttribute("aria-selected", active ? "true" : "false");
  });
  document.querySelectorAll("[data-role-panel]").forEach((panel) => {
    panel.hidden = panel.dataset.rolePanel !== tabName;
  });
}

async function saveEmployeeRole(employeeId, button) {
  const select = button
    .closest(".staff-row")
    ?.querySelector("select.role-select");
  const roleId = select?.value || "";
  if (!roleId) {
    window.alert("Vui lòng chọn vai trò.");
    return;
  }

  button.disabled = true;
  const response = await callAdmin({
    action: "assign_role",
    employee_id: employeeId,
    role_id: roleId,
  });
  button.disabled = false;

  if (!response.ok) {
    if (response.status === 401) return;
    window.alert(accountErrorMessage(response.error));
    return;
  }

  await loadAccounts();
  showAccountUpdateToast();
}

function attachCrudActions() {
  document.querySelectorAll("[data-add]").forEach((button) => {
    button.addEventListener("click", () => {
      if (button.dataset.add === "accounts") openAccountAdd();
    });
  });

  document.querySelectorAll("[data-reset]").forEach((button) => {
    button.addEventListener("click", () => {
      if (button.dataset.reset === "accounts") hideAccountForm();
      else if (button.dataset.reset === "staff") hideRoleForm();
    });
  });

  document.querySelectorAll("[data-role-tab]").forEach((tab) => {
    tab.addEventListener("click", () => setRoleTab(tab.dataset.roleTab));
  });

  document.getElementById("addRoleBtn")?.addEventListener("click", openRoleAdd);
  ["accountRefreshBtn", "overviewAccountRefreshBtn"].forEach((btnId) => {
    document
      .getElementById(btnId)
      ?.addEventListener("click", (event) => {
        refreshAccountData(event.currentTarget);
      });
  });

  document.addEventListener("click", (event) => {
    const sortButton = event.target.closest("[data-account-sort]");
    if (sortButton) {
      const key = sortButton.dataset.accountSort;
      state.accountSort.direction =
        state.accountSort.key === key ? state.accountSort.direction * -1 : 1;
      state.accountSort.key = key;
      renderAccountsTable();
      return;
    }
    const accountRow = event.target.closest("[data-account-row]");
    if (
      accountRow &&
      !accountRow.classList.contains("account-row-disabled") &&
      !event.target.closest("button, a, select, input")
    ) {
      openAccountEdit(accountRow.dataset.accountRow);
      return;
    }
    const editRoleBtn = event.target.closest("[data-edit-role]");
    if (editRoleBtn) {
      openRoleEdit(editRoleBtn.dataset.editRole);
      return;
    }
    const lockBtn = event.target.closest("[data-toggle-lock]");
    if (lockBtn) {
      setAccountActive(lockBtn.dataset.toggleLock, lockBtn);
      return;
    }
    const restoreBtn = event.target.closest("[data-restore]");
    if (restoreBtn) {
      restoreAccount(restoreBtn.dataset.restore, restoreBtn);
      return;
    }
    const permanentDeleteBtn = event.target.closest("[data-permanent-delete]");
    if (permanentDeleteBtn) {
      permanentlyDeleteAccount(
        permanentDeleteBtn.dataset.permanentDelete,
        permanentDeleteBtn,
      );
      return;
    }
    const deleteBtn = event.target.closest("[data-delete]");
    if (deleteBtn && deleteBtn.dataset.delete === "accounts") {
      removeAccount(deleteBtn.dataset.id, deleteBtn);
      return;
    }
    const assignBtn = event.target.closest("[data-assign-role]");
    if (assignBtn) saveEmployeeRole(assignBtn.dataset.assignRole, assignBtn);
  });

  document.addEventListener("keydown", (event) => {
    const accountRow = event.target.closest("[data-account-row]");
    if (
      accountRow &&
      !accountRow.classList.contains("account-row-disabled") &&
      (event.key === "Enter" || event.key === " ") &&
      !event.target.closest("button, a, select, input")
    ) {
      event.preventDefault();
      openAccountEdit(accountRow.dataset.accountRow);
    }
  });

  const accountForm = document.getElementById("accountForm");
  if (accountForm) {
    updateAccountDateLimits();
    accountForm.addEventListener("submit", submitAccountForm);
    accountForm.elements.date_of_birth.addEventListener(
      "input",
      updateGeneratedPassword,
    );
    accountForm.elements.date_of_birth.addEventListener(
      "change",
      updateGeneratedPassword,
    );
    accountForm.elements.role_id.addEventListener("change", () => {
      updateGeneratedEmployeeCode();
      updateGeneratedPassword();
    });
    accountForm.elements.phone_number?.addEventListener("input", (e) => {
      e.target.value = e.target.value.replace(/\D/g, "").slice(0, 10);
    });
    accountForm.elements.department_id.addEventListener("change", (event) => {
      renderPositionOptions(
        event.target.value,
        accountForm.elements.position_id.value,
      );
      updateGeneratedPassword();
    });
    accountForm.elements.position_id.addEventListener("change", () => {
      renderDepartmentOptions(
        accountForm.elements.position_id.value,
        accountForm.elements.department_id.value,
      );
      updateGeneratedPassword();
    });
  }

  const roleForm = document.getElementById("roleForm");
  if (roleForm) {
    roleForm.addEventListener("submit", submitRoleForm);
    roleForm.addEventListener("click", (event) => {
      const selectAll = event.target.closest("[data-select-all]");
      if (!selectAll) return;
      const scope =
        selectAll.dataset.selectAll === "group"
          ? selectAll.closest(".permission-group")
          : document.getElementById("permissionGroups");
      scope
        ?.querySelectorAll('input[name="permission_id"]')
        .forEach((input) => {
          input.checked = true;
        });
    });
  }

  // Either floating form closes on Escape, the same as any other dialog.
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    if (accountForm && !accountForm.hidden) hideAccountForm();
    if (roleForm && !roleForm.hidden) hideRoleForm();
  });

  // Clicking the backdrop outside a floating form closes it too. The controls that
  // open a form are exempt, since their click reaches this listener as it bubbles.
  document.addEventListener("click", (event) => {
    if (
      event.target.closest(
        "[data-add], #addRoleBtn, [data-account-row], [data-edit], [data-edit-role]",
      )
    )
      return;
    if (
      accountForm &&
      !accountForm.hidden &&
      !accountForm.contains(event.target)
    )
      hideAccountForm();
    if (roleForm && !roleForm.hidden && !roleForm.contains(event.target))
      hideRoleForm();
  });
}

bindModuleNavigation();
attachTableSearch();
attachCrudActions();
renderProfile();
renderTables();

if (currentSession) {
  loadInitialData();
  initRealtimeActivities();
}

const hash = window.location.hash.replace("#", "");
if (hash && document.querySelector(`.admin-module[data-module="${hash}"]`)) {
  setModule(hash);
} else {
  setModule("overview");
}
setInterval(async () => {
  if (currentSession) {
    await callAdmin({ action: "ping" });
  }
}, 5000);
const profileToggle = document.getElementById("adminProfileToggle");
const profileMenu = document.getElementById("adminProfileMenu");
const profileCard = document.querySelector(".admin-profile-card");

function setProfileMenuOpen(open) {
  if (!profileToggle || !profileMenu) return;
  profileToggle.setAttribute("aria-expanded", String(open));
  profileMenu.classList.toggle("show-menu", open);
}

if (profileToggle) {
  profileToggle.addEventListener("click", (event) => {
    event.stopPropagation();
    const isOpen = profileToggle.getAttribute("aria-expanded") === "true";
    setProfileMenuOpen(!isOpen);
  });
}

document.addEventListener("click", (event) => {
  if (profileCard && !profileCard.contains(event.target)) {
    setProfileMenuOpen(false);
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    setProfileMenuOpen(false);
    setLogoutModalOpen(false);
  }
});

document.addEventListener("DOMContentLoaded", () => {
  const logoutModal = document.getElementById("logoutModal");
  const confirmLogoutBtn = document.getElementById("confirmLogoutBtn");
  const cancelLogoutBtn = document.getElementById("cancelLogoutBtn");
  const sidebarLogoutBtn = document.getElementById("adminLogoutBtn");

  function setLogoutModalOpen(open) {
    if (logoutModal) logoutModal.hidden = !open;
  }

  if (sidebarLogoutBtn) {
    sidebarLogoutBtn.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (typeof setProfileMenuOpen === "function") {
        setProfileMenuOpen(false);
      }

      setLogoutModalOpen(true);
      if (cancelLogoutBtn) cancelLogoutBtn.focus();
    });
  }

  if (cancelLogoutBtn) {
    cancelLogoutBtn.addEventListener("click", () => {
      setLogoutModalOpen(false);
    });
  }

  if (confirmLogoutBtn) {
    confirmLogoutBtn.addEventListener("click", () => {
      clearSession();
      window.location.href = "login.html";
    });
  }

  if (logoutModal) {
    logoutModal.addEventListener("click", (event) => {
      if (event.target === logoutModal) {
        setLogoutModalOpen(false);
      }
    });
  }
});
