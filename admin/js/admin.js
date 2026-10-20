const ADMIN_TOKEN_KEY = "jewels-admin-token";

function getSession() {
  try {
    return JSON.parse(localStorage.getItem(ADMIN_TOKEN_KEY) || "null");
  } catch {
    return null;
  }
}

function clearSession() {
  localStorage.removeItem(ADMIN_TOKEN_KEY);
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

function requireSession() {
  const session = getSession();
  const payload = session?.token ? decodeToken(session.token) : null;
  if (!payload || typeof payload.exp !== "number" || payload.exp * 1000 <= Date.now()) {
    clearSession();
    window.location.replace("login.html");
    return null;
  }
  return session;
}

const currentSession = requireSession();

const adminLogoutBtn = document.getElementById("adminLogoutBtn");
if (adminLogoutBtn) {
  adminLogoutBtn.addEventListener("click", () => {
    clearSession();
    window.location.href = "login.html";
  });
}

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
    avatar.textContent = fullName.trim().split(/\s+/).slice(0, 2).map((part) => part[0] || "").join("").toUpperCase();
  }
}

const state = {
  accounts: [],
  accountsLoading: false,
  accountsError: "",
  options: null,
  roles: [],
  permissions: [],
  staff: []
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
  role_name_reserved: "Không thể dùng tên vai trò \"Admin\".",
  position_department_mismatch: "Vị trí không thuộc phòng ban đã chọn.",
  duplicate: "Email hoặc mã nhân viên đã tồn tại.",
  check_violation: "Dữ liệu không hợp lệ.",
  role_overlap: "Không thể đổi vai trò do trùng khoảng thời gian hiệu lực.",
  not_found: "Không tìm thấy tài khoản.",
  account_not_found: "Không tìm thấy tài khoản đăng nhập.",
  unauthorized: "Phiên đăng nhập đã hết hạn.",
  network_error: "Không thể kết nối máy chủ. Vui lòng thử lại sau.",
  server_error: "Máy chủ gặp lỗi. Vui lòng thử lại sau.",
  server_not_configured: "Máy chủ chưa được cấu hình."
};

function accountErrorMessage(code) {
  return ACCOUNT_ERRORS[code] || "Đã xảy ra lỗi. Vui lòng thử lại.";
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  }[char]));
}

// The form shows dates as dd/mm/yyyy; the API stores and validates yyyy-mm-dd.
function toDisplayDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value || "") ? value.split("-").reverse().join("/") : (value || "");
}

function toIsoDate(value) {
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(String(value || "").trim());
  if (!match) return "";
  const [, day, month, year] = match;
  const iso = `${year}-${month}-${day}`;
  const date = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== iso ? "" : iso;
}

function getStatusClass(status) {
  const lower = String(status || "").toLowerCase();
  if (["hoạt động", "làm việc"].some((value) => lower.includes(value))) return "status-online";
  if (["chờ duyệt"].some((value) => lower.includes(value))) return "status-progress";
  return "status-away";
}

function accountStatusLabel(isActive) {
  return isActive ? "Hoạt động" : "Khóa";
}

// A soft-deleted account stays in the list, so it needs its own label.
function accountStatusText(account) {
  return account.deleted_at ? "Đã xóa" : accountStatusLabel(account.is_active);
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
  const idField = form.querySelector('input[name="employee_id"], input[name="id"], input[name="role_id"]');
  if (idField) idField.value = "";
}

