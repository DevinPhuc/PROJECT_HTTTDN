// Manager portal data layer: all access goes through the hr-portal edge
// function (see shared/js/portal-api.js); the browser never touches tables.
const portal = window.jewelsPortal;
const callHr = (body) =>
  portal.callPortal("manager", "hr-portal", body, { loginUrl: "login.html" });
const STATUS_LABELS = {
  active: "Đang làm",
  on_leave: "Đang nghỉ phép",
  resigned: "Đã nghỉ việc",
  unknown: "Chưa có lịch sử",
};
const MONTHLY_STATUS_LABELS = {
  active: "Làm việc trong tháng",
  on_leave: "Có nghỉ phép",
  resigned: "Nghỉ việc trong tháng",
  unknown: "Chưa có lịch sử",
};
const STATUS_TO_DB = {
  "Đang làm": "active",
  "Đang nghỉ phép": "on_leave",
  "Đã nghỉ việc": "resigned",
};
const LEAVE_TYPES = {
  annual: "Nghỉ phép",
  sick: "Nghỉ ốm đau",
  maternity: "Nghỉ thai sản",
  resignation: "Xin nghỉ việc",
};
const LEAVE_STATUSES = {
  pending: "Chờ duyệt",
  approved: "Đã duyệt",
  rejected: "Từ chối",
};
let employees = [];
let currentActor = null;
let contacts = new Map();
let positions = [];
let departments = [];
let roles = [];
let permissions = [];
let roleAssignments = new Map();
let rolePermissionIds = new Map();
let roleHistory = [];
let payrollCache = [];
let attendanceCache = [];
let employmentStatusHistory = [];
let requests = [];
let selectedEmployeeId = "";
let employeeSort = { key: "", direction: 1 };
const employeePagination = { page: 1, size: 10 };
const requestPagination = { page: 1, size: 10 };

function renderManagerProfile() {
  const name = document.getElementById("managerProfileName");
  const email = document.getElementById("managerProfileEmail");
  const avatar = document.querySelector(".admin-profile-card .admin-avatar");
  const sessionUser = portal?.getSession("manager")?.user || {};
  const accountName =
    currentActor?.full_name || sessionUser.full_name || sessionUser.username;
  const accountEmail =
    currentActor?.email ||
    sessionUser.email ||
    (String(sessionUser.username || "").includes("@")
      ? sessionUser.username
      : "");
  if (name) name.textContent = accountName || "Chưa xác định";
  if (email) email.textContent = accountEmail || "Chưa xác định";
  if (avatar) {
    avatar.textContent = (accountName || "??")
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((part) => part[0] || "")
      .join("")
      .toUpperCase();
  }
}

function money(value) {
  return new Intl.NumberFormat("vi-VN", {
    style: "currency",
    currency: "VND",
    maximumFractionDigits: 0,
  }).format(Number(value || 0));
}

function dateLabel(value) {
  if (!value) return "-";
  const [year, month, day] = String(value).slice(0, 10).split("-").map(Number);
  return new Intl.DateTimeFormat("vi-VN").format(
    new Date(year, month - 1, day),
  );
}

function addCell(row, value, tag = "td") {
  const cell = document.createElement(tag);
  cell.textContent = String(value ?? "");
  row.append(cell);
  return cell;
}

function renderPagination(containerId, total, pagination, onChange) {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.replaceChildren();
  const pageCount = Math.max(1, Math.ceil(total / pagination.size));
  pagination.page = Math.min(pagination.page, pageCount);

  const summary = document.createElement("span");
  summary.className = "hr-pagination-summary";
  const start = total ? (pagination.page - 1) * pagination.size + 1 : 0;
  const end = Math.min(pagination.page * pagination.size, total);
  summary.textContent = total
    ? `Hiển thị ${start}-${end} / ${total} dòng`
    : "Hiển thị 0 / 0 dòng";

  const controls = document.createElement("div");
  controls.className = "hr-pagination-controls";
  const sizeLabel = document.createElement("label");
  sizeLabel.textContent = "Số dòng/trang";
  const sizeSelect = document.createElement("select");
  [10, 20, 50, 100, 200].forEach((size) => {
    const option = document.createElement("option");
    option.value = size;
    option.textContent = size;
    option.selected = size === pagination.size;
    sizeSelect.append(option);
  });
  sizeSelect.addEventListener("change", () => {
    pagination.size = Number(sizeSelect.value);
    pagination.page = 1;
    onChange();
  });
  sizeLabel.append(sizeSelect);

  const previous = document.createElement("button");
  previous.type = "button";
  previous.className = "hr-page-button";
  previous.textContent = "‹";
  previous.disabled = pagination.page === 1;
  previous.addEventListener("click", () => {
    pagination.page -= 1;
    onChange();
  });
  controls.append(previous);
  for (let page = 1; page <= pageCount; page += 1) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "hr-page-button";
    button.classList.toggle("is-active", page === pagination.page);
    button.textContent = page;
    button.addEventListener("click", () => {
      pagination.page = page;
      onChange();
    });
    controls.append(button);
  }
  const next = document.createElement("button");
  next.type = "button";
  next.className = "hr-page-button";
  next.textContent = "›";
  next.disabled = pagination.page === pageCount;
  next.addEventListener("click", () => {
    pagination.page += 1;
    onChange();
  });
  controls.append(next);
  container.append(summary, sizeLabel, controls);
}

function feedback(id, message, error = false) {
  const element = document.getElementById(id);
  element.textContent = message;
  element.classList.toggle("is-error", error);
}

function showError(message) {
  document.getElementById("adminPageTitle").textContent = message;
}

function normalizedStatus(status) {
  const value = String(status || "").toLowerCase();
  if (
    [
      "on_leave",
      "onleave",
      "on leave",
      "leave",
      "đang nghỉ phép",
      "nghỉ phép",
    ].includes(value)
  )
    return "on_leave";
  if (["resigned", "inactive", "đã nghỉ việc", "nghỉ việc"].includes(value))
    return "resigned";
  if (["unknown", "unrecorded"].includes(value)) return "unknown";
  return "active";
}

function statusBadge(status, label = "") {
  const normalized = normalizedStatus(status);
  const badge = document.createElement("span");
  badge.className = `hr-status hr-status-${normalized === "active" ? "active" : normalized === "on_leave" ? "leave" : normalized === "resigned" ? "resigned" : "unknown"}`;
  badge.textContent =
    label ||
    STATUS_LABELS[status] ||
    STATUS_LABELS[normalized] ||
    STATUS_LABELS.unknown;
  return badge;
}

function capitalized(value) {
  const text = String(value || "");
  return text ? text[0].toUpperCase() + text.slice(1) : "";
}

function employeePosition(employee) {
  return positions.find(
    (position) => position.position_id === employee.position_id,
  );
}

function positionName(employee) {
  const pos = employeePosition(employee)?.position_title;
  if (pos) return pos;
  const currentRoleIds = roleAssignments.get(employee.employee_id) || [];
  const roleName = currentRoleIds
    .map((id) => roles.find((r) => r.role_id === id)?.role_name)
    .filter(Boolean)[0];
  return roleName || "Chưa gán chức vụ";
}

function departmentName(employee) {
  return (
    departments.find(
      (department) => department.department_id === employee.department_id,
    )?.department_name || "-"
  );
}

function setView(viewName) {
  document.querySelectorAll("[data-hr-panel]").forEach((panel) => {
    const active = panel.dataset.hrPanel === viewName;
    panel.hidden = !active;
    panel.classList.toggle("active", active);
  });
  document
    .querySelectorAll("[data-hr-view]")
    .forEach((link) =>
      link.classList.toggle("is-active", link.dataset.hrView === viewName),
    );
  const link = document.querySelector(
    `.admin-nav [data-hr-view="${viewName}"]`,
  );
  document.getElementById("adminPageTitle").textContent =
    link?.textContent.trim() || "Hồ sơ nhân sự";
  history.replaceState(null, "", `#${viewName}`);
}

document.querySelectorAll("[data-hr-view]").forEach((link) =>
  link.addEventListener("click", (event) => {
    event.preventDefault();
    setView(link.dataset.hrView);
  }),
);

async function loadLookups() {
  const result = await callHr({ action: "boot" });
  if (!result.ok) throw new Error(result.error);
  const data = result.data;
  employees = (data.employees || []).map((employee) => ({
    ...employee,
    position_id: employee.position_id ?? employee.current_position_id,
  }));
  const actor = data.actor || {};
  const sessionUser = portal?.getSession("manager")?.user || {};
  const actorEmployee = employees.find(
    (employee) => employee.employee_id === actor.employee_id,
  );
  currentActor = {
    ...actor,
    full_name:
      actor.full_name ||
      actorEmployee?.full_name ||
      sessionUser.full_name ||
      "",
    email:
      actor.email ||
      actorEmployee?.email ||
      sessionUser.email ||
      (String(sessionUser.username || "").includes("@")
        ? sessionUser.username
        : ""),
  };
  renderManagerProfile();
  contacts = new Map(
    (data.contacts || []).map((contact) => [contact.employee_id, contact]),
  );
  positions = data.positions || [];
  departments = data.departments || [];
  roles = data.roles || [];
  permissions = data.permissions || [];
  roleAssignments = new Map();
  (data.user_roles || []).forEach((assignment) => {
    const list = roleAssignments.get(assignment.employee_id) || [];
    list.push(assignment.role_id);
    roleAssignments.set(assignment.employee_id, list);
  });
  rolePermissionIds = new Map();
  (data.role_permissions || []).forEach((assignment) => {
    const list = rolePermissionIds.get(assignment.role_id) || [];
    list.push(assignment.permission_id);
    rolePermissionIds.set(assignment.role_id, list);
  });
  roleHistory = data.role_history || [];
  requests = data.leave_requests || [];
  payrollCache = data.payroll || [];
  attendanceCache = data.attendance || [];
  employmentStatusHistory = data.employment_status_history || [];
}

function latestPayroll(employeeId) {
  return payrollCache.find(
    (record) =>
      record.employee_id === employeeId &&
      record.pay_year !== null &&
      record.pay_year !== undefined &&
      record.pay_month !== null &&
      record.pay_month !== undefined,
  );
}

