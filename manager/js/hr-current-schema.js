// Manager portal data layer: all access goes through the hr-portal edge
// function (see shared/js/portal-api.js); the browser never touches tables.
const portal = window.jewelsPortal;
const callHr = (body) => portal.callPortal("manager", "hr-portal", body, { loginUrl: "login.html" });
const STATUS_LABELS = { active: "Đang làm", on_leave: "Đang nghỉ phép", resigned: "Đã nghỉ việc" };
const STATUS_TO_DB = { "Đang làm": "active", "Đang nghỉ phép": "on_leave", "Đã nghỉ việc": "resigned" };
const LEAVE_TYPES = { annual: "Nghỉ phép", sick: "Nghỉ ốm đau", maternity: "Nghỉ thai sản", resignation: "Xin nghỉ việc" };
const LEAVE_STATUSES = { pending: "Chờ duyệt", approved: "Đã duyệt", rejected: "Từ chối" };
let currentEmployee;
let employees = [];
let contacts = new Map();
let positions = [];
let departments = [];
let roles = [];
let permissions = [];
let roleAssignments = new Map();
let rolePermissionIds = new Map();
let payrollCache = [];
let attendanceCache = [];
let requests = [];
let selectedEmployeeId = "";

function money(value) {
  return new Intl.NumberFormat("vi-VN", { style: "currency", currency: "VND", maximumFractionDigits: 0 }).format(Number(value || 0));
}

function dateLabel(value) {
  if (!value) return "-";
  const [year, month, day] = String(value).slice(0, 10).split("-").map(Number);
  return new Intl.DateTimeFormat("vi-VN").format(new Date(year, month - 1, day));
}

function addCell(row, value, tag = "td") {
  const cell = document.createElement(tag);
  cell.textContent = String(value ?? "");
  row.append(cell);
  return cell;
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
  if (["on_leave", "leave", "đang nghỉ phép", "nghỉ phép"].includes(value)) return "on_leave";
  if (["resigned", "inactive", "đã nghỉ việc", "nghỉ việc"].includes(value)) return "resigned";
  return "active";
}

function statusBadge(status) {
  const normalized = normalizedStatus(status);
  const badge = document.createElement("span");
  badge.className = `hr-status hr-status-${normalized === "active" ? "active" : normalized === "on_leave" ? "leave" : "resigned"}`;
  badge.textContent = STATUS_LABELS[normalized];
  return badge;
}

function capitalized(value) {
  const text = String(value || "");
  return text ? text[0].toUpperCase() + text.slice(1) : "";
}

function employeePosition(employee) {
  return positions.find((position) => position.position_id === employee.position_id);
}

function positionName(employee) {
  return employeePosition(employee)?.position_title || "Chưa gán chức vụ";
}

function departmentName(employee) {
  const position = employeePosition(employee);
  return departments.find((department) => department.department_id === position?.department_id)?.department_name || "-";
}

function setView(viewName) {
  document.querySelectorAll("[data-hr-panel]").forEach((panel) => {
    const active = panel.dataset.hrPanel === viewName;
    panel.hidden = !active;
    panel.classList.toggle("active", active);
  });
  document.querySelectorAll("[data-hr-view]").forEach((link) => link.classList.toggle("is-active", link.dataset.hrView === viewName));
  const link = document.querySelector(`.admin-nav [data-hr-view="${viewName}"]`);
  document.getElementById("adminPageTitle").textContent = link?.textContent.trim() || "Hồ sơ nhân sự";
  history.replaceState(null, "", `#${viewName}`);
}

document.querySelectorAll("[data-hr-view]").forEach((link) => link.addEventListener("click", (event) => {
  event.preventDefault();
  setView(link.dataset.hrView);
}));

async function loadLookups() {
  const result = await callHr({ action: "boot" });
  if (!result.ok) throw new Error(result.error);
  const data = result.data;
  currentEmployee = data.actor || null;
  employees = (data.employees || []).map((employee) => ({
    ...employee,
    position_id: employee.position_id ?? employee.current_position_id
  }));
  contacts = new Map((data.contacts || []).map((contact) => [contact.employee_id, contact]));
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
  requests = data.leave_requests || [];
  payrollCache = data.payroll || [];
  attendanceCache = data.attendance || [];
}

function latestPayroll(employeeId) {
  return payrollCache.find((record) => record.employee_id === employeeId);
}