async function callAdmin(body) {
  const { data, error } = await window.sbInvoke("admin-accounts", {
    headers: { "x-admin-token": currentSession?.token || "" },
    body
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
      window.location.replace("login.html");
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

  state.accounts = Array.isArray(response.data?.accounts) ? response.data.accounts : [];
  renderTables();
}

// One call for the whole dashboard boot (accounts, staff, roles, permissions).
async function loadInitialData() {
  state.accountsLoading = true;
  renderTables();

  const response = await callAdmin({ action: "init" });
  state.accountsLoading = false;

  if (!response.ok) {
    if (response.status === 401) return;
    state.accountsError = accountErrorMessage(response.error);
    renderTables();
    return;
  }

  state.accounts = Array.isArray(response.data?.accounts) ? response.data.accounts : [];
  state.staff = Array.isArray(response.data?.staff) ? response.data.staff : [];
  state.roles = Array.isArray(response.data?.roles) ? response.data.roles : [];
  state.permissions = Array.isArray(response.data?.permissions) ? response.data.permissions : [];
  renderTables();
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
  if (overviewAccounts) {
    overviewAccounts.innerHTML = buildRowHeader(["Người dùng", "Vai trò", "Trạng thái", "Hoạt động"]) + state.accounts.map((item) => `
      <div class="admin-row">
        <span>${escapeHtml(item.full_name)}</span>
        <span>${escapeHtml(item.role_name || "—")}</span>
        <span><em class="${getStatusClass(accountStatusText(item))}">${escapeHtml(accountStatusText(item))}</em></span>
        <span>${escapeHtml(item.last_login || "—")}</span>
      </div>
    `).join("");
  }

  const overviewAccountsCount = document.getElementById("overviewAccountsCount");
  if (overviewAccountsCount) overviewAccountsCount.textContent = `${state.accounts.length} tài khoản`;

  const overviewStaff = document.getElementById("overviewStaff");
  if (overviewStaff) {
    overviewStaff.innerHTML = state.staff.map((item) => `
      <div class="mini-row">
        <span>${escapeHtml(item.full_name)}</span>
        <strong>${escapeHtml(item.position_title)}</strong>
      </div>
    `).join("");
  }

  const overviewStaffCount = document.getElementById("overviewStaffCount");
  if (overviewStaffCount) overviewStaffCount.textContent = `${state.staff.length} người`;
}

function renderAccountsTable() {
  const table = document.getElementById("accountsTable");
  if (!table) return;

  if (state.accountsLoading) {
    table.innerHTML = '<div class="admin-row"><span style="grid-column:1/-1">Đang tải danh sách tài khoản…</span></div>';
    return;
  }

  if (state.accountsError) {
    table.innerHTML = `<div class="admin-row"><span style="grid-column:1/-1">${escapeHtml(state.accountsError)}</span></div>`;
    return;
  }

  const search = document.getElementById("accountSearch");
  const term = (search?.value || "").trim().toLowerCase();
  const rows = state.accounts.filter((item) => String(item.full_name || "").toLowerCase().includes(term));

  if (!rows.length) {
    const message = term ? "Không tìm thấy tài khoản phù hợp." : "Chưa có tài khoản nào.";
    table.innerHTML = `<div class="admin-row"><span style="grid-column:1/-1">${message}</span></div>`;
    return;
  }

  table.innerHTML = buildRowHeader(["Họ tên", "Email", "Vai trò", "Trạng thái", "Hành động"]) + rows.map((item) => {
    const status = accountStatusText(item);
    const actions = item.deleted_at
      ? `<button type="button" class="mini-btn icon-btn" data-restore="${escapeHtml(item.employee_id)}" title="Khôi phục tài khoản" aria-label="Khôi phục tài khoản">${iconSprite("restore")}</button>`
      : `
        <button type="button" class="mini-btn icon-btn" data-toggle-lock="${escapeHtml(item.employee_id)}"
          title="${item.is_active ? "Khóa tài khoản" : "Mở khóa tài khoản"}"
          aria-label="${item.is_active ? "Khóa tài khoản" : "Mở khóa tài khoản"}">
          ${iconSprite(item.is_active ? "lock" : "unlock")}
        </button>
        <button type="button" class="mini-btn icon-btn" data-edit="accounts" data-id="${escapeHtml(item.employee_id)}" title="Sửa" aria-label="Sửa">
          ${iconSprite("edit")}
        </button>
        <button type="button" class="mini-btn icon-btn danger" data-delete="accounts" data-id="${escapeHtml(item.employee_id)}" title="Xóa" aria-label="Xóa">
          ${iconSprite("delete")}
        </button>`;

    return `
    <div class="admin-row">
      <span>${escapeHtml(item.full_name)}</span>
      <span>${escapeHtml(item.email)}</span>
      <span>${escapeHtml(item.role_name || "—")}</span>
      <span><em class="${getStatusClass(status)}">${escapeHtml(status)}</em></span>
      <span class="table-actions">${actions}</span>
    </div>`;
  }).join("");
}

function roleSelectHtml(account) {
  if (account.role_name === "Admin") {
    return '<select class="role-select" disabled><option value="">Admin</option></select>';
  }
  const options = ['<option value="">— Chọn vai trò —</option>'].concat(
    state.roles.map((role) => (
      `<option value="${escapeHtml(role.role_id)}" ${String(role.role_id) === String(account.role_id) ? "selected" : ""}>${escapeHtml(role.role_name)}</option>`
    ))
  );
  return `<select class="role-select" data-employee="${escapeHtml(account.employee_id)}">${options.join("")}</select>`;
}

function renderStaffTable() {
  const table = document.getElementById("staffTable");
  if (!table) return;

  if (state.accountsLoading) {
    table.innerHTML = '<div class="admin-row"><span style="grid-column:1/-1">Đang tải danh sách nhân viên…</span></div>';
    return;
  }

  if (state.accountsError) {
    table.innerHTML = `<div class="admin-row"><span style="grid-column:1/-1">${escapeHtml(state.accountsError)}</span></div>`;
    return;
  }

  const search = document.getElementById("staffSearch");
  const term = (search?.value || "").trim().toLowerCase();
  const rows = state.accounts.filter((item) =>
    [item.full_name, item.email].join(" ").toLowerCase().includes(term));

  if (!rows.length) {
    const message = term ? "Không tìm thấy nhân viên phù hợp." : "Chưa có nhân viên nào.";
    table.innerHTML = `<div class="admin-row"><span style="grid-column:1/-1">${message}</span></div>`;
    return;
  }

  table.innerHTML = buildRowHeader(["Họ tên", "Email", "Vai trò", "Hành động"]) + rows.map((item) => `
    <div class="admin-row staff-row">
      <span>${escapeHtml(item.full_name)}</span>
      <span>${escapeHtml(item.email)}</span>
      <span>${roleSelectHtml(item)}</span>
      <span class="table-actions">
        <button type="button" class="mini-btn" data-assign-role="${escapeHtml(item.employee_id)}" ${item.role_name === "Admin" ? "disabled" : ""}>Lưu</button>
      </span>
    </div>
  `).join("");
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
      renderTables();
    });
  });
}