function fillSelect(select, options, valueKey, labelFor, selectedValue = "") {
  select.replaceChildren();
  options.forEach((item) => {
    const option = document.createElement("option");
    option.value = item[valueKey];
    option.textContent = labelFor(item);
    select.append(option);
  });
  if (options.some((item) => String(item[valueKey]) === String(selectedValue)))
    select.value = selectedValue;
}

const MANAGER_ROLE_NAMES = [
  "manager",
  "hr_manager",
  "quản lý",
  "quản lý nhân sự",
];

function normalizeFilterText(str) {
  return String(str || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "d")
    .trim();
}

function isLeaderEmployee(employee) {
  const currentRoleIds = roleAssignments.get(employee.employee_id) || [];
  const roleNames = currentRoleIds.map(
    (id) => roles.find((r) => r.role_id === id)?.role_name || "",
  );
  const normRoleNames = roleNames.map(normalizeFilterText);

  const hasLeaderRole = roleNames.some((rawName) => {
    const lower = rawName.toLowerCase();
    const norm = normalizeFilterText(rawName);
    return (
      norm.includes("truong nhom") ||
      norm.includes("nhom truong") ||
      lower.includes("team lead") ||
      lower.includes("team_lead") ||
      lower.includes("leader")
    );
  });

  const hasStaffRole = normRoleNames.some(
    (r) => r.includes("nhan vien") || r.includes("staff") || r.includes("employee"),
  );
  if (hasStaffRole && !hasLeaderRole) {
    return false;
  }

  const rawPos = positionName(employee);
  const lowerPos = rawPos.toLowerCase();
  const normPos = normalizeFilterText(rawPos);

  const hasLeaderPosition =
    normPos.includes("truong nhom") ||
    normPos.includes("nhom truong") ||
    lowerPos.includes("team lead") ||
    lowerPos.includes("team_lead") ||
    lowerPos.includes("leader") ||
    (lowerPos.includes("lead") && !lowerPos.includes("leader") && !normPos.includes("quan ly"));

  return hasLeaderRole || hasLeaderPosition;
}

function isManagerEmployee(employee) {
  const currentRoleIds = roleAssignments.get(employee.employee_id) || [];
  const roleNames = currentRoleIds.map(
    (id) => roles.find((r) => r.role_id === id)?.role_name || "",
  );
  const normRoleNames = roleNames.map(normalizeFilterText);

  const hasStaffRole = normRoleNames.some(
    (r) => r.includes("nhan vien") || r.includes("staff") || r.includes("employee"),
  );

  const hasManagerRole = roleNames.some((rawName) => {
    const lower = rawName.toLowerCase();
    const norm = normalizeFilterText(rawName);
    return (
      MANAGER_ROLE_NAMES.includes(lower) ||
      norm.includes("quan ly") ||
      lower.includes("manager") ||
      norm.includes("truong phong") ||
      norm.includes("giam doc")
    );
  });

  if (hasStaffRole && !hasManagerRole) {
    return false;
  }

  const rawPos = positionName(employee);
  const lowerPos = rawPos.toLowerCase();
  const normPos = normalizeFilterText(rawPos);

  const hasManagerPosition =
    normPos.includes("quan ly") ||
    lowerPos.includes("manager") ||
    normPos.includes("truong phong") ||
    normPos.includes("giam doc");

  return (hasManagerRole || hasManagerPosition) && !isLeaderEmployee(employee);
}

function isStaffEmployee(employee) {
  const currentRoleIds = roleAssignments.get(employee.employee_id) || [];
  const roleNames = currentRoleIds.map(
    (id) => roles.find((r) => r.role_id === id)?.role_name || "",
  );
  const normRoleNames = roleNames.map(normalizeFilterText);

  const hasStaffRole = normRoleNames.some(
    (r) => r.includes("nhan vien") || r.includes("staff") || r.includes("employee"),
  );
  if (hasStaffRole) {
    return true;
  }

  const rawPos = positionName(employee);
  const normPos = normalizeFilterText(rawPos);
  const lowerPos = rawPos.toLowerCase();
  const hasStaffPosition =
    normPos.includes("nhan vien") ||
    lowerPos.includes("staff") ||
    lowerPos.includes("employee");
  if (hasStaffPosition) {
    return true;
  }

  return !isManagerEmployee(employee) && !isLeaderEmployee(employee);
}

function isCurrentActorEmployee(employee) {
  if (!employee) return false;
  if (currentActor?.employee_id && employee.employee_id === currentActor.employee_id) {
    return true;
  }
  const actorEmail = (currentActor?.email || "").trim().toLowerCase();
  const empEmail = (employee.email || "").trim().toLowerCase();
  if (actorEmail && empEmail && actorEmail === empEmail) {
    return true;
  }
  const sessionUser = portal?.getSession("manager")?.user;
  if (sessionUser?.email && empEmail && sessionUser.email.trim().toLowerCase() === empEmail) {
    return true;
  }
  if (
    sessionUser?.username &&
    empEmail &&
    sessionUser.username.trim().toLowerCase() === empEmail
  ) {
    return true;
  }
  return false;
}

// Phản chiếu quy tắc của server (hr-portal / employee_delete).
function canDeleteEmployee(employee) {
  if (!currentActor) return false;
  if (isCurrentActorEmployee(employee)) return false;
  const names = (roleAssignments.get(employee.employee_id) || []).map(
    (id) => roles.find((r) => r.role_id === id)?.role_name?.toLowerCase() || "",
  );
  if (names.includes("admin")) return false;
  if (names.some((name) => MANAGER_ROLE_NAMES.includes(name))) return false;
  if (isManagerEmployee(employee)) return false;
  if (currentActor.is_admin || currentActor.is_hr) return true;
  return (
    Boolean(currentActor.department_id) &&
    employee.department_id === currentActor.department_id
  );
}

function renderEmployees() {
  const body = document.getElementById("employeesBody");
  const term = document
    .getElementById("employeeSearch")
    .value.trim()
    .toLowerCase();
  const positionFilter = document.getElementById(
    "employeePositionFilter",
  ).value;
  body.replaceChildren();
  const matches = employees.filter((employee) => {
    if (
      employee.deleted_at ||
      employee.is_active === false ||
      normalizedStatus(employee.employment_status) !== "active"
    ) {
      return false;
    }
    // Tài khoản manager đang sử dụng sẽ không hiển thị trong danh sách nhân sự
    if (isCurrentActorEmployee(employee)) {
      return false;
    }
    const employeeRoles = roleAssignments.get(employee.employee_id) || [];
    const isAdmin = employeeRoles.some((roleId) => {
      const r = roles.find((role) => role.role_id === roleId);
      return r && r.role_name.toLowerCase() === "admin";
    });
    if (isAdmin) {
      return false;
    }
    const currentRoleIds = roleAssignments.get(employee.employee_id) || [];
    const roleNamesText = currentRoleIds
      .map((id) => roles.find((r) => r.role_id === id)?.role_name || "")
      .join(" ");

    const matchesTerm = [
      employee.full_name,
      employee.employee_code,
      employee.email,
      positionName(employee),
      departmentName(employee),
      roleNamesText,
    ]
      .join(" ")
      .toLowerCase()
      .includes(term);

    let matchesPosition = true;
    if (positionFilter === "employee") {
      matchesPosition = isStaffEmployee(employee);
    } else if (positionFilter === "leader") {
      matchesPosition = isLeaderEmployee(employee);
    } else if (positionFilter === "manager") {
      matchesPosition = isManagerEmployee(employee);
    }

    return matchesTerm && matchesPosition;
  });
  if (!matches.length) {
    const row = document.createElement("tr");
    const hasEmployeesInScope = employees.some(
      (e) =>
        !e.deleted_at &&
        e.is_active !== false &&
        normalizedStatus(e.employment_status) === "active" &&
        !isCurrentActorEmployee(e),
    );
    addCell(
      row,
      hasEmployeesInScope
        ? "Không có nhân sự phù hợp."
        : "Chưa có nhân sự trong phạm vi của bạn.",
    ).colSpan = 9;
    body.append(row);
  }

  function employeeSortValue(employee, key) {
    if (key === "employee_code") return employee.employee_code || "";
    if (key === "full_name") return employee.full_name || "";
    if (key === "position" || key === "role") return positionName(employee);
    if (key === "department") return departmentName(employee);
    if (key === "education") return employee.education || "";
    if (key === "hire_date") return employee.hire_date || "";
    if (key === "base_salary") {
      const salary = latestPayroll(employee.employee_id)?.base_salary;
      return salary !== null &&
        salary !== undefined &&
        salary !== "" &&
        Number.isFinite(Number(salary))
        ? Number(salary)
        : null;
    }
    if (key === "status") {
      return STATUS_LABELS[normalizedStatus(employee.employment_status)] || "";
    }
    return "";
  }
  matches.sort((left, right) => {
    const leftValue = employeeSortValue(left, employeeSort.key);
    const rightValue = employeeSortValue(right, employeeSort.key);
    if (leftValue === rightValue) return 0;
    if (leftValue === null || leftValue === "") return 1;
    if (rightValue === null || rightValue === "") return -1;
    return (
      String(leftValue).localeCompare(String(rightValue), "vi", {
        numeric: true,
        sensitivity: "base",
      }) * employeeSort.direction
    );
  });

  const totalMatches = matches.length;
  const pageCount = Math.max(1, Math.ceil(totalMatches / employeePagination.size));
  employeePagination.page = Math.min(employeePagination.page, pageCount);
  const start = (employeePagination.page - 1) * employeePagination.size;
  const pageMatches = matches.slice(start, start + employeePagination.size);

  pageMatches.forEach((employee) => {
    const row = document.createElement("tr");
    row.dataset.employeeId = employee.employee_id;
    row.classList.add("hr-employee-row");
    addCell(row, employee.employee_code || "-");
    const identity = document.createElement("td");
    const name = document.createElement("strong");
    name.textContent = employee.full_name;
    const email = document.createElement("small");
    email.textContent = employee.email;
    identity.append(name, email);
    row.append(identity);
    addCell(row, positionName(employee));
    addCell(row, departmentName(employee));
    addCell(row, employee.education || "-");
    addCell(row, dateLabel(employee.hire_date));
    const baseSalary = latestPayroll(employee.employee_id)?.base_salary;
    addCell(
      row,
      baseSalary === null ||
        baseSalary === undefined ||
        baseSalary === "" ||
        !Number.isFinite(Number(baseSalary))
        ? "Chưa có lương"
        : money(baseSalary),
    );
    const statusCell = document.createElement("td");
    statusCell.append(statusBadge(employee.employment_status));
    row.append(statusCell);
    const actionsCell = document.createElement("td");
    actionsCell.className = "hr-actions-column";
    const actions = document.createElement("div");
    actions.className = "hr-row-actions";
    const viewOrRemove = document.createElement("button");
    viewOrRemove.type = "button";
    viewOrRemove.dataset.employeeId = employee.employee_id;

    const canDelete = canDeleteEmployee(employee);
    if (canDelete) {
      viewOrRemove.className = "mini-btn danger";
      viewOrRemove.dataset.employeeAction = "delete";
      viewOrRemove.textContent = "Xóa";
    }

    if (canDelete) actions.append(viewOrRemove);
    actionsCell.append(actions);
    row.append(actionsCell);
    body.append(row);
  });
  renderPagination(
    "employeesPagination",
    totalMatches,
    employeePagination,
    renderEmployees,
  );
}