function fillSelect(select, options, valueKey, labelFor, selectedValue = "") {
  select.replaceChildren();
  options.forEach((item) => {
    const option = document.createElement("option");
    option.value = item[valueKey];
    option.textContent = labelFor(item);
    select.append(option);
  });
  if (options.some((item) => String(item[valueKey]) === String(selectedValue))) select.value = selectedValue;
}

function renderEmployees() {
  const body = document.getElementById("employeesBody");
  const term = document.getElementById("employeeSearch").value.trim().toLowerCase();
  body.replaceChildren();
  const matches = employees.filter((employee) => [employee.full_name, employee.employee_code, employee.email, positionName(employee), departmentName(employee)].join(" ").toLowerCase().includes(term));
  if (!matches.length) {
    const row = document.createElement("tr");
    addCell(row, employees.length ? "Không có nhân sự phù hợp." : "Chưa có nhân sự trong phạm vi của bạn.").colSpan = 6;
    body.append(row);
  }
  matches.forEach((employee) => {
    const row = document.createElement("tr");
    const identity = document.createElement("td");
    const name = document.createElement("strong"); name.textContent = employee.full_name;
    const email = document.createElement("small"); email.textContent = employee.email;
    identity.append(name, email); row.append(identity);
    addCell(row, positionName(employee));
    addCell(row, departmentName(employee));
    addCell(row, employee.education || "-");
    const statusCell = document.createElement("td"); statusCell.append(statusBadge(employee.employment_status)); row.append(statusCell);
    const actions = document.createElement("td"); actions.className = "hr-row-actions";
    const edit = document.createElement("button"); edit.type = "button"; edit.className = "mini-btn"; edit.dataset.employeeAction = "edit"; edit.dataset.employeeId = employee.employee_id; edit.textContent = "Sửa";
    const remove = document.createElement("button"); remove.type = "button"; remove.className = "mini-btn danger"; remove.dataset.employeeAction = "delete"; remove.dataset.employeeId = employee.employee_id; remove.textContent = "Xóa";
    actions.append(edit, remove); row.append(actions); body.append(row);
  });
}

function fillRoleSelect(select, selectedValue = "") {
  fillSelect(select, roles, "role_id", (role) => role.role_name, selectedValue);
}

function showEmployeeForm(employee = null) {
  const form = document.getElementById("employeeForm");
  form.reset();
  form.elements.namedItem("id").value = employee?.employee_id || "";
  document.getElementById("employeeFormTitle").textContent = employee ? "Cập nhật hồ sơ nhân sự" : "Thêm nhân sự mới";
  fillSelect(document.getElementById("employeePosition"), positions, "position_id", (position) => position.position_title, employee?.position_id || "");
  fillRoleSelect(document.getElementById("employeeRole"), roleAssignments.get(employee?.employee_id)?.[0] || "");
  if (employee) {
    const contact = contacts.get(employee.employee_id);
    const values = {
      name: employee.full_name,
      email: employee.email,
      phone: contact?.phone_number || "",
      education: employee.education || "",
      hireDate: employee.hire_date,
      employmentStatus: STATUS_LABELS[normalizedStatus(employee.employment_status)]
    };
    Object.entries(values).forEach(([key, value]) => { if (form.elements.namedItem(key)) form.elements.namedItem(key).value = value; });
  } else {
    form.elements.namedItem("hireDate").value = new Date().toISOString().slice(0, 10);
  }
  updateDepartmentForPosition();
  document.getElementById("employeeFormPanel").hidden = false;
  document.getElementById("employeeFormPanel").scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function updateDepartmentForPosition() {
  const position = positions.find((item) => item.position_id === document.getElementById("employeePosition").value);
  document.getElementById("employeeDepartment").value = departments.find((item) => item.department_id === position?.department_id)?.department_name || "";
}

document.getElementById("employeePosition").addEventListener("change", updateDepartmentForPosition);
document.getElementById("addEmployeeBtn").addEventListener("click", () => showEmployeeForm());
document.getElementById("cancelEmployeeBtn").addEventListener("click", () => { document.getElementById("employeeFormPanel").hidden = true; document.getElementById("employeeForm").reset(); });
document.getElementById("employeeSearch").addEventListener("input", renderEmployees);
document.getElementById("employeesBody").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-employee-action]");
  if (!button) return;
  const employee = employees.find((item) => item.employee_id === button.dataset.employeeId);
  if (!employee) return;
  if (button.dataset.employeeAction === "edit") { showEmployeeForm(employee); return; }
  if (!window.confirm(`Xóa hồ sơ ${employee.full_name}? Các bản ghi liên quan (tài khoản, đơn nghỉ, lương, chấm công) cũng sẽ bị xóa.`)) return;
  const result = await callHr({ action: "employee_delete", id: employee.employee_id });
  if (!result.ok || (result.error && result.error === "forbidden")) { window.alert("Không thể xóa hồ sơ. Kiểm tra bản ghi liên quan và quyền của bạn."); return; }
  await loadLookups(); renderAll();
});