function fillSelectOptions(select, items, valueKey, labelKey, placeholder) {
  if (!select) return;
  const head = placeholder ? `<option value="">${escapeHtml(placeholder)}</option>` : "";
  select.innerHTML = head + items.map((item) => (
    `<option value="${escapeHtml(item[valueKey])}">${escapeHtml(item[labelKey])}</option>`
  )).join("");
}

function renderPositionOptions(departmentId, selectedPositionId) {
  const form = document.getElementById("accountForm");
  if (!form) return;
  const positions = (state.options?.positions || []).filter((item) => item.department_id === departmentId);
  fillSelectOptions(form.elements.position_id, positions, "position_id", "position_title", "Chọn vị trí");
  if (selectedPositionId) form.elements.position_id.value = selectedPositionId;
}

// The role is assigned separately in the "Vai trò & Quyền" section.
function fillAccountOptions(account) {
  const form = document.getElementById("accountForm");
  if (!form || !state.options) return;
  fillSelectOptions(form.elements.department_id, state.options.departments || [], "department_id", "department_name", "Chọn phòng ban");
  if (account?.department_id) form.elements.department_id.value = account.department_id;
  renderPositionOptions(account?.department_id || "", account?.position_id || "");
}

function showAccountForm() {
  const form = document.getElementById("accountForm");
  if (!form) return;
  form.hidden = false;
  const firstField = form.querySelector("input:not([type='hidden']), select");
  firstField?.focus();
}

function hideAccountForm() {
  const form = document.getElementById("accountForm");
  if (!form) return;
  form.hidden = true;
  resetForm("accountForm");
  const message = document.getElementById("accountFormMessage");
  if (message) message.textContent = "";
}

async function openAccountAdd() {
  const form = document.getElementById("accountForm");
  if (!form) return;
  resetForm("accountForm");
  const options = await loadOptions();
  if (!options) return;
  fillAccountOptions(null);
  form.elements.is_active.value = "true";
  showAccountForm();
}

