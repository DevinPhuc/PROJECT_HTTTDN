// Staff portal core: session boot, permissions, view switching and shared
// helpers. Each menu has its own file (staff-profile.js, staff-leave.js,
// staff-salary-month.js, staff-salary-year.js) that registers a load
// function into VIEW_MODULES.
const portal = window.jewelsPortal;
const callStaff = (body) => portal.callPortal("staff", "staff-portal", body, { loginUrl: "staff-login.html" });
const VIEW_PERMISSION_ALIASES = {
  // codes must match public.permissions in the DB (dot-notation, e.g. employee.view)
  profile: ["employee.view", "employee.edit"],
  leave: ["leave.create", "leave.view"],
  "salary-month": ["payroll.view"],
  "salary-year": ["payroll.print", "payroll.view"]
};
const VIEW_MODULES = {};
let employee;
let contact;
let position;
let department;
let permissionCodes = [];

function money(value) {
  return new Intl.NumberFormat("vi-VN", { style: "currency", currency: "VND", maximumFractionDigits: 0 }).format(Number(value || 0));
}

function dateLabel(value) {
  if (!value) return "-";
  const [year, month, day] = String(value).slice(0, 10).split("-").map(Number);
  return new Intl.DateTimeFormat("vi-VN").format(new Date(year, month - 1, day));
}

function monthLabel(year, month) {
  return new Intl.DateTimeFormat("vi-VN", { month: "long", year: "numeric" }).format(new Date(year, month - 1, 1));
}

function showPageError(message) {
  document.getElementById("staffPageTitle").textContent = message;
}

function initials(name) {
  return String(name || "").trim().split(/\s+/).slice(-2).map((part) => part[0]).join("").toUpperCase();
}

function allowedView(view) {
  const aliases = VIEW_PERMISSION_ALIASES[view] || [];
  return permissionCodes.some((code) => aliases.includes(code));
}

function setView(viewName) {
  if (!allowedView(viewName)) viewName = Object.keys(VIEW_PERMISSION_ALIASES).find(allowedView);
  if (!viewName) {
    document.querySelectorAll("[data-staff-panel]").forEach((panel) => { panel.hidden = true; });
    showPageError("Tài khoản chưa được cấp quyền chức năng.");
    return;
  }
  document.querySelectorAll("[data-staff-panel]").forEach((panel) => {
    const active = panel.dataset.staffPanel === viewName;
    panel.hidden = !active;
    panel.classList.toggle("active", active);
  });
  document.querySelectorAll("[data-staff-view]").forEach((link) => {
    link.hidden = !allowedView(link.dataset.staffView);
    link.classList.toggle("is-active", link.dataset.staffView === viewName);
  });
  const activeLink = document.querySelector(`[data-staff-view="${viewName}"]`);
  document.getElementById("staffPageTitle").textContent = activeLink?.textContent.trim() || "Thông tin cá nhân";
  history.replaceState(null, "", `#${viewName}`);
}

document.querySelectorAll("[data-staff-view]").forEach((link) => link.addEventListener("click", (event) => {
  event.preventDefault();
  setView(link.dataset.staffView);
}));

// Shared print helpers (used by both salary views).
function addCell(row, value, tag = "td") {
  const cell = document.createElement(tag); cell.textContent = String(value ?? ""); row.append(cell); return cell;
}

function appendPrintTable(sheet, headers, rows, totals) {
  const table = document.createElement("table"); table.className = "staff-table staff-print-table";
  const head = document.createElement("thead"); const headRow = document.createElement("tr"); headers.forEach((header) => addCell(headRow, header, "th")); head.append(headRow); table.append(head);
  const body = document.createElement("tbody"); rows.forEach((values) => { const row = document.createElement("tr"); values.forEach((value) => addCell(row, value)); body.append(row); }); table.append(body);
  if (totals) { const foot = document.createElement("tfoot"); const row = document.createElement("tr"); totals.forEach((value) => addCell(row, value, "th")); foot.append(row); table.append(foot); }
  sheet.append(table);
}

function preparePrintSheet(sheet, title, period) {
  sheet.replaceChildren(); const company = document.createElement("p"); company.className = "staff-print-company"; company.textContent = "JEWELS · BẢNG LƯƠNG CÁ NHÂN";
  const heading = document.createElement("h1"); heading.textContent = title; const subtitle = document.createElement("p"); subtitle.textContent = `${employee.full_name} · ${employee.employee_code || ""} · ${position?.position_title || ""} · ${period}`; sheet.append(company, heading, subtitle);
}

function printSheet(sheet) {
  document.querySelectorAll(".staff-print-sheet").forEach((item) => { item.hidden = true; }); sheet.hidden = false; document.body.classList.add("staff-printing"); window.print();
}

window.addEventListener("afterprint", () => { document.body.classList.remove("staff-printing"); document.querySelectorAll(".staff-print-sheet").forEach((sheet) => { sheet.hidden = true; }); });

async function loadStaffPortal() {
  if (!portal.requireSession("staff", "staff-login.html")) return;
  const boot = await callStaff({ action: "boot" });
  if (!boot.ok || !boot.data.employee) { showPageError("Không tải được hồ sơ nhân sự. Vui lòng đăng nhập lại."); return; }
  employee = boot.data.employee;
  contact = boot.data.contact;
  position = boot.data.position;
  department = position ? { department_id: position.department_id, department_name: position.department_name } : null;
  permissionCodes = boot.data.permissionCodes || [];
  if ((boot.data.roleNames || []).some((name) => ["manager", "hr_manager", "quản lý", "quản lý nhân sự"].includes(String(name).toLowerCase()))) { window.location.replace("../manager/dashboard.html"); return; }
  document.getElementById("adminLogoutBtn").addEventListener("click", () => { portal.clearSession("staff"); window.location.href = "staff-login.html"; });
  setView(window.location.hash.slice(1) || "profile");
  // The profile view always loads: it also fills the sidebar name/avatar.
  const tasks = VIEW_MODULES.profile?.load ? [VIEW_MODULES.profile.load()] : [];
  ["leave", "salary-month", "salary-year"].forEach((view) => {
    if (allowedView(view) && VIEW_MODULES[view]?.load) tasks.push(VIEW_MODULES[view].load());
  });
  const results = await Promise.allSettled(tasks); if (results.some((result) => result.status === "rejected")) showPageError("Không tải được dữ liệu. Vui lòng thử lại sau.");
}