function renderEmployeePositionFilter() {
  const select = document.getElementById("employeePositionFilter");
  if (!select) return;
  const selected = select.value || "all";
  select.replaceChildren(
    new Option("Tất cả chức vụ", "all"),
    new Option("Nhân viên", "employee"),
    new Option("Trưởng nhóm", "leader"),
    new Option("Quản lý", "manager"),
  );
  select.value = ["all", "employee", "leader", "manager"].includes(selected)
    ? selected
    : "all";
}

function fillRoleSelect(select, selectedValue = "", roleOptions = roles) {
  select.replaceChildren();
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = "Chọn vai trò";
  select.append(placeholder);
  roleOptions.forEach((role) => {
    const option = document.createElement("option");
    option.value = role.role_id;
    option.textContent =
      role.assignable === false
        ? `${role.role_name} · chỉ Admin gán`
        : role.role_name;
    option.disabled =
      role.assignable === false && role.role_id !== selectedValue;
    select.append(option);
  });
  const selectedRole = roles.find(
    (role) => String(role.role_id) === String(selectedValue),
  );
  select.value = selectedRole ? selectedRole.role_id : "";
}

function showEmployeeForm(employee = null) {
  const form = document.getElementById("employeeForm");
  form.reset();
  form.elements.namedItem("id").value = employee?.employee_id || "";

  const saveButton = document.getElementById("saveEmployeeBtn");
  saveButton.innerHTML = "";
  const saveIcon = document.createElement("img");
  saveIcon.src = employee
    ? "../shared/images/save.png"
    : "../shared/images/user-add.png";
  saveIcon.alt = "";
  saveIcon.className = "button-icon";
  saveButton.append(
    saveIcon,
    document.createTextNode(employee ? "Lưu thông tin" : "Thêm nhân sự"),
  );

  const departmentSelect = document.getElementById("employeeDepartment");
  const departmentGroup = document.getElementById("employeeDepartmentGroup");
  fillSelect(
    departmentSelect,
    departments,
    "department_id",
    (department) => department.department_name,
    employee?.department_id || "",
  );
  const canChooseDepartment = Boolean(
    currentActor?.is_admin || currentActor?.is_hr,
  );
  if (!canChooseDepartment) {
    departmentSelect.value = currentActor?.department_id || "";
  }
  departmentGroup.hidden = !canChooseDepartment;
  const dateOfBirthInput = form.elements.namedItem("dateOfBirth");
  const passwordInput = form.elements.namedItem("password");
  const passwordGroup = passwordInput.closest(".form-group");
  dateOfBirthInput.max = new Date(
    new Date().getFullYear() - 18,
    new Date().getMonth(),
    new Date().getDate(),
  )
    .toISOString()
    .slice(0, 10);

  if (employee) {
    const contact = contacts.get(employee.employee_id);
    const values = {
      name: employee.full_name,
      email: employee.email,
      phone: contact?.phone_number || "",
      education: employee.education || "",
      dateOfBirth: employee.date_of_birth
        ? String(employee.date_of_birth).trim().slice(0, 10)
        : "",
      hireDate: employee.hire_date
        ? String(employee.hire_date).trim().slice(0, 10)
        : "",
      employmentStatus:
        STATUS_LABELS[normalizedStatus(employee.employment_status)],
    };
    Object.entries(values).forEach(([key, value]) => {
      if (form.elements.namedItem(key))
        form.elements.namedItem(key).value = value;
    });
    const currentRoles = roleAssignments.get(employee.employee_id) || [];
    if (currentRoles.length > 0) {
      form.elements.namedItem("roleId").value = currentRoles[0];
    } else {
      form.elements.namedItem("roleId").value = "";
    }
    dateOfBirthInput.required = false;
    passwordInput.required = false;
    passwordInput.readOnly = true;
    passwordGroup.hidden = true;

    Array.from(form.elements).forEach((el) => {
      if (el.name !== "id" && el.id !== "cancelEmployeeBtn") {
        el.disabled = true;
      }
    });
    if (saveButton) {
      saveButton.style.display = "none";
    }
    document.getElementById("employeeFormTitle").textContent =
      "Chi tiết hồ sơ nhân sự";
  } else {
    form.elements.namedItem("hireDate").value = new Date()
      .toISOString()
      .slice(0, 10);
    dateOfBirthInput.required = true;
    passwordInput.required = true;
    passwordInput.readOnly = true;
    passwordInput.placeholder = "Mật khẩu tạo tự động theo vai trò, phòng ban, ngày sinh";
    passwordGroup.hidden = false;
    updateGeneratedEmployeePassword();

    // MỞ KHÓA FORM VÀ HIỆN LẠI NÚT LƯU KHI THÊM MỚI
    Array.from(form.elements).forEach((el) => {
      el.disabled = false;
    });
    if (saveButton) {
      saveButton.style.display = "inline-flex";
    }
  }

  document.getElementById("addEmployeeModal").classList.remove("hidden");
}

document
  .getElementById("addEmployeeBtn")
  .addEventListener("click", () => showEmployeeForm());
const closeEmployeeModal = () => {
  document.getElementById("addEmployeeModal").classList.add("hidden");
  document.getElementById("employeeForm").reset();
};
document
  .getElementById("cancelEmployeeBtn")
  .addEventListener("click", closeEmployeeModal);
document
  .getElementById("closeModalBtn")
  .addEventListener("click", closeEmployeeModal);

function abbreviatePosition(positionName) {
  const normalized = String(positionName || "")
    .trim()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D");
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

function updateGeneratedEmployeePassword() {
  const form = document.getElementById("employeeForm");
  if (!form || form.elements.namedItem("id")?.value) return;

  const roleSelect = form.elements.namedItem("roleId");
  const roleOption = roleSelect?.selectedOptions?.[0];
  const roleName = roleOption?.value ? roleOption.textContent : "";

  const departmentSelect = form.elements.namedItem("departmentId");
  const departmentId =
    departmentSelect?.value || currentActor?.department_id || "";
  const department = departments.find(
    (d) => String(d.department_id) === String(departmentId),
  );
  const departmentDescription =
    department?.description || department?.department_name || "";

  const dateOfBirth = form.elements.namedItem("dateOfBirth")?.value || "";

  const passwordInput = form.elements.namedItem("password");
  if (!passwordInput) return;

  passwordInput.value = generateAccountPassword(
    roleName,
    departmentDescription,
    dateOfBirth,
  );
}

const employeeForm = document.getElementById("employeeForm");
if (employeeForm) {
  const dateInput = employeeForm.elements.namedItem("dateOfBirth");
  if (dateInput) {
    dateInput.addEventListener("input", updateGeneratedEmployeePassword);
    dateInput.addEventListener("change", updateGeneratedEmployeePassword);
  }
  const roleInput = employeeForm.elements.namedItem("roleId");
  if (roleInput) {
    roleInput.addEventListener("change", updateGeneratedEmployeePassword);
  }
  const deptInput = employeeForm.elements.namedItem("departmentId");
  if (deptInput) {
    deptInput.addEventListener("change", updateGeneratedEmployeePassword);
  }
  const posInput = employeeForm.elements.namedItem("positionId");
  if (posInput) {
    posInput.addEventListener("change", updateGeneratedEmployeePassword);
  }
}

document
  .getElementById("employeeSearch")
  .addEventListener("input", renderEmployees);
document
  .getElementById("employeePositionFilter")
  .addEventListener("change", () => {
    employeePagination.page = 1;
    renderEmployees();
  });
document
  .getElementById("employeeRefreshBtn")
  .addEventListener("click", async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    button.classList.add("is-loading");
    try {
      await loadLookups();
      employeePagination.page = 1;
      renderAll();
    } catch (error) {
      showError("Không thể làm mới danh sách nhân sự.");
      console.error("employee refresh failed", error);
    } finally {
      button.classList.remove("is-loading");
      button.disabled = false;
    }
  });
document.querySelectorAll("[data-employee-sort]").forEach((button) => {
  button.addEventListener("click", () => {
    const key = button.dataset.employeeSort;
    employeeSort.direction =
      employeeSort.key === key ? employeeSort.direction * -1 : 1;
    employeeSort.key = key;
    document.querySelectorAll("[data-employee-sort]").forEach((item) => {
      item.classList.remove("is-ascending", "is-descending");
    });
    button.classList.add(
      employeeSort.direction === 1 ? "is-ascending" : "is-descending",
    );
    renderEmployees();
  });
});
document
  .getElementById("employeesBody")
  .addEventListener("click", async (event) => {
    const actionBtn = event.target.closest("[data-employee-action]");

    if (actionBtn && actionBtn.dataset.employeeAction === "delete") {
      const employee = employees.find(
        (item) => item.employee_id === actionBtn.dataset.employeeId,
      );
      if (!employee) return;

      if (
        !window.confirm(
          `Xóa hồ sơ ${employee.full_name}? Tài khoản sẽ bị vô hiệu hóa (xóa mềm) và nhân sự sẽ không còn hiển thị trong danh sách.`,
        )
      ) {
        return;
      }

      const result = await callHr({
        action: "employee_delete",
        id: employee.employee_id,
      });

      if (!result.ok) {
        const DELETE_ERRORS = {
          forbidden_self_delete: "Bạn không thể tự xóa hồ sơ của mình.",
          forbidden_cannot_delete_admin: "Không thể xóa tài khoản Admin.",
          forbidden_manager_cannot_delete_manager:
            "Quản lý không được xóa tài khoản quản lý khác.",
          forbidden_out_of_scope:
            "Bạn chỉ được xóa nhân viên thuộc phòng ban của mình.",
          already_deleted: "Hồ sơ này đã được xóa trước đó.",
        };
        window.alert(
          DELETE_ERRORS[result.error] ||
            "Không thể xóa hồ sơ. Kiểm tra bản ghi liên quan và quyền của bạn.",
        );
        return;
      }
      await loadLookups();
      renderAll();
      showToast("deleteToast");
      return;
    }

    const row = event.target.closest("tr");
    if (row && row.dataset.employeeId) {
      const employee = employees.find(
        (item) => item.employee_id === row.dataset.employeeId,
      );
      if (employee) {
        showEmployeeForm(employee);
      }
    }
  });