document.getElementById("employeeForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const values = Object.fromEntries(new FormData(form).entries());
  const result = await callHr({
    action: "employee_save",
    id: values.id || undefined,
    full_name: String(values.name).trim(),
    email: String(values.email).trim().toLowerCase(),
    position_id: values.positionId,
    hire_date: values.hireDate,
    employment_status: STATUS_TO_DB[values.employmentStatus] || "active",
    phone_number: String(values.phone || "").trim(),
    role_id: values.roleId || undefined
  });
  if (!result.ok) { feedback("employeeFeedback", "Không lưu được hồ sơ nhân sự.", true); return; }
  document.getElementById("employeeFormPanel").hidden = true;
  feedback("employeeFeedback", "");
  await loadLookups(); renderAll();
});

function renderRequests() {
  const filter = document.getElementById("requestFilter").value;
  const body = document.getElementById("requestsBody"); body.replaceChildren();
  const filtered = requests.filter((request) => filter === "all" || (filter === "pending" ? request.status === "pending" : request.status !== "pending"));
  if (!filtered.length) { const row = document.createElement("tr"); addCell(row, "Không có đơn trong danh sách.").colSpan = 6; body.append(row); }
  filtered.forEach((request) => {
    const employee = employees.find((item) => item.employee_id === request.employee_id);
    const row = document.createElement("tr");
    const identity = document.createElement("td");
    const name = document.createElement("strong"); name.textContent = employee?.full_name || "Nhân sự đã xóa";
    const email = document.createElement("small"); email.textContent = employee?.email || "";
    identity.append(name, email); row.append(identity);
    addCell(row, LEAVE_TYPES[request.leave_type] || "Chưa phân loại");
    addCell(row, request.leave_type === "resignation" ? `Ngày dự kiến cuối: ${dateLabel(request.start_date)}` : `${dateLabel(request.start_date)} - ${dateLabel(request.end_date)}`);
    addCell(row, request.reason);
    addCell(row, LEAVE_STATUSES[request.status] || request.status);
    const actions = document.createElement("td"); actions.className = "hr-row-actions";
    if (request.status === "pending") ["approved", "rejected"].forEach((status) => {
      const button = document.createElement("button"); button.type = "button"; button.className = status === "approved" ? "mini-btn" : "mini-btn danger";
      button.dataset.reviewStatus = status; button.dataset.requestId = request.leave_request_id; button.textContent = status === "approved" ? "Duyệt" : "Từ chối"; actions.append(button);
    });
    row.append(actions); body.append(row);
  });
}

document.getElementById("requestFilter").value = "pending";
document.getElementById("requestFilter").addEventListener("change", renderRequests);
document.getElementById("requestsBody").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-review-status]"); if (!button) return;
  const result = await callHr({ action: "leave_review", leave_request_id: button.dataset.requestId, status: button.dataset.reviewStatus });
  if (!result.ok) {
    const reasons = {
      forbidden: "Bạn không có quyền duyệt đơn này (không duyệt đơn của chính mình).",
      already_decided: "Đơn này đã được xử lý trước đó.",
      invalid_reference: "Không tìm thấy đơn nghỉ."
    };
    window.alert(reasons[result.error] || "Không cập nhật được đơn. Kiểm tra trạng thái hợp lệ.");
    return;
  }
  await loadLookups(); renderAll();
});

function monthBounds(value) {
  const [year, month] = value.split("-").map(Number);
  return { year, month, start: `${year}-${String(month).padStart(2, "0")}-01`, end: new Date(year, month, 0).toISOString().slice(0, 10) };
}

