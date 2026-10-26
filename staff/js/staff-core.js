// Staff portal core: session boot, permissions, view switching and shared
// helpers. Each menu has its own file (staff-profile.js, staff-leave.js,
// staff-salary-month.js, staff-salary-year.js) that registers a load
// function into VIEW_MODULES.
const portal = window.jewelsPortal;
const DEMO_MODE = new URLSearchParams(window.location.search).get("demo") === "1";
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
const demoToday = new Date();
const demoYear = demoToday.getFullYear();
const demoMonth = demoToday.getMonth() + 1;
let demoLeaveRequests = [{
  leave_type: "annual",
  start_date: `${demoYear}-01-15`,
  end_date: `${demoYear}-01-16`,
  reason: "Dữ liệu minh họa",
  status: "approved"
}];
const demoEmployee = {
  employee_id: "demo-staff",
  employee_code: "DEMO-024",
  full_name: "Nguyễn Minh An",
  email: "an.demo@example.test",
  date_of_birth: "1998-04-15",
  hire_date: "2023-06-12"
};
const demoContact = { phone_number: "0900 000 000", address: "Địa chỉ mẫu, chỉ dùng để xem thử" };
const demoPosition = { position_title: "Nhân viên kinh doanh", department_name: "Kinh doanh" };
const demoPayrollRecords = Array.from({ length: demoMonth }, (_, index) => ({
  pay_month: index + 1,
  pay_year: demoYear,
  base_salary: 22000000,
  standard_days: 22,
  work_days: 20,
  overtime_hours: 4,
  allowance: 1000000,
  overtime_pay: 750000,
  insurance_rate: 10.5,
  insurance_amount: 2310000,
  personal_income_tax: 250000,
  gross_salary: 21750000,
  total_deductions: 2560000,
  net_salary: 19190000
}));

async function callStaff(body) {
  if (!DEMO_MODE) return portal.callPortal("staff", "staff-portal", body, { loginUrl: "staff-login.html" });

  switch (body.action) {
    case "boot":
      return {
        ok: true,
        data: {
          employee: { ...demoEmployee },
          contact: { ...demoContact },
          position: { ...demoPosition },
          roleNames: [],
          permissionCodes: Object.values(VIEW_PERMISSION_ALIASES).flat()
        }
      };
    case "update_profile":
      Object.assign(demoEmployee, {
        full_name: body.full_name,
        date_of_birth: body.date_of_birth
      });
      Object.assign(demoContact, {
        phone_number: body.phone_number,
        address: body.address
      });
      return { ok: true, data: { employee: { ...demoEmployee }, contact: { ...demoContact } } };
    case "leave_list":
      return { ok: true, data: { requests: demoLeaveRequests.map((request) => ({ ...request })) } };
    case "leave_create":
      demoLeaveRequests.unshift({
        leave_type: {
          "Nghỉ phép": "annual",
          "Nghỉ ốm đau": "sick",
          "Nghỉ thai sản": "maternity",
          "Xin nghỉ việc": "resignation"
        }[body.type] || String(body.type),
        start_date: body.start_date,
        end_date: body.end_date,
        reason: body.reason,
        status: "pending"
      });
      return { ok: true, data: { requests: demoLeaveRequests.map((request) => ({ ...request })) } };
    case "payroll_month":
      return {
        ok: true,
        data: {
          payroll: demoPayrollRecords.find((record) => record.pay_year === body.year && record.pay_month === body.month) || null
        }
      };
    case "payroll_year":
      return {
        ok: true,
        data: { payroll: demoPayrollRecords.filter((record) => record.pay_year === body.year) }
      };
    default:
      return { ok: false, error: "unknown_action" };
  }
}

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
  if (DEMO_MODE) {
    document.getElementById("staffDemoNotice").hidden = false;
  } else if (!portal.requireSession("staff", "staff-login.html")) {
    return;
  }
  const boot = await callStaff({ action: "boot" });
  if (!boot.ok || !boot.data.employee) { showPageError("Không tải được hồ sơ nhân sự. Vui lòng đăng nhập lại."); return; }
  employee = boot.data.employee;
  contact = boot.data.contact;
  position = boot.data.position;
  department = position ? { department_id: position.department_id, department_name: position.department_name } : null;
  permissionCodes = boot.data.permissionCodes || [];
  if ((boot.data.roleNames || []).some((name) => ["manager", "hr_manager", "quản lý", "quản lý nhân sự"].includes(String(name).toLowerCase()))) { window.location.replace("../manager/dashboard.html"); return; }
  document.getElementById("adminLogoutBtn").addEventListener("click", () => {
    if (!DEMO_MODE) portal.clearSession("staff");
    window.location.href = "staff-login.html";
  });
  setView(window.location.hash.slice(1) || "profile");
  // The profile view always loads: it also fills the sidebar name/avatar.
  const tasks = VIEW_MODULES.profile?.load ? [VIEW_MODULES.profile.load()] : [];
  ["leave", "salary-month", "salary-year"].forEach((view) => {
    if (allowedView(view) && VIEW_MODULES[view]?.load) tasks.push(VIEW_MODULES[view].load());
  });
  const results = await Promise.allSettled(tasks); if (results.some((result) => result.status === "rejected")) showPageError("Không tải được dữ liệu. Vui lòng thử lại sau.");
}