document
  .getElementById("employeeForm")
  .addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const values = Object.fromEntries(new FormData(form).entries());
    const result = await callHr({
      action: "employee_save",
      id: values.id || undefined,
      full_name: String(values.name).trim(),
      email: String(values.email).trim().toLowerCase(),
      position_id: values.positionId,
      department_id: values.departmentId || undefined,
      date_of_birth: values.dateOfBirth || null,
      education: String(values.education || "").trim(),
      hire_date: values.hireDate,
      employment_status: STATUS_TO_DB[values.employmentStatus] || "active",
      phone_number: String(values.phone || "").trim(),
      role_id: values.roleId || undefined,
      password: String(values.password || "").trim(),
    });
    if (!result.ok) {
      feedback("employeeFeedback", "Không lưu được hồ sơ nhân sự.", true);
      return;
    }
    const wasNewEmployee = !values.id;
    closeEmployeeModal();
    feedback("employeeFeedback", "");
    await loadLookups();
    renderAll();
    if (wasNewEmployee) showToast("successToast");
  });

function showToast(id) {
  const toast = document.getElementById(id);
  if (!toast) return;
  toast.classList.add("show");
  window.setTimeout(() => toast.classList.remove("show"), 5000);
}

function renderRequests() {
  const filter = document.getElementById("requestFilter")?.value || "all";
  const searchInput = document.getElementById("requestSearch");
  const searchTerm = (searchInput?.value || "").trim().toLowerCase();
  const body = document.getElementById("requestsBody");
  if (!body) return;
  body.replaceChildren();

  const filtered = requests.filter((request) => {
    const status = String(request.status || "").toLowerCase();
    if (filter === "pending" && status !== "pending") return false;
    if (filter === "approved" && status !== "approved") return false;
    if (filter === "rejected" && status !== "rejected") return false;
    if (filter === "resolved" && status === "pending") return false;

    if (searchTerm) {
      const employee = employees.find(
        (item) => item.employee_id === request.employee_id,
      );
      const name = (employee?.full_name || "Nhân sự đã xóa").toLowerCase();
      const email = (employee?.email || "").toLowerCase();
      const code = (employee?.employee_code || "").toLowerCase();
      const typeLabel = (LEAVE_TYPES[request.leave_type] || "").toLowerCase();
      const reason = (request.reason || "").toLowerCase();
      const statusLabel = (LEAVE_STATUSES[request.status] || "").toLowerCase();

      const matched =
        name.includes(searchTerm) ||
        email.includes(searchTerm) ||
        code.includes(searchTerm) ||
        typeLabel.includes(searchTerm) ||
        reason.includes(searchTerm) ||
        statusLabel.includes(searchTerm);
      if (!matched) return false;
    }

    return true;
  });

  // Sort: pending first, then by date descending
  filtered.sort((a, b) => {
    const aPending = a.status === "pending" ? 1 : 0;
    const bPending = b.status === "pending" ? 1 : 0;
    if (aPending !== bPending) return bPending - aPending;
    return String(b.start_date || "").localeCompare(String(a.start_date || ""));
  });

  const totalMatches = filtered.length;
  const pageCount = Math.max(1, Math.ceil(totalMatches / requestPagination.size));
  requestPagination.page = Math.min(requestPagination.page, pageCount);
  const start = (requestPagination.page - 1) * requestPagination.size;
  const pageRequests = filtered.slice(start, start + requestPagination.size);

  if (!pageRequests.length) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 6;
    cell.style.textAlign = "center";
    cell.style.padding = "36px 14px";
    cell.style.color = "var(--admin-muted, #747b74)";
    cell.textContent = searchTerm
      ? "Không tìm thấy đơn nghỉ phép phù hợp với tìm kiếm."
      : "Không có đơn trong danh sách.";
    row.append(cell);
    body.append(row);
  } else {
    pageRequests.forEach((request) => {
      const employee = employees.find(
        (item) => item.employee_id === request.employee_id,
      );
      const row = document.createElement("tr");

      // 1. Nhân sự
      const identity = document.createElement("td");
      const wrap = document.createElement("div");
      wrap.className = "hr-employee-cell";
      const name = document.createElement("strong");
      name.className = "hr-employee-name";
      name.textContent = employee?.full_name || "Nhân sự đã xóa";
      wrap.append(name);
      if (employee?.email) {
        const email = document.createElement("small");
        email.className = "hr-employee-email";
        email.textContent = employee.email;
        wrap.append(email);
      }
      identity.append(wrap);
      row.append(identity);

      // 2. Loại đơn
      const typeCell = document.createElement("td");
      const typeBadge = document.createElement("span");
      typeBadge.className = `hr-leave-type-badge hr-leave-${request.leave_type || "default"}`;
      typeBadge.textContent = LEAVE_TYPES[request.leave_type] || "Chưa phân loại";
      typeCell.append(typeBadge);
      row.append(typeCell);

      // 3. Thời gian
      const timeCell = document.createElement("td");
      const timeWrap = document.createElement("div");
      timeWrap.className = "hr-time-cell";
      const timeRange = document.createElement("span");
      timeRange.className = "hr-time-range";

      if (request.leave_type === "resignation") {
        timeRange.textContent = `Ngày dự kiến cuối: ${dateLabel(request.start_date)}`;
        timeWrap.append(timeRange);
      } else {
        const startLabel = dateLabel(request.start_date);
        const endLabel = dateLabel(request.end_date);
        timeRange.textContent = startLabel === endLabel ? startLabel : `${startLabel} - ${endLabel}`;
        timeWrap.append(timeRange);

        if (request.start_date && request.end_date) {
          const s = new Date(request.start_date);
          const e = new Date(request.end_date);
          const diffDays = Math.round(Math.abs(e.getTime() - s.getTime()) / (1000 * 60 * 60 * 24)) + 1;
          if (!isNaN(diffDays) && diffDays > 0) {
            const daysSpan = document.createElement("small");
            daysSpan.className = "hr-time-days";
            daysSpan.textContent = `(${diffDays} ngày)`;
            timeWrap.append(daysSpan);
          }
        }
      }
      timeCell.append(timeWrap);
      row.append(timeCell);

      // 4. Lý do
      const reasonCell = document.createElement("td");
      reasonCell.className = "hr-reason-cell";
      reasonCell.textContent = request.reason || "—";
      if (request.reason) {
        reasonCell.title = request.reason;
      }
      row.append(reasonCell);

      // 5. Trạng thái
      const statusCell = document.createElement("td");
      statusCell.className = "hr-status-column";
      const badge = document.createElement("span");
      const statusKey = String(request.status || "pending").toLowerCase();
      badge.className = `hr-status hr-status-${statusKey}`;
      badge.textContent = LEAVE_STATUSES[request.status] || request.status;
      statusCell.append(badge);
      row.append(statusCell);

      // 6. Thao tác
      const actionsCell = document.createElement("td");
      actionsCell.className = "hr-actions-column";
      const actions = document.createElement("div");
      actions.className = "hr-row-actions";
      if (request.status === "pending") {
        const approveBtn = document.createElement("button");
        approveBtn.type = "button";
        approveBtn.className = "hr-btn-approve";
        approveBtn.dataset.reviewStatus = "approved";
        approveBtn.dataset.requestId = request.leave_request_id;
        approveBtn.textContent = "Duyệt";

        const rejectBtn = document.createElement("button");
        rejectBtn.type = "button";
        rejectBtn.className = "hr-btn-reject";
        rejectBtn.dataset.reviewStatus = "rejected";
        rejectBtn.dataset.requestId = request.leave_request_id;
        rejectBtn.textContent = "Từ chối";

        actions.append(approveBtn, rejectBtn);
      } else {
        const done = document.createElement("span");
        done.className = "hr-action-done";
        done.textContent = "—";
        actions.append(done);
      }
      actionsCell.append(actions);
      row.append(actionsCell);

      body.append(row);
    });
  }

  renderPagination(
    "requestsPagination",
    totalMatches,
    requestPagination,
    renderRequests,
  );
}

document
  .getElementById("requestFilter")
  ?.addEventListener("change", () => {
    requestPagination.page = 1;
    renderRequests();
  });

document
  .getElementById("requestSearch")
  ?.addEventListener("input", () => {
    requestPagination.page = 1;
    renderRequests();
  });

document
  .getElementById("requestsBody")
  ?.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-review-status]");
    if (!button || button.disabled) return;
    const reviewStatus = button.dataset.reviewStatus;
    const requestId = button.dataset.requestId;
    const actionText = reviewStatus === "approved" ? "duyệt" : "từ chối";

    if (!window.confirm(`Bạn có chắc muốn ${actionText} đơn nghỉ này không?`)) {
      return;
    }

    button.disabled = true;
    const prevText = button.textContent;
    button.textContent = "...";

    const result = await callHr({
      action: "leave_review",
      leave_request_id: requestId,
      status: reviewStatus,
    });

    if (!result.ok) {
      button.disabled = false;
      button.textContent = prevText;
      const reasons = {
        forbidden:
          "Bạn không có quyền duyệt đơn này (không duyệt đơn của chính mình).",
        already_decided: "Đơn này đã được xử lý trước đó.",
        invalid_reference: "Không tìm thấy đơn nghỉ.",
      };
      window.alert(
        reasons[result.error] ||
          "Không cập nhật được đơn. Kiểm tra trạng thái hợp lệ.",
      );
      return;
    }

    const reviewToast = document.getElementById("reviewToast");
    if (reviewToast) {
      const span = reviewToast.querySelector("span");
      if (span) {
        span.textContent =
          reviewStatus === "approved"
            ? "Đã duyệt đơn nghỉ thành công!"
            : "Đã từ chối đơn nghỉ thành công!";
      }
      showToast("reviewToast");
    }

    await loadLookups();
    renderAll();
  });