function approvedLeaveForMonth(employee, range) {
  return requests.find((request) => request.employee_id === employee.employee_id && request.status === "approved" && request.leave_type !== "resignation" && request.start_date <= range.end && request.end_date >= range.start);
}

function monthlyStatus(employee, range) {
  if (employee.hire_date > range.end) return null;
  const resignation = requests.find((request) => request.employee_id === employee.employee_id && request.leave_type === "resignation" && request.status === "approved" && request.start_date <= range.end);
  if (resignation || normalizedStatus(employee.employment_status) === "resigned") return { status: "resigned", note: resignation ? `Nghỉ việc từ ${dateLabel(resignation.start_date)}` : "Đã nghỉ việc" };
  const leave = approvedLeaveForMonth(employee, range);
  if (leave || normalizedStatus(employee.employment_status) === "on_leave") return { status: "on_leave", note: leave ? `${LEAVE_TYPES[leave.leave_type]}: ${dateLabel(leave.start_date)}` : "Đang nghỉ phép" };
  return { status: "active", note: "" };
}

function renderMonthlyReport() {
  const range = monthBounds(document.getElementById("staffReportMonth").value);
  const body = document.getElementById("monthlyStaffBody"); body.replaceChildren();
  const counts = { active: 0, on_leave: 0, resigned: 0 };
  employees.forEach((employee) => {
    const state = monthlyStatus(employee, range); if (!state) return; counts[state.status] += 1;
    const row = document.createElement("tr"); addCell(row, employee.full_name); addCell(row, departmentName(employee)); addCell(row, positionName(employee));
    const cell = document.createElement("td"); cell.append(statusBadge(state.status)); row.append(cell); addCell(row, state.note || "-"); body.append(row);
  });
  const summary = document.getElementById("monthlyStaffSummary"); summary.replaceChildren();
  [["Đang làm", counts.active], ["Đang nghỉ phép", counts.on_leave], ["Đã nghỉ việc", counts.resigned], ["Tổng nhân sự", employees.filter((employee) => employee.hire_date <= range.end).length]].forEach(([label, value]) => {
    const card = document.createElement("article"); card.className = "hr-summary-card"; const caption = document.createElement("span"); caption.textContent = label; const total = document.createElement("strong"); total.textContent = value; card.append(caption, total); summary.append(card);
  });
}

document.getElementById("staffReportMonth").value = `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, "0")}`;
document.getElementById("staffReportMonth").addEventListener("change", renderMonthlyReport);

function tenureLabel(employee) {
  const start = new Date(`${employee.hire_date}T00:00:00`); const now = new Date();
  const months = Math.max(0, (now.getFullYear() - start.getFullYear()) * 12 + now.getMonth() - start.getMonth());
  return `${Math.floor(months / 12)} năm ${months % 12} tháng`;
}

function renderStaffStats() {
  const body = document.getElementById("staffStatsBody"); body.replaceChildren();
  employees.forEach((employee) => {
    const row = document.createElement("tr"); const salary = latestPayroll(employee.employee_id);
    addCell(row, employee.full_name); addCell(row, employee.education || "-"); addCell(row, salary ? money(salary.base_salary) : "Chưa có lương"); addCell(row, dateLabel(employee.hire_date)); addCell(row, tenureLabel(employee)); body.append(row);
  });
  const salaries = employees.map((employee) => latestPayroll(employee.employee_id)?.base_salary).filter(Number.isFinite);
  const avg = salaries.length ? salaries.reduce((sum, value) => sum + Number(value), 0) / salaries.length : 0;
  const counts = employees.reduce((result, employee) => { const key = employee.education || "Chưa cập nhật"; result[key] = (result[key] || 0) + 1; return result; }, {});
  const common = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] || "-";
  const summary = document.getElementById("staffStatsSummary"); summary.replaceChildren();
  [["Tổng nhân sự", employees.length], ["Lương cơ bản gần nhất", money(avg)], ["Trình độ phổ biến", common]].forEach(([label, value]) => {
    const card = document.createElement("article"); card.className = "hr-summary-card"; const caption = document.createElement("span"); caption.textContent = label; const strong = document.createElement("strong"); strong.textContent = value; card.append(caption, strong); summary.append(card);
  });
}