async function openAccountEdit(employeeId) {
  const account = state.accounts.find((item) => String(item.employee_id) === String(employeeId));
  if (!account) return;

  const options = await loadOptions();
  if (!options) return;

  const form = document.getElementById("accountForm");
  if (!form) return;
  resetForm("accountForm");
  form.elements.employee_id.value = account.employee_id;
  form.elements.employee_code.value = account.employee_code;
  form.elements.full_name.value = account.full_name;
  form.elements.email.value = account.email;
  form.elements.gender.value = account.gender;
  form.elements.date_of_birth.value = toDisplayDate(account.date_of_birth);
  form.elements.hire_date.value = toDisplayDate(account.hire_date);
  fillAccountOptions(account);
  form.elements.is_active.value = account.is_active ? "true" : "false";
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

  const payload = {
    employee_code: values.employee_code,
    full_name: values.full_name,
    email: values.email,
    gender: values.gender,
    date_of_birth: dateOfBirth,
    hire_date: hireDate,
    department_id: values.department_id,
    position_id: values.position_id,
    is_active: values.is_active === "true"
  };

  if (!payload.employee_code || !payload.full_name || !payload.email || !values.date_of_birth
    || !values.hire_date || !payload.department_id || !payload.position_id) {
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

  message.textContent = "";
  saveButton.disabled = true;

  const response = await callAdmin(values.employee_id
    ? { action: "update", employee_id: values.employee_id, ...payload }
    : { action: "create", ...payload });

  saveButton.disabled = false;

  if (!response.ok) {
    if (response.status === 401) return;
    message.textContent = accountErrorMessage(response.error);
    return;
  }

  hideAccountForm();
  await loadAccounts();
}

async function setAccountActive(employeeId, button) {
  const account = state.accounts.find((item) => String(item.employee_id) === String(employeeId));
  if (!account) return;

  button.disabled = true;
  const response = await callAdmin({
    action: "set_active",
    employee_id: employeeId,
    is_active: !account.is_active
  });
  button.disabled = false;

  if (!response.ok) {
    if (response.status === 401) return;
    state.accountsError = accountErrorMessage(response.error);
    renderTables();
    return;
  }

  await loadAccounts();
}

// Recover a soft-deleted account: it comes back active and usable.
async function restoreAccount(employeeId, button) {
  const account = state.accounts.find((item) => String(item.employee_id) === String(employeeId));
  if (!account) return;

  button.disabled = true;
  const response = await callAdmin({ action: "restore", employee_id: employeeId });
  button.disabled = false;

  if (!response.ok) {
    if (response.status === 401) return;
    state.accountsError = accountErrorMessage(response.error);
    renderTables();
    return;
  }

  await loadAccounts();
}

async function removeAccount(employeeId) {
  const account = state.accounts.find((item) => String(item.employee_id) === String(employeeId));
  if (!account) return;
  if (!window.confirm(`Xóa tài khoản của ${account.full_name}? Tài khoản vẫn hiển thị trong danh sách nhưng không thể đăng nhập.`)) return;

  const response = await callAdmin({ action: "delete", employee_id: employeeId });
  if (!response.ok) {
    if (response.status === 401) return;
    state.accountsError = accountErrorMessage(response.error);
    renderTables();
    return;
  }

  await loadAccounts();
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
  state.permissions = Array.isArray(response.data?.permissions) ? response.data.permissions : [];
  return state.permissions;
}

function renderRoleCards() {
  const container = document.getElementById("roleCards");
  if (!container) return;
  if (!state.roles.length) {
    container.innerHTML = '<p class="panel-note">Chưa có vai trò nào.</p>';
    return;
  }

  const byId = new Map(state.permissions.map((permission) => [permission.permission_id, permission]));
  container.innerHTML = state.roles.map((role) => {
    const items = (role.permission_ids || []).map((id) => byId.get(id)).filter(Boolean);

    const body = items.length
      ? items.map((item) => `<span class="permission-item">${escapeHtml(item.description || item.permission_code)}</span>`).join("")
      : '<p class="panel-note">Chưa có quyền hạn nào.</p>';

    return `
      <article class="role-card">
        <div class="role-card-head">
          <div>
            <strong>${escapeHtml(role.role_name)}</strong>
            ${role.description ? `<span>${escapeHtml(role.description)}</span>` : ""}
          </div>
          <button type="button" class="mini-btn" data-edit-role="${escapeHtml(role.role_id)}">Sửa</button>
        </div>
        <div class="role-card-body">${body}</div>
      </article>`;
  }).join("");
}

function renderPermissionGroups(selectedIds) {
  const container = document.getElementById("permissionGroups");
  if (!container) return;
  const selected = new Set(selectedIds || []);
  const groups = new Map();
  state.permissions.forEach((permission) => {
    if (!groups.has(permission.module_name)) groups.set(permission.module_name, []);
    groups.get(permission.module_name).push(permission);
  });

  container.innerHTML = [...groups.entries()].map(([moduleName, items]) => `
    <div class="permission-group">
      <div class="permission-group-header">
        <strong>${escapeHtml(moduleName)}</strong>
        <button type="button" class="mini-btn" data-select-all="group">Chọn tất cả</button>
      </div>
      <div class="permission-items">
        ${items.map((item) => `
          <label class="permission-item">
            <input type="checkbox" name="permission_id" value="${escapeHtml(item.permission_id)}" ${selected.has(item.permission_id) ? "checked" : ""}>
            <span>${escapeHtml(item.description || item.permission_code)}</span>
          </label>`).join("")}
      </div>
    </div>`).join("");
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
  const role = state.roles.find((item) => String(item.role_id) === String(roleId));
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

  const permissionIds = [...form.querySelectorAll('input[name="permission_id"]:checked')]
    .map((input) => input.value);

  message.textContent = "";
  saveButton.disabled = true;
  const response = await callAdmin({
    action: roleId ? "update_role" : "create_role",
    role_id: roleId || undefined,
    role_name: roleName,
    description: form.elements.description.value.trim(),
    permission_ids: permissionIds
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
  const select = button.closest(".staff-row")?.querySelector("select.role-select");
  const roleId = select?.value || "";
  if (!roleId) {
    window.alert("Vui lòng chọn vai trò.");
    return;
  }

  button.disabled = true;
  const response = await callAdmin({ action: "assign_role", employee_id: employeeId, role_id: roleId });
  button.disabled = false;

  if (!response.ok) {
    if (response.status === 401) return;
    window.alert(accountErrorMessage(response.error));
    return;
  }

  await loadAccounts();
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

  document.addEventListener("click", (event) => {
    const editBtn = event.target.closest("[data-edit]");
    if (editBtn && editBtn.dataset.edit === "accounts") {
      openAccountEdit(editBtn.dataset.id);
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
    const deleteBtn = event.target.closest("[data-delete]");
    if (deleteBtn && deleteBtn.dataset.delete === "accounts") {
      removeAccount(deleteBtn.dataset.id);
      return;
    }
    const assignBtn = event.target.closest("[data-assign-role]");
    if (assignBtn) saveEmployeeRole(assignBtn.dataset.assignRole, assignBtn);
  });

  const accountForm = document.getElementById("accountForm");
  if (accountForm) {
    accountForm.addEventListener("submit", submitAccountForm);
    accountForm.elements.department_id.addEventListener("change", (event) => {
      renderPositionOptions(event.target.value, "");
    });
  }

  const roleForm = document.getElementById("roleForm");
  if (roleForm) {
    roleForm.addEventListener("submit", submitRoleForm);
    roleForm.addEventListener("click", (event) => {
      const selectAll = event.target.closest("[data-select-all]");
      if (!selectAll) return;
      const scope = selectAll.dataset.selectAll === "group"
        ? selectAll.closest(".permission-group")
        : document.getElementById("permissionGroups");
      scope?.querySelectorAll('input[name="permission_id"]').forEach((input) => { input.checked = true; });
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
    if (event.target.closest("[data-add], #addRoleBtn, [data-edit], [data-edit-role]")) return;
    if (accountForm && !accountForm.hidden && !accountForm.contains(event.target)) hideAccountForm();
    if (roleForm && !roleForm.hidden && !roleForm.contains(event.target)) hideRoleForm();
  });
}

bindModuleNavigation();
attachTableSearch();
attachCrudActions();
renderProfile();
renderTables();

if (currentSession) {
  loadInitialData();
}

const hash = window.location.hash.replace("#", "");
if (hash && document.querySelector(`.admin-module[data-module="${hash}"]`)) {
  setModule(hash);
} else {
  setModule("overview");
}