function monthBounds(value) {
  const [year, month] = value.split("-").map(Number);
  const monthText = String(month).padStart(2, "0");
  const end = `${year}-${monthText}-${String(new Date(year, month, 0).getDate()).padStart(2, "0")}`;
  const today = vietnamDateISO();
  const asOf = value === today.slice(0, 7) ? today : end;
  return { year, month, start: `${year}-${monthText}-01`, end, asOf };
}

function approvedLeavesInPeriod(employee, range) {
  return requests.filter(
    (request) =>
      request.employee_id === employee.employee_id &&
      request.status === "approved" &&
      request.leave_type !== "resignation" &&
      request.start_date <= range.asOf &&
      request.end_date >= range.start,
  );
}

function monthlyStatus(employee, range) {
  if (employee.hire_date > range.asOf) return null;
  const periodHistory = employmentStatusHistory.filter(
    (item) =>
      item.employee_id === employee.employee_id &&
      item.effective_from <= range.asOf &&
      (!item.effective_to || item.effective_to >= range.start),
  );
  const approvedLeaves = approvedLeavesInPeriod(employee, range);
  const resignationRequests = requests.filter(
    (request) =>
      request.employee_id === employee.employee_id &&
      request.leave_type === "resignation" &&
      request.status === "approved" &&
      request.start_date >= range.start &&
      request.start_date <= range.asOf,
  );
  const hasWorkStatus = periodHistory.some(
    (item) => normalizedStatus(item.employment_status) === "active",
  );
  const hasLeaveStatus = periodHistory.some(
    (item) => normalizedStatus(item.employment_status) === "on_leave",
  );
  const resignationHistory = periodHistory.filter(
    (item) =>
      normalizedStatus(item.employment_status) === "resigned" &&
      item.is_baseline !== true &&
      item.effective_from >= range.start &&
      item.effective_from <= range.asOf,
  );
  const statusSet = new Set();
  if (hasWorkStatus) statusSet.add("active");
  if (hasLeaveStatus || approvedLeaves.length) statusSet.add("on_leave");
  if (resignationHistory.length || resignationRequests.length)
    statusSet.add("resigned");

  const notes = [];
  if (hasWorkStatus) notes.push("Có trạng thái làm việc trong kỳ");
  approvedLeaves.forEach((leave) => {
    const leaveName = LEAVE_TYPES[leave.leave_type] || "Nghỉ phép";
    const leaveNote = `${leaveName}: ${dateLabel(leave.start_date)} – ${dateLabel(leave.end_date)}`;
    if (!notes.includes(leaveNote)) notes.push(leaveNote);
  });
  if (hasLeaveStatus && !approvedLeaves.length)
    notes.push("Hồ sơ ghi nhận nghỉ phép trong kỳ");
  [
    ...resignationHistory.map((item) => item.effective_from),
    ...resignationRequests.map((request) => request.start_date),
  ]
    .filter((date, index, values) => values.indexOf(date) === index)
    .forEach((date) => notes.push(`Nghỉ việc có hiệu lực ${dateLabel(date)}`));

  const baselineResignedDuringPeriod = periodHistory.some(
    (item) =>
      item.is_baseline === true &&
      normalizedStatus(item.employment_status) === "resigned" &&
      item.effective_from >= range.start &&
      item.effective_from <= range.asOf,
  );
  if (
    !statusSet.size &&
    (!periodHistory.length || baselineResignedDuringPeriod)
  ) {
    statusSet.add("unknown");
    notes.push(
      baselineResignedDuringPeriod
        ? "Đã nghỉ tại mốc tạo lịch sử; ngày nghỉ thực tế chưa được ghi nhận"
        : "Không có dữ liệu lịch sử cho tháng này",
    );
  }
  if (!statusSet.size) return null;
  return { statuses: [...statusSet], note: notes.join(" · ") || "-" };
}

let monthlyReportRows = [];
let visibleMonthlyReportRows = [];

function renderMonthlyReport() {
  const monthInput = document.getElementById("staffReportMonth").value;
  if (!monthInput) return;
  const range = monthBounds(monthInput);
  const body = document.getElementById("monthlyStaffBody");
  body.replaceChildren();
  const counts = { active: 0, on_leave: 0, resigned: 0, unknown: 0 };
  monthlyReportRows = employees.flatMap((employee) => {
    const state = monthlyStatus(employee, range);
    return state ? [{ employee, ...state }] : [];
  });
  monthlyReportRows.forEach(({ statuses }) =>
    statuses.forEach((status) => {
      counts[status] += 1;
    }),
  );
  const search = document
    .getElementById("monthlyStaffSearch")
    .value.trim()
    .toLocaleLowerCase("vi");
  const statusFilter = document.getElementById("monthlyStaffFilter").value;
  visibleMonthlyReportRows = monthlyReportRows.filter(
    ({ employee, statuses }) => {
      const matchesSearch = [
        employee.full_name,
        employee.employee_code,
        employee.email,
        departmentName(employee),
        positionName(employee),
      ]
        .join(" ")
        .toLocaleLowerCase("vi")
        .includes(search);
      return (
        matchesSearch &&
        (statusFilter === "all" || statuses.includes(statusFilter))
      );
    },
  );
  if (!visibleMonthlyReportRows.length) {
    const row = document.createElement("tr");
    addCell(
      row,
      monthlyReportRows.length
        ? "Không có nhân sự phù hợp với bộ lọc."
        : "Không có nhân sự thuộc kỳ báo cáo này.",
    ).colSpan = 5;
    body.append(row);
  }
  visibleMonthlyReportRows.forEach(({ employee, statuses, note }) => {
    const row = document.createElement("tr");
    addCell(row, employee.full_name);
    addCell(row, departmentName(employee));
    addCell(row, positionName(employee));
    const cell = document.createElement("td");
    statuses.forEach((status) =>
      cell.append(statusBadge(status, MONTHLY_STATUS_LABELS[status])),
    );
    row.append(cell);
    addCell(row, note || "-");
    body.append(row);
  });
  const summary = document.getElementById("monthlyStaffSummary");
  summary.replaceChildren();
  [
    ["Làm việc trong tháng", counts.active],
    ["Có nghỉ phép trong tháng", counts.on_leave],
    ["Nghỉ việc trong tháng", counts.resigned],
    ["Chưa có lịch sử", counts.unknown],
  ].forEach(([label, value]) => {
    const card = document.createElement("article");
    card.className = "hr-summary-card";
    const caption = document.createElement("span");
    caption.textContent = label;
    const total = document.createElement("strong");
    total.textContent = value;
    card.append(caption, total);
    summary.append(card);
  });
}

document.getElementById("staffReportMonth").value = vietnamDateISO().slice(
  0,
  7,
);
document.getElementById("staffReportMonth").max = vietnamDateISO().slice(0, 7);
document
  .getElementById("staffReportMonth")
  .addEventListener("change", renderMonthlyReport);
document
  .getElementById("monthlyStaffSearch")
  .addEventListener("input", renderMonthlyReport);
document
  .getElementById("monthlyStaffFilter")
  .addEventListener("change", renderMonthlyReport);