function renderEmployeeSelects() {
  const previousPayroll = document.getElementById("payrollEmployee").value || selectedEmployeeId;
  const previousPermissions = document.getElementById("permissionEmployee").value;
  ["permissionEmployee", "payrollEmployee"].forEach((id) => fillSelect(document.getElementById(id), employees, "employee_id", (employee) => `${employee.full_name} · ${employee.email}`, id === "payrollEmployee" ? previousPayroll : previousPermissions));
  selectedEmployeeId = document.getElementById("payrollEmployee").value || "";
  fillRoleSelect(document.getElementById("permissionRole"), roleAssignments.get(document.getElementById("permissionEmployee").value)?.[0] || "");
  fillRoleSelect(document.getElementById("employeeRole"));
  fillSelect(document.getElementById("employeePosition"), positions, "position_id", (position) => position.position_title);
  renderPermissions();
}

function selectedPermissionEmployee() {
  return employees.find((employee) => employee.employee_id === document.getElementById("permissionEmployee").value);
}

function renderPermissions() {
  const employee = selectedPermissionEmployee();
  const roleId = document.getElementById("permissionRole").value || roleAssignments.get(employee?.employee_id)?.[0];
  const selected = new Set(rolePermissionIds.get(roleId) || []);
  // role_permissions are global config owned by the admin portal in the
  // server contract; managers see them read-only here.
  const readOnly = !currentEmployee?.is_admin;
  const saveBtn = document.getElementById("savePermissionsBtn");
  saveBtn.disabled = readOnly;
  document.getElementById("permissionFeedback").textContent =
    readOnly ? "Chỉ Admin mới được chỉnh sửa quyền của vai trò (giám sát chỉ đọc)." : "";
  const container = document.getElementById("permissionOptions"); container.replaceChildren();
  permissions.forEach((permission) => {
    const label = document.createElement("label"); const checkbox = document.createElement("input");
    checkbox.type = "checkbox"; checkbox.value = permission.permission_id; checkbox.checked = selected.has(permission.permission_id);
    if (readOnly) checkbox.disabled = true;
    const text = document.createElement("span"); text.textContent = permission.description || permission.permission_code; label.append(checkbox, text); container.append(label);
  });
}

document.getElementById("permissionEmployee").addEventListener("change", () => {
  const employee = selectedPermissionEmployee(); fillRoleSelect(document.getElementById("permissionRole"), roleAssignments.get(employee?.employee_id)?.[0] || ""); renderPermissions();
});
document.getElementById("permissionRole").addEventListener("change", renderPermissions);
document.getElementById("savePermissionsBtn").addEventListener("click", async () => {
  const employee = selectedPermissionEmployee(); const roleId = document.getElementById("permissionRole").value;
  if (!employee || !roleId) return;
  const permissionIds = [...document.querySelectorAll("#permissionOptions input:checked")].map((input) => input.value);
  const result = await callHr({ action: "permissions_save", employee_id: employee.employee_id, role_id: roleId, permission_ids: permissionIds });
  if (!result.ok) { feedback("permissionFeedback", result.error === "forbidden" ? "Bạn không có quyền phân vai trò này." : "Không thể cập nhật quyền vai trò.", true); return; }
  feedback("permissionFeedback", `Đã lưu quyền của ${employee.full_name}.`);
  await loadLookups(); renderAll();
});

function selectedPayrollEmployee() {
  return employees.find((employee) => employee.employee_id === document.getElementById("payrollEmployee").value);
}

function selectedPeriod() {
  const [year, month] = document.getElementById("payrollMonth").value.split("-").map(Number);
  return { year, month, start: `${year}-${String(month).padStart(2, "0")}-01`, end: new Date(year, month, 0).toISOString().slice(0, 10) };
}