function vietnamDateISO(date = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Ho_Chi_Minh",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    })
      .formatToParts(date)
      .map(({ type, value }) => [type, value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function fullMonthsBetween(startValue, endValue) {
  const start = new Date(`${String(startValue).slice(0, 10)}T00:00:00`);
  const end = new Date(`${String(endValue).slice(0, 10)}T00:00:00`);
  if (
    !Number.isFinite(start.getTime()) ||
    !Number.isFinite(end.getTime()) ||
    end < start
  )
    return 0;
  let months =
    (end.getFullYear() - start.getFullYear()) * 12 +
    end.getMonth() -
    start.getMonth();
  if (end.getDate() < start.getDate()) months -= 1;
  return Math.max(0, months);
}

function employeeTenure(employee, asOf = vietnamDateISO()) {
  if (employee.hire_date > asOf)
    return { months: 0, endDate: asOf, ended: false, future: true };
  const currentHistory = employmentStatusHistory
    .filter(
      (item) =>
        item.employee_id === employee.employee_id &&
        item.effective_from <= asOf &&
        (!item.effective_to || item.effective_to >= asOf),
    )
    .sort((a, b) =>
      String(b.effective_from).localeCompare(String(a.effective_from)),
    )[0];
  const endedAt =
    currentHistory &&
    normalizedStatus(currentHistory.employment_status) === "resigned"
      ? currentHistory.effective_from
      : normalizedStatus(employee.employment_status) === "resigned"
        ? asOf
        : null;
  const endDate = endedAt || asOf;
  return {
    months: fullMonthsBetween(employee.hire_date, endDate),
    endDate,
    ended: Boolean(endedAt),
  };
}

function tenureLabel(employee) {
  const { months, ended, future } = employeeTenure(employee);
  if (future) return "Chưa đến ngày nhận việc";
  const years = Math.floor(months / 12);
  const remainder = months % 12;
  const duration = years
    ? `${years} năm ${remainder} tháng`
    : `${months} tháng`;
  return ended ? `${duration} (đã nghỉ)` : duration;
}

function salaryValue(employee) {
  const salary = latestPayroll(employee.employee_id)?.base_salary;
  return salary === null ||
    salary === undefined ||
    salary === "" ||
    !Number.isFinite(Number(salary))
    ? null
    : Number(salary);
}

function median(values) {
  if (!values.length) return null;
  const ordered = [...values].sort((a, b) => a - b);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2
    ? ordered[middle]
    : (ordered[middle - 1] + ordered[middle]) / 2;
}

function renderDistribution(containerId, entries) {
  const container = document.getElementById(containerId);
  container.replaceChildren();
  const maximum = Math.max(0, ...entries.map(([, count]) => count));
  const total = entries.reduce((sum, [, count]) => sum + count, 0);
  if (!entries.length || !maximum) {
    const empty = document.createElement("p");
    empty.className = "hr-distribution-empty";
    empty.textContent = "Chưa có dữ liệu để thống kê.";
    container.append(empty);
    return;
  }
  entries.forEach(([label, count]) => {
    const row = document.createElement("div");
    row.className = "hr-distribution-row";
    const name = document.createElement("span");
    name.textContent = label;
    const track = document.createElement("div");
    track.className = "hr-distribution-track";
    track.setAttribute("role", "img");
    track.setAttribute("aria-label", `${label}: ${count} nhân sự`);
    const bar = document.createElement("div");
    bar.className = "hr-distribution-bar";
    bar.style.width = `${(count / maximum) * 100}%`;
    track.append(bar);
    const value = document.createElement("strong");
    value.textContent = `${count} (${Math.round((count / total) * 100)}%)`;
    row.append(name, track, value);
    container.append(row);
  });
}

let visibleStaffStats = [];

function renderStaffStats() {
  const employeesWithStats = employees.map((employee) => ({
    employee,
    salary: salaryValue(employee),
    tenure: employeeTenure(employee),
    education: employee.education || "Chưa cập nhật",
  }));
  const salaries = employeesWithStats
    .map(({ salary }) => salary)
    .filter((salary) => salary !== null);
  const average = salaries.length
    ? salaries.reduce((sum, value) => sum + value, 0) / salaries.length
    : null;
  const medianSalary = median(salaries);
  const salaryRange = salaries.length
    ? `${money(Math.min(...salaries))} – ${money(Math.max(...salaries))}`
    : "Chưa có dữ liệu";
  const summary = document.getElementById("staffStatsSummary");
  summary.replaceChildren();
  [
    ["Tổng nhân sự", employeesWithStats.length],
    ["Có dữ liệu lương", `${salaries.length}/${employeesWithStats.length}`],
    [
      "Lương cơ bản bình quân",
      average === null ? "Chưa có dữ liệu" : money(average),
    ],
    [
      "Lương cơ bản trung vị",
      medianSalary === null ? "Chưa có dữ liệu" : money(medianSalary),
    ],
    ["Khoảng lương thấp–cao", salaryRange],
  ].forEach(([label, value]) => {
    const card = document.createElement("article");
    card.className = "hr-summary-card";
    const caption = document.createElement("span");
    caption.textContent = label;
    const strong = document.createElement("strong");
    strong.textContent = value;
    card.append(caption, strong);
    summary.append(card);
  });

  const educationCounts = new Map();
  employeesWithStats.forEach(({ education }) =>
    educationCounts.set(education, (educationCounts.get(education) || 0) + 1),
  );
  const educationEntries = [...educationCounts.entries()].sort(
    (a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "vi"),
  );
  renderDistribution("educationDistribution", educationEntries);

  const tenureRanges = [
    ["Dưới 1 năm", 0],
    ["1 đến dưới 3 năm", 0],
    ["3 đến dưới 5 năm", 0],
    ["Từ 5 năm", 0],
    ["Chưa đến ngày nhận việc", 0],
  ];
  employeesWithStats.forEach(({ tenure }) => {
    if (tenure.future) {
      tenureRanges[4][1] += 1;
      return;
    }
    const index =
      tenure.months < 12
        ? 0
        : tenure.months < 36
          ? 1
          : tenure.months < 60
            ? 2
            : 3;
    tenureRanges[index][1] += 1;
  });
  renderDistribution("tenureDistribution", tenureRanges);

  const educationFilter = document.getElementById("staffStatsEducationFilter");
  const previousEducation = educationFilter.value || "all";
  educationFilter.replaceChildren();
  const allOption = document.createElement("option");
  allOption.value = "all";
  allOption.textContent = "Tất cả trình độ";
  educationFilter.append(allOption);
  educationEntries.forEach(([education]) => {
    const option = document.createElement("option");
    option.value = education;
    option.textContent = education;
    educationFilter.append(option);
  });
  if (
    ["all", ...educationEntries.map(([education]) => education)].includes(
      previousEducation,
    )
  )
    educationFilter.value = previousEducation;

  const search = document
    .getElementById("staffStatsSearch")
    .value.trim()
    .toLocaleLowerCase("vi");
  const selectedEducation = educationFilter.value;
  visibleStaffStats = employeesWithStats.filter(({ employee, education }) => {
    const matchesSearch = [
      employee.full_name,
      employee.employee_code,
      employee.email,
    ]
      .join(" ")
      .toLocaleLowerCase("vi")
      .includes(search);
    return (
      matchesSearch &&
      (selectedEducation === "all" || education === selectedEducation)
    );
  });
  const body = document.getElementById("staffStatsBody");
  body.replaceChildren();
  if (!visibleStaffStats.length) {
    const row = document.createElement("tr");
    addCell(
      row,
      employees.length
        ? "Không có nhân sự phù hợp với bộ lọc."
        : "Chưa có nhân sự trong phạm vi của bạn.",
    ).colSpan = 6;
    body.append(row);
  }
  visibleStaffStats.forEach(({ employee, salary, education }) => {
    const row = document.createElement("tr");
    const identity = document.createElement("td");
    const name = document.createElement("strong");
    name.textContent = employee.full_name;
    const code = document.createElement("small");
    code.textContent = employee.employee_code || employee.email || "";
    identity.append(name, code);
    row.append(identity);
    addCell(row, education);
    addCell(row, salary === null ? "Chưa có lương" : money(salary));
    const payroll = latestPayroll(employee.employee_id);
    addCell(
      row,
      payroll?.pay_month && payroll?.pay_year
        ? `${String(payroll.pay_month).padStart(2, "0")}/${payroll.pay_year}`
        : "-",
    );
    addCell(row, dateLabel(employee.hire_date));
    addCell(row, tenureLabel(employee));
    body.append(row);
  });
}

document
  .getElementById("staffStatsSearch")
  .addEventListener("input", renderStaffStats);
document
  .getElementById("staffStatsEducationFilter")
  .addEventListener("change", renderStaffStats);

function csvCell(value) {
  const text = String(value ?? "");
  const safeText = /^[\t\r ]*[=+\-@]/.test(text) ? `'${text}` : text;
  return `"${safeText.replaceAll('"', '""')}"`;
}

function downloadCsv(filename, rows) {
  const content = `\uFEFF${rows.map((row) => row.map(csvCell).join(",")).join("\r\n")}`;
  const url = URL.createObjectURL(
    new Blob([content], { type: "text/csv;charset=utf-8" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

document
  .getElementById("exportMonthlyReportBtn")
  .addEventListener("click", () => {
    const month = document.getElementById("staffReportMonth").value;
    const range = monthBounds(month);
    const rows = [
      ["Khoảng báo cáo", range.start, range.asOf],
      [],
      [
        "Nhân sự",
        "Mã nhân viên",
        "Email",
        "Phòng ban hiện tại",
        "Chức vụ hiện tại",
        "Nhóm trạng thái trong tháng",
        "Ghi chú",
      ],
    ];
    visibleMonthlyReportRows.forEach(({ employee, statuses, note }) =>
      rows.push([
        employee.full_name,
        employee.employee_code,
        employee.email,
        departmentName(employee),
        positionName(employee),
        statuses.map((status) => MONTHLY_STATUS_LABELS[status]).join("; "),
        note,
      ]),
    );
    downloadCsv(`bao-cao-nhan-su-${month}.csv`, rows);
  });

document.getElementById("exportStaffStatsBtn").addEventListener("click", () => {
  const rows = [
    [
      "Nhân sự",
      "Mã nhân viên",
      "Email",
      "Trình độ",
      "Lương cơ bản mới nhất (VND)",
      "Kỳ lương",
      "Ngày vào làm",
      "Thâm niên",
    ],
  ];
  visibleStaffStats.forEach(({ employee, salary, education }) => {
    const payroll = latestPayroll(employee.employee_id);
    rows.push([
      employee.full_name,
      employee.employee_code,
      employee.email,
      education,
      salary ?? "",
      payroll?.pay_month && payroll?.pay_year
        ? `${String(payroll.pay_month).padStart(2, "0")}/${payroll.pay_year}`
        : "",
      employee.hire_date,
      tenureLabel(employee),
    ]);
  });
  downloadCsv("thong-ke-ho-so-nhan-su.csv", rows);
});

function renderEmployeeSelects() {
  const previousPayroll =
    document.getElementById("payrollEmployee").value || selectedEmployeeId;
  const previousPermissions =
    document.getElementById("permissionEmployee").value;
  ["permissionEmployee", "payrollEmployee"].forEach((id) =>
    fillSelect(
      document.getElementById(id),
      employees,
      "employee_id",
      (employee) => `${employee.full_name} · ${employee.email}`,
      id === "payrollEmployee" ? previousPayroll : previousPermissions,
    ),
  );
  selectedEmployeeId = document.getElementById("payrollEmployee").value || "";
  fillRoleSelect(
    document.getElementById("permissionRole"),
    roleAssignments.get(
      document.getElementById("permissionEmployee").value,
    )?.[0] || "",
  );
  fillRoleSelect(document.getElementById("employeeRole"));
  fillSelect(
    document.getElementById("employeePosition"),
    positions,
    "position_id",
    (position) => position.position_title,
  );
  renderPermissions();
}

function selectedPermissionEmployee() {
  return employees.find(
    (employee) =>
      employee.employee_id ===
      document.getElementById("permissionEmployee").value,
  );
}

function renderRoleHistory(employee) {
  const body = document.getElementById("roleHistoryBody");
  body.replaceChildren();
  const entries = roleHistory.filter(
    (assignment) => assignment.employee_id === employee?.employee_id,
  );
  if (!entries.length) {
    const row = document.createElement("tr");
    addCell(
      row,
      employee
        ? "Chưa có lịch sử phân công vai trò."
        : "Chọn nhân sự để xem lịch sử.",
    ).colSpan = 4;
    body.append(row);
    return;
  }
  entries.forEach((assignment) => {
    const row = document.createElement("tr");
    addCell(row, assignment.role_name);
    addCell(row, dateLabel(assignment.valid_from));
    addCell(
      row,
      assignment.valid_to
        ? dateLabel(assignment.valid_to)
        : assignment.valid_from > vietnamDateISO()
          ? "Chưa có hiệu lực"
          : "Đang áp dụng",
    );
    addCell(row, assignment.assigned_by_name || "-");
    body.append(row);
  });
}

function renderPermissions() {
  const employee = selectedPermissionEmployee();
  renderRoleHistory(employee);
  const currentRoleIds = roleAssignments.get(employee?.employee_id) || [];
  const roleId =
    document.getElementById("permissionRole").value || currentRoleIds[0];
  const currentRolePermissions = new Set(
    currentRoleIds.flatMap((id) => rolePermissionIds.get(id) || []),
  );
  const nextRolePermissions = new Set(rolePermissionIds.get(roleId) || []);
  const saveBtn = document.getElementById("savePermissionsBtn");
  const targetRole = roles.find((role) => role.role_id === roleId);
  const alreadyOnlyHasTarget =
    currentRoleIds.length === 1 && roleId === currentRoleIds[0];
  const cannotChangeOwnRole =
    employee?.employee_id === currentActor?.employee_id &&
    !currentActor?.is_admin;
  saveBtn.disabled =
    !employee ||
    !roleId ||
    alreadyOnlyHasTarget ||
    targetRole?.assignable === false ||
    cannotChangeOwnRole;
  const currentRoleNames = currentRoleIds.map(
    (id) =>
      roles.find((role) => role.role_id === id)?.role_name ||
      "Vai trò không còn trong danh mục",
  );
  document.getElementById("permissionCurrentRole").textContent =
    `Nhân sự: ${employee?.full_name || "Chưa chọn"} · Vai trò hiện tại: ${currentRoleNames.join(", ") || "Chưa được gán"} · Vai trò mới: ${targetRole?.role_name || "Chưa chọn"}.`;
  const container = document.getElementById("permissionOptions");
  container.replaceChildren();
  const added = permissions.filter(
    (permission) =>
      !currentRolePermissions.has(permission.permission_id) &&
      nextRolePermissions.has(permission.permission_id),
  );
  const removed = permissions.filter(
    (permission) =>
      currentRolePermissions.has(permission.permission_id) &&
      !nextRolePermissions.has(permission.permission_id),
  );
  const changeSummary = document.getElementById("permissionChangeSummary");
  if (!employee || !targetRole) {
    changeSummary.textContent =
      "Chọn nhân sự và vai trò để xem các quyền được kế thừa.";
  } else if (!currentRoleIds.length) {
    changeSummary.textContent = `Sẽ cấp ${nextRolePermissions.size} quyền theo vai trò ${targetRole.role_name}.`;
  } else if (alreadyOnlyHasTarget) {
    changeSummary.textContent =
      "Vai trò đang chọn đã được gán; quyền hiện tại sẽ không thay đổi.";
  } else if (targetRole.assignable === false) {
    changeSummary.textContent = "Chỉ Admin mới được gán vai trò này.";
  } else if (cannotChangeOwnRole) {
    changeSummary.textContent =
      "Quản lý không thể tự đổi vai trò của tài khoản đang đăng nhập.";
  } else {
    const changes = [
      `Thay ${currentRoleIds.length} vai trò hiện tại bằng ${targetRole.role_name}`,
    ];
    if (added.length)
      changes.push(
        `Thêm ${added.length}: ${added.map((item) => item.description || item.permission_code).join(", ")}`,
      );
    if (removed.length)
      changes.push(
        `Gỡ ${removed.length}: ${removed.map((item) => item.description || item.permission_code).join(", ")}`,
      );
    if (!added.length && !removed.length) changes.push("bộ quyền không đổi");
    changeSummary.textContent = changes.join(" · ");
  }
  if (!permissions.length) {
    const empty = document.createElement("p");
    empty.className = "hr-permission-empty";
    empty.textContent = "Hệ thống chưa khai báo quyền cho vai trò.";
    container.append(empty);
    return;
  }
  permissions.forEach((permission) => {
    const current = currentRolePermissions.has(permission.permission_id);
    const next = nextRolePermissions.has(permission.permission_id);
    const row = document.createElement("div");
    row.className = `hr-permission-row${!current && next ? " is-added" : current && !next ? " is-removed" : ""}`;
    const text = document.createElement("span");
    const description = document.createElement("strong");
    description.textContent =
      permission.description || permission.permission_code;
    const code = document.createElement("small");
    code.textContent = permission.permission_code;
    text.append(description, code);
    const currentInput = document.createElement("input");
    currentInput.type = "checkbox";
    currentInput.checked = current;
    currentInput.disabled = true;
    currentInput.setAttribute(
      "aria-label",
      `${permission.permission_code}: quyền hiện tại`,
    );
    const nextInput = document.createElement("input");
    nextInput.type = "checkbox";
    nextInput.checked = next;
    nextInput.disabled = true;
    nextInput.setAttribute(
      "aria-label",
      `${permission.permission_code}: quyền sau khi đổi vai trò`,
    );
    const currentCell = document.createElement("span");
    currentCell.className = "hr-permission-state";
    const currentLabel = document.createElement("span");
    currentLabel.textContent = "Hiện tại";
    currentCell.append(currentInput, currentLabel);
    const nextCell = document.createElement("span");
    nextCell.className = "hr-permission-state";
    const nextLabel = document.createElement("span");
    nextLabel.textContent = "Sau khi đổi";
    nextCell.append(nextInput, nextLabel);
    row.append(text, currentCell, nextCell);
    container.append(row);
  });
}

document.getElementById("permissionEmployee").addEventListener("change", () => {
  const employee = selectedPermissionEmployee();
  fillRoleSelect(
    document.getElementById("permissionRole"),
    roleAssignments.get(employee?.employee_id)?.[0] || "",
  );
  document.getElementById("permissionFeedback").textContent = "";
  renderPermissions();
});
document.getElementById("permissionRole").addEventListener("change", () => {
  document.getElementById("permissionFeedback").textContent = "";
  renderPermissions();
});
document
  .getElementById("savePermissionsBtn")
  .addEventListener("click", async () => {
    const employee = selectedPermissionEmployee();
    const roleId = document.getElementById("permissionRole").value;
    if (!employee || !roleId) return;
    const button = document.getElementById("savePermissionsBtn");
    button.disabled = true;
    try {
      const result = await callHr({
        action: "role_assign",
        employee_id: employee.employee_id,
        role_id: roleId,
      });
      if (!result.ok) {
        feedback(
          "permissionFeedback",
          result.error === "forbidden"
            ? "Bạn không có quyền gán vai trò này."
            : "Không thể cập nhật vai trò. Kiểm tra quyền truy cập và thử lại.",
          true,
        );
        renderPermissions();
        return;
      }
      await loadLookups();
      renderAll();
      feedback(
        "permissionFeedback",
        `Đã cập nhật vai trò cho ${employee.full_name}.`,
      );
    } catch {
      feedback(
        "permissionFeedback",
        "Không kết nối được máy chủ. Vai trò chưa được xác nhận cập nhật.",
        true,
      );
    } finally {
      renderPermissions();
    }
  });

function selectedPayrollEmployee() {
  return employees.find(
    (employee) =>
      employee.employee_id === document.getElementById("payrollEmployee").value,
  );
}

function selectedPeriod() {
  const [year, month] = document
    .getElementById("payrollMonth")
    .value.split("-")
    .map(Number);
  return {
    year,
    month,
    start: `${year}-${String(month).padStart(2, "0")}-01`,
    end: new Date(year, month, 0).toISOString().slice(0, 10),
  };
}

async function loadAttendanceAndPayroll() {
  const employee = selectedPayrollEmployee();
  if (!employee) return;
  const period = selectedPeriod();
  const records = attendanceCache
    .filter(
      (record) =>
        record.employee_id === employee.employee_id &&
        record.work_date >= period.start &&
        record.work_date <= period.end,
    )
    .sort((a, b) => a.work_date.localeCompare(b.work_date));
  const payroll = payrollCache.find(
    (record) =>
      record.employee_id === employee.employee_id &&
      Number(record.pay_year) === period.year &&
      Number(record.pay_month) === period.month,
  );
  document.getElementById("payrollForm").elements.namedItem("workDays").value =
    records.filter((record) => record.status === "present").length;
  document
    .getElementById("payrollForm")
    .elements.namedItem("overtimeHours").value = records.reduce(
    (sum, record) => sum + Number(record.overtime_hours || 0),
    0,
  );
  document
    .getElementById("payrollForm")
    .elements.namedItem("baseSalary").value = payroll?.base_salary ?? 0;
  document.getElementById("payrollForm").elements.namedItem("allowance").value =
    payroll?.allowance ?? payroll?.bonus ?? 0;
  document.getElementById("payrollForm").elements.namedItem("tax").value =
    payroll?.personal_income_tax ?? 0;
  // payroll has no insurance_rate column: derive the applied rate from the stored amount.
  document
    .getElementById("payrollForm")
    .elements.namedItem("insuranceRate").value =
    payroll &&
    Number(payroll.base_salary) > 0 &&
    payroll.insurance_amount != null
      ? Math.round(
          (Number(payroll.insurance_amount) / Number(payroll.base_salary)) *
            1000,
        ) / 10
      : 10.5;
  const tbody = document.getElementById("attendanceBody");
  tbody.replaceChildren();
  records.forEach((record) => {
    const row = document.createElement("tr");
    addCell(row, dateLabel(record.work_date));
    addCell(row, capitalized(record.status) || record.status);
    addCell(row, `${record.overtime_hours || 0} giờ`);
    addCell(row, record.notes || "-");
    tbody.append(row);
  });
  renderPayrollPreview();
}

function payrollCalculation() {
  const form = document.getElementById("payrollForm");
  const employee = selectedPayrollEmployee();
  if (!employee) return null;
  const values = Object.fromEntries(new FormData(form).entries());
  const baseSalary = Number(values.baseSalary);
  const standardDays = Number(values.standardDays);
  const workDays = Number(values.workDays);
  const overtimeHours = Number(values.overtimeHours);
  const allowance = Number(values.allowance);
  const insuranceRate = Number(values.insuranceRate);
  const tax = Number(values.tax);
  if (
    !standardDays ||
    workDays > standardDays ||
    [baseSalary, workDays, overtimeHours, allowance, insuranceRate, tax].some(
      (value) => value < 0,
    )
  )
    return null;
  const basePay = (baseSalary * workDays) / standardDays;
  const overtimePay = (baseSalary / (standardDays * 8)) * 1.5 * overtimeHours;
  const insuranceAmount = (baseSalary * insuranceRate) / 100;
  const grossSalary = basePay + allowance + overtimePay;
  const totalDeductions = insuranceAmount + tax;
  return {
    baseSalary,
    standardDays,
    workDays,
    overtimeHours,
    allowance,
    insuranceRate,
    tax,
    overtimePay,
    insuranceAmount,
    grossSalary,
    totalDeductions,
    netSalary: grossSalary - totalDeductions,
  };
}

function renderPayrollPreview() {
  const result = payrollCalculation();
  const employee = selectedPayrollEmployee();
  const heading = document.querySelector("#payrollPreview h3");
  const content = document.getElementById("payrollPreviewContent");
  content.replaceChildren();
  if (!employee) {
    heading.textContent = "Chọn nhân sự";
    return;
  }
  heading.textContent = employee.full_name;
  if (!result) {
    content.textContent = "Kiểm tra ngày công và mức lương.";
    return;
  }
  [
    ["Lương cơ bản", money(result.baseSalary)],
    [
      "Lương theo ngày công",
      money((result.baseSalary * result.workDays) / result.standardDays),
    ],
    ["Phụ cấp", money(result.allowance)],
    ["Tăng ca (150%)", money(result.overtimePay)],
    ["Bảo hiểm", `- ${money(result.insuranceAmount)}`],
    ["Thuế TNCN", `- ${money(result.tax)}`],
    ["Thực nhận", money(result.netSalary)],
  ].forEach(([labelText, value]) => {
    const row = document.createElement("div");
    const term = document.createElement("dt");
    term.textContent = labelText;
    const definition = document.createElement("dd");
    definition.textContent = value;
    row.append(term, definition);
    content.append(row);
  });
}

function renderPayrollTable() {
  const period = selectedPeriod();
  document.getElementById("payrollTableTitle").textContent =
    `Bảng lương tháng ${String(period.month).padStart(2, "0")}/${period.year}`;
  const map = new Map(
    payrollCache
      .filter(
        (record) =>
          Number(record.pay_year) === period.year &&
          Number(record.pay_month) === period.month,
      )
      .map((record) => [record.employee_id, record]),
  );
  const body = document.getElementById("payrollBody");
  body.replaceChildren();
  employees.forEach((employee) => {
    const record = map.get(employee.employee_id);
    const row = document.createElement("tr");
    addCell(row, employee.full_name);
    if (record) {
      addCell(row, `${record.work_days ?? "-"}/${record.standard_days ?? "-"}`);
      addCell(
        row,
        Number(record.overtime_pay) > 0 ? money(record.overtime_pay) : "-",
      );
      addCell(row, money(record.gross_salary));
      addCell(
        row,
        money(
          record.total_deductions ||
            Number(record.gross_salary) - Number(record.net_salary),
        ),
      );
      addCell(row, money(record.net_salary));
    } else {
      addCell(row, "-");
      addCell(row, "-");
      addCell(row, "Chưa tính lương");
      addCell(row, "-");
      addCell(row, "-");
    }
    body.append(row);
  });
}

async function savePayroll(event) {
  event.preventDefault();
  const employee = selectedPayrollEmployee();
  const period = selectedPeriod();
  const result = payrollCalculation();
  if (!employee || !result) {
    feedback("payrollFeedback", "Kiểm tra ngày công và khoản lương.", true);
    return;
  }
  const response = await callHr({
    action: "payroll_save",
    employee_id: employee.employee_id,
    pay_year: period.year,
    pay_month: period.month,
    base_salary: result.baseSalary,
    allowance: result.allowance,
    overtime_pay: result.overtimePay,
    work_days: result.workDays,
    standard_days: result.standardDays,
    insurance_amount: result.insuranceAmount,
    personal_income_tax: result.tax,
    total_deductions: result.totalDeductions,
    gross_salary: result.grossSalary,
    net_salary: result.netSalary,
  });
  if (!response.ok) {
    feedback(
      "payrollFeedback",
      response.error === "invalid_amounts"
        ? "Số tiền không hợp lệ (thực nhận phải ≤ tổng thu nhập)."
        : "Không lưu được lương. Kiểm tra số liệu và quyền.",
      true,
    );
    return;
  }
  feedback("payrollFeedback", `Đã lưu lương cho ${employee.full_name}.`);
  await loadLookups();
  renderAll();
}

document
  .getElementById("payrollEmployee")
  .addEventListener("change", () =>
    loadAttendanceAndPayroll().catch(() =>
      feedback("payrollFeedback", "Không tải được chấm công/lương.", true),
    ),
  );
document.getElementById("payrollMonth").value =
  `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, "0")}`;
document
  .getElementById("payrollMonth")
  .addEventListener("change", () =>
    Promise.resolve(loadAttendanceAndPayroll()).catch(() =>
      showError("Không tải được kỳ lương."),
    ),
  );
document
  .getElementById("payrollForm")
  .addEventListener("input", renderPayrollPreview);
document
  .getElementById("payrollForm")
  .addEventListener("submit", (event) =>
    savePayroll(event).catch(() =>
      feedback("payrollFeedback", "Không thể lưu lương.", true),
    ),
  );
document.getElementById("attendanceDate").value = new Date()
  .toISOString()
  .slice(0, 10);
document
  .getElementById("attendanceForm")
  .addEventListener("submit", async (event) => {
    event.preventDefault();
    const employee = selectedPayrollEmployee();
    if (!employee) return;
    const values = Object.fromEntries(
      new FormData(event.currentTarget).entries(),
    );
    const result = await callHr({
      action: "attendance_save",
      employee_id: employee.employee_id,
      work_date: values.workDate,
      status: values.status,
      overtime_hours: Number(values.overtimeHours),
      notes: String(values.notes || "").trim() || null,
    });
    if (!result.ok) {
      feedback(
        "attendanceFeedback",
        result.error === "forbidden"
          ? "Bạn không có quyền chấm công cho nhân sự này."
          : "Không lưu được ngày công.",
        true,
      );
      return;
    }
    feedback("attendanceFeedback", "Đã lưu ngày công.");
    await loadLookups();
    await loadAttendanceAndPayroll();
    renderPayrollTable();
  });

async function renderAll() {
  renderEmployeePositionFilter();
  renderEmployees();
  renderRequests();
  renderMonthlyReport();
  renderStaffStats();
  renderEmployeeSelects();
  renderPermissions();
  if (selectedEmployeeId) {
    await loadAttendanceAndPayroll();
    renderPayrollTable();
  }
}

async function initHrPortal() {
  if (!portal.requireSession("manager", "login.html")) return;

  try {
    await loadLookups();
  } catch (error) {
    if (error.message === "forbidden" || error.message === "unauthorized") {
      if (typeof portal !== "undefined" && portal.clearSession) {
        portal.clearSession("manager");
        portal.clearSession("staff");
      } else {
        localStorage.removeItem("jewels-manager-token");
        localStorage.removeItem("jewels-staff-token");
        localStorage.removeItem("jewels-admin-token");
      }
      window.location.replace("../manager/login.html");
      return;
    }
    if (error.message === "migration_required") {
      showError(
        "Cần áp dụng migration HR và lịch sử trạng thái trong database/migrations trước khi dùng báo cáo.",
      );
      return;
    }
    console.error(error);
    showError("Không tải được dữ liệu. Vui lòng thử lại sau.");
    return;
  }
  fillSelect(
    document.getElementById("employeePosition"),
    positions,
    "position_id",
    (position) => position.position_title,
  );
  fillRoleSelect(document.getElementById("employeeRole"));
  document.getElementById("payrollForm").elements.namedItem("workDays").value =
    0;
  await renderAll();
  const initial = window.location.hash.slice(1);
  setView(
    document.querySelector(`[data-hr-panel="${initial}"]`)
      ? initial
      : "employees",
  );
}

const profileToggle = document.getElementById("adminProfileToggle");
const profileMenu = document.getElementById("adminProfileMenu");
const profileCard = document.querySelector(".admin-profile-card");

function setProfileMenuOpen(open) {
  profileToggle.setAttribute("aria-expanded", String(open));
  profileMenu.classList.toggle("show-menu", open);
}

profileToggle.addEventListener("click", () => {
  const isOpen = profileToggle.getAttribute("aria-expanded") === "true";
  setProfileMenuOpen(!isOpen);
});

document.addEventListener("click", (event) => {
  if (!profileCard.contains(event.target)) setProfileMenuOpen(false);
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    setProfileMenuOpen(false);
    setLogoutModalOpen(false);
  }
});

const logoutModal = document.getElementById("logoutModal");
const confirmLogoutBtn = document.getElementById("confirmLogoutBtn");
const cancelLogoutBtn = document.getElementById("cancelLogoutBtn");

function setLogoutModalOpen(open) {
  logoutModal.hidden = !open;
}

document.getElementById("adminLogoutBtn").addEventListener("click", () => {
  setProfileMenuOpen(false);
  setLogoutModalOpen(true);
  cancelLogoutBtn.focus();
});

cancelLogoutBtn.addEventListener("click", () => {
  setLogoutModalOpen(false);
});

if (confirmLogoutBtn) {
  confirmLogoutBtn.addEventListener("click", () => {
    if (typeof portal !== "undefined" && portal.clearSession) {
      portal.clearSession("manager");
      portal.clearSession("staff");
    } else {
      localStorage.removeItem("jewels-manager-token");
      localStorage.removeItem("jewels-staff-token");
    }
    window.location.href = "../manager/login.html";
  });
}

logoutModal.addEventListener("click", (event) => {
  if (event.target === logoutModal) setLogoutModalOpen(false);
});

initHrPortal().catch((error) => {
  console.error(error);
  showError("Không thể kết nối máy chủ.");
});
setInterval(async () => {
  if (currentActor) {
    await callHr({ action: "ping" });
  }
}, 5000);