async function loadAttendanceAndPayroll() {
  const employee = selectedPayrollEmployee(); if (!employee) return;
  const period = selectedPeriod();
  const records = attendanceCache
    .filter((record) => record.employee_id === employee.employee_id && record.work_date >= period.start && record.work_date <= period.end)
    .sort((a, b) => a.work_date.localeCompare(b.work_date));
  const payroll = payrollCache.find((record) => record.employee_id === employee.employee_id && Number(record.pay_year) === period.year && Number(record.pay_month) === period.month);
  document.getElementById("payrollForm").elements.namedItem("workDays").value = records.filter((record) => record.status === "present").length;
  document.getElementById("payrollForm").elements.namedItem("overtimeHours").value = records.reduce((sum, record) => sum + Number(record.overtime_hours || 0), 0);
  document.getElementById("payrollForm").elements.namedItem("baseSalary").value = payroll?.base_salary ?? 0;
  document.getElementById("payrollForm").elements.namedItem("allowance").value = payroll?.allowance ?? payroll?.bonus ?? 0;
  document.getElementById("payrollForm").elements.namedItem("tax").value = payroll?.personal_income_tax ?? 0;
  document.getElementById("payrollForm").elements.namedItem("insuranceRate").value = payroll?.insurance_rate ?? 10.5;
  const tbody = document.getElementById("attendanceBody"); tbody.replaceChildren();
  records.forEach((record) => { const row = document.createElement("tr"); addCell(row, dateLabel(record.work_date)); addCell(row, capitalized(record.status) || record.status); addCell(row, `${record.overtime_hours || 0} giờ`); addCell(row, record.notes || "-"); tbody.append(row); });
  renderPayrollPreview();
}

function payrollCalculation() {
  const form = document.getElementById("payrollForm"); const employee = selectedPayrollEmployee(); if (!employee) return null;
  const values = Object.fromEntries(new FormData(form).entries());
  const baseSalary = Number(values.baseSalary); const standardDays = Number(values.standardDays); const workDays = Number(values.workDays);
  const overtimeHours = Number(values.overtimeHours); const allowance = Number(values.allowance); const insuranceRate = Number(values.insuranceRate); const tax = Number(values.tax);
  if (!standardDays || workDays > standardDays || [baseSalary, workDays, overtimeHours, allowance, insuranceRate, tax].some((value) => value < 0)) return null;
  const basePay = baseSalary * workDays / standardDays;
  const overtimePay = baseSalary / (standardDays * 8) * 1.5 * overtimeHours;
  const insuranceAmount = baseSalary * insuranceRate / 100;
  const grossSalary = basePay + allowance + overtimePay;
  const totalDeductions = insuranceAmount + tax;
  return { baseSalary, standardDays, workDays, overtimeHours, allowance, insuranceRate, tax, overtimePay, insuranceAmount, grossSalary, totalDeductions, netSalary: grossSalary - totalDeductions };
}

function renderPayrollPreview() {
  const result = payrollCalculation(); const employee = selectedPayrollEmployee(); const heading = document.querySelector("#payrollPreview h3"); const content = document.getElementById("payrollPreviewContent"); content.replaceChildren();
  if (!employee) { heading.textContent = "Chọn nhân sự"; return; }
  heading.textContent = employee.full_name;
  if (!result) { content.textContent = "Kiểm tra ngày công và mức lương."; return; }
  [["Lương cơ bản", money(result.baseSalary)], ["Lương theo ngày công", money(result.baseSalary * result.workDays / result.standardDays)], ["Phụ cấp", money(result.allowance)], ["Tăng ca (150%)", money(result.overtimePay)], ["Bảo hiểm", `- ${money(result.insuranceAmount)}`], ["Thuế TNCN", `- ${money(result.tax)}`], ["Thực nhận", money(result.netSalary)]].forEach(([labelText, value]) => {
    const row = document.createElement("div"); const term = document.createElement("dt"); term.textContent = labelText; const definition = document.createElement("dd"); definition.textContent = value; row.append(term, definition); content.append(row);
  });
}

function renderPayrollTable() {
  const period = selectedPeriod(); document.getElementById("payrollTableTitle").textContent = `Bảng lương tháng ${String(period.month).padStart(2, "0")}/${period.year}`;
  const map = new Map(payrollCache.filter((record) => Number(record.pay_year) === period.year && Number(record.pay_month) === period.month).map((record) => [record.employee_id, record]));
  const body = document.getElementById("payrollBody"); body.replaceChildren();
  employees.forEach((employee) => { const record = map.get(employee.employee_id); const row = document.createElement("tr"); addCell(row, employee.full_name); if (record) { addCell(row, `${record.work_days ?? "-"}/${record.standard_days ?? "-"}`); addCell(row, Number(record.overtime_pay) > 0 ? money(record.overtime_pay) : "-"); addCell(row, money(record.gross_salary)); addCell(row, money(record.total_deductions || Number(record.gross_salary) - Number(record.net_salary))); addCell(row, money(record.net_salary)); } else { addCell(row, "-"); addCell(row, "-"); addCell(row, "Chưa tính lương"); addCell(row, "-"); addCell(row, "-"); } body.append(row); });
}

async function savePayroll(event) {
  event.preventDefault(); const employee = selectedPayrollEmployee(); const period = selectedPeriod(); const result = payrollCalculation();
  if (!employee || !result) { feedback("payrollFeedback", "Kiểm tra ngày công và khoản lương.", true); return; }
  const response = await callHr({
    action: "payroll_save", employee_id: employee.employee_id, pay_year: period.year, pay_month: period.month,
    base_salary: result.baseSalary, allowance: result.allowance, overtime_pay: result.overtimePay,
    work_days: result.workDays, standard_days: result.standardDays, insurance_amount: result.insuranceAmount,
    personal_income_tax: result.tax, total_deductions: result.totalDeductions,
    gross_salary: result.grossSalary, net_salary: result.netSalary
  });
  if (!response.ok) { feedback("payrollFeedback", response.error === "invalid_amounts" ? "Số tiền không hợp lệ (thực nhận phải ≤ tổng thu nhập)." : "Không lưu được lương. Kiểm tra số liệu và quyền.", true); return; }
  feedback("payrollFeedback", `Đã lưu lương cho ${employee.full_name}.`);
  await loadLookups(); renderAll();
}

document.getElementById("payrollEmployee").addEventListener("change", () => loadAttendanceAndPayroll().catch(() => feedback("payrollFeedback", "Không tải được chấm công/lương.", true)));
document.getElementById("payrollMonth").value = `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, "0")}`;
document.getElementById("payrollMonth").addEventListener("change", () => Promise.resolve(loadAttendanceAndPayroll()).catch(() => showError("Không tải được kỳ lương.")));
document.getElementById("payrollForm").addEventListener("input", renderPayrollPreview);
document.getElementById("payrollForm").addEventListener("submit", (event) => savePayroll(event).catch(() => feedback("payrollFeedback", "Không thể lưu lương.", true)));
document.getElementById("attendanceDate").value = new Date().toISOString().slice(0, 10);
document.getElementById("attendanceForm").addEventListener("submit", async (event) => {
  event.preventDefault(); const employee = selectedPayrollEmployee(); if (!employee) return;
  const values = Object.fromEntries(new FormData(event.currentTarget).entries());
  const result = await callHr({
    action: "attendance_save", employee_id: employee.employee_id, work_date: values.workDate,
    status: values.status, overtime_hours: Number(values.overtimeHours), notes: String(values.notes || "").trim() || null
  });
  if (!result.ok) { feedback("attendanceFeedback", result.error === "forbidden" ? "Bạn không có quyền chấm công cho nhân sự này." : "Không lưu được ngày công.", true); return; }
  feedback("attendanceFeedback", "Đã lưu ngày công.");
  await loadLookups(); await loadAttendanceAndPayroll(); renderPayrollTable();
});

async function renderAll() {
  renderEmployees(); renderRequests(); renderMonthlyReport(); renderStaffStats(); renderEmployeeSelects(); renderPermissions();
  if (selectedEmployeeId) { await loadAttendanceAndPayroll(); renderPayrollTable(); }
}

async function initHrPortal() {
  if (!portal.requireSession("manager", "login.html")) return;
  // hr-portal verifies manager role and department scope on every request.
  try {
    await loadLookups();
  } catch (error) {
    if (error.message === "forbidden" || error.message === "unauthorized") {
      portal.clearSession("manager");
      window.location.replace("login.html");
      return;
    }
    console.error(error);
    showError("Không tải được dữ liệu. Vui lòng thử lại sau.");
    return;
  }
  fillSelect(document.getElementById("employeePosition"), positions, "position_id", (position) => position.position_title);
  fillRoleSelect(document.getElementById("employeeRole"));
  document.getElementById("payrollForm").elements.namedItem("workDays").value = 0;
  await renderAll();
  const initial = window.location.hash.slice(1);
  setView(document.querySelector(`[data-hr-panel="${initial}"]`) ? initial : "employees");
}

document.getElementById("adminLogoutBtn").addEventListener("click", () => { portal.clearSession("manager"); window.location.href = "login.html"; });
initHrPortal().catch((error) => { console.error(error); showError("Không thể kết nối máy chủ."); });
