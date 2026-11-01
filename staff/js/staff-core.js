// Staff portal core: session boot, permissions, view switching and shared
// helpers. Each menu has its own file (staff-profile.js, staff-leave.js,
// staff-salary-month.js, staff-salary-year.js) that registers a load
// function into VIEW_MODULES.
const portal = window.jewelsPortal;
const DEMO_MODE = new URLSearchParams(window.location.search).get("demo") === "1";
const VIEW_PERMISSION_ALIASES = {
  // codes must match public.permissions in the DB (dot-notation, e.g. employee.view)
  profile: ["employee.view", "employee.edit"],
  attendance: ["attendance.self"],
  leave: ["leave.create", "leave.view"],
  "salary-month": ["payroll.view"],
  "salary-year": ["payroll.print", "payroll.view"]
};
const VIEW_MODULES = {};
let currentView = null;
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
const demoPersonalInfo = {
  national_id: "079123456789", id_type: "CCCD", nationality: "Vietnam",
  marital_status: "Độc thân", is_disabled: false, protected_until: null
};
const demoQualifications = [{
  qualification_level: "Đại học", major_field: "Quản trị kinh doanh",
  institution_name: "ĐH Kinh tế TP.HCM", graduation_year: 2020
}];
const demoStatusHistory = [{ status: "Active", effective_date: demoEmployee.hire_date, reason: "Nhận việc" }];
const demoPayrollInfo = { bank_name: "Vietcombank", bank_account_no: "0071000812345", tax_code: "8123456789", social_insurance_no: "0123456789", health_insurance_no: "HK4120001234" };
// Sample payroll_details lines, employee side first, employer side separate.
const demoPayrollDetails = (year, month) => year === demoYear && month === demoMonth ? [
  { item_type: "Allowance", item_name: "Phụ cấp ăn trưa", amount: 730000, payer: "Employee" },
  { item_type: "Insurance", item_name: "BHXH người lao động (8%)", amount: 960000, payer: "Employee" },
  { item_type: "Insurance", item_name: "BHYT người lao động (1,5%)", amount: 180000, payer: "Employee" },
  { item_type: "Insurance", item_name: "BHTN người lao động (1%)", amount: 120000, payer: "Employee" },
  { item_type: "Tax", item_name: "Thuế TNCN (dưới mức chịu thuế)", amount: 0, payer: "Employee" },
  { item_type: "Insurance", item_name: "BHXH người sử dụng lao động (17,5%)", amount: 2100000, payer: "Employer" },
  { item_type: "Insurance", item_name: "BHYT người sử dụng lao động (3%)", amount: 360000, payer: "Employer" }
] : [];
let demoAttendanceRecords = [];
function demoIsoToday() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ho_Chi_Minh" }).format(new Date());
}
function demoTimeNow() {
  return new Date().toLocaleTimeString("en-GB", {
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false, timeZone: "Asia/Ho_Chi_Minh"
  });
}
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
      if (body.marital_status) demoPersonalInfo.marital_status = body.marital_status;
      return { ok: true, data: { employee: { ...demoEmployee }, contact: { ...demoContact } } };
    case "leave_list":
      return { ok: true, data: { requests: demoLeaveRequests.map((request) => ({ ...request })) } };
    case "personal_info":
      return {
        ok: true,
        data: {
          personal_info: { ...demoPersonalInfo },
          qualifications: demoQualifications.map((item) => ({ ...item })),
          status_history: demoStatusHistory.map((item) => ({ ...item }))
        }
      };
    case "leave_summary": {
      // Same rules as the staff-portal edge function; annual quota mirrors the leave_types seed.
      const today = demoIsoToday();
      const year = Number(today.slice(0, 4));
      const dayDiff = (from, to) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);
      const committed = demoLeaveRequests.reduce((sum, request) =>
        request.leave_type === "annual" && ["pending", "approved"].includes(request.status) && Number(request.start_date.slice(0, 4)) === year
          ? sum + dayDiff(request.start_date, request.end_date) + 1 : sum, 0);
      const used = demoLeaveRequests.reduce((sum, request) => {
        if (request.leave_type === "resignation" || request.status !== "approved" || request.start_date > today) return sum;
        return sum + Math.max(Math.min(dayDiff(request.start_date, request.end_date) + 1, dayDiff(request.start_date, today) + 1), 0);
      }, 0);
      const pendingRequests = demoLeaveRequests.filter((request) => request.status === "pending");
      const upcoming = demoLeaveRequests
        .filter((request) => request.leave_type !== "resignation" && request.status === "approved" && request.end_date >= today)
        .sort((a, b) => a.start_date.localeCompare(b.start_date))[0];
      return {
        ok: true,
        data: {
          summary: {
            today, year,
            annual_granted: 12,
            annual_committed: committed,
            used_days: used,
            pending_count: pendingRequests.length,
            pending_days: pendingRequests.reduce((sum, request) => request.leave_type === "resignation" ? sum : sum + dayDiff(request.start_date, request.end_date) + 1, 0),
            annual_pending_days: pendingRequests.reduce((sum, request) => request.leave_type === "annual" ? sum + dayDiff(request.start_date, request.end_date) + 1 : sum, 0),
            upcoming: upcoming ? { ...upcoming, leave_request_id: null } : null
          }
        }
      };
    }
    case "payroll_info":
      return { ok: true, data: { info: { ...demoPayrollInfo } } };
    case "payroll_info_save": {
      ["bank_name", "bank_account_no", "tax_code", "social_insurance_no", "health_insurance_no"].forEach((key) => {
        demoPayrollInfo[key] = body[key] || null;
      });
      return { ok: true, data: { info: { ...demoPayrollInfo } } };
    }
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
          payroll: demoPayrollRecords.find((record) => record.pay_year === body.year && record.pay_month === body.month) || null,
          details: demoPayrollDetails(body.year, body.month)
        }
      };
    case "payroll_year":
      return {
        ok: true,
        data: { payroll: demoPayrollRecords.filter((record) => record.pay_year === body.year) }
      };
    case "attendance_list":
      return { ok: true, data: { today: demoIsoToday(), records: demoAttendanceRecords.map((record) => ({ ...record })) } };
    case "attendance_clock": {
      // Mirrors the backend: many sessions per day, one row per session.
      const today = demoIsoToday();
      const open = demoAttendanceRecords.find((item) => item.work_date === today && item.check_in && !item.check_out);
      const phase = body.phase || (open ? "out" : "in");
      if (phase === "out") {
        if (!open) return { ok: false, error: "not_clocked_in" };
        open.check_out = demoTimeNow();
      } else {
        if (open) return { ok: false, error: "already_in" };
        demoAttendanceRecords.unshift({ attendance_id: `demo-clock-${Date.now()}`, work_date: today, check_in: demoTimeNow(), check_out: null, status: "Present" });
      }
      return { ok: true, data: { today, records: demoAttendanceRecords.map((item) => ({ ...item })) } };
    }
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
  // Leaving a view clears its in-progress form (registered per view as `leave`).
  if (currentView && currentView !== viewName) VIEW_MODULES[currentView]?.leave?.();
  currentView = viewName;
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
  // Logout confirmation modal (same behavior as manager dashboard).
  const logoutModal = document.getElementById("logoutModal");
  const cancelLogoutBtn = document.getElementById("cancelLogoutBtn");
  const setLogoutModalOpen = (open) => {
    logoutModal.hidden = !open;
  };
  document.getElementById("adminLogoutBtn").addEventListener("click", () => {
    setProfileMenuOpen(false);
    setLogoutModalOpen(true);
    cancelLogoutBtn.focus();
  });
  cancelLogoutBtn.addEventListener("click", () => setLogoutModalOpen(false));
  document.getElementById("confirmLogoutBtn").addEventListener("click", () => {
    if (!DEMO_MODE) portal.clearSession("staff");
    window.location.href = "staff-login.html";
  });
  logoutModal.addEventListener("click", (event) => {
    if (event.target === logoutModal) setLogoutModalOpen(false);
  });
  // Sidebar profile card toggle (same behavior as manager dashboard).
  const profileToggle = document.getElementById("staffProfileToggle");
  const profileMenu = document.getElementById("staffProfileMenu");
  const profileCard = profileToggle.closest(".admin-profile-card");
  const setProfileMenuOpen = (open) => {
    profileToggle.setAttribute("aria-expanded", String(open));
    profileMenu.classList.toggle("show-menu", open);
  };
  profileToggle.addEventListener("click", () => {
    setProfileMenuOpen(profileToggle.getAttribute("aria-expanded") !== "true");
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
  setView(window.location.hash.slice(1) || "attendance");
  document.body.classList.add("staff-ready");
  // The profile view always loads: it also fills the sidebar name/avatar.
  const tasks = VIEW_MODULES.profile?.load ? [VIEW_MODULES.profile.load()] : [];
  ["attendance", "leave", "salary-month", "salary-year"].forEach((view) => {
    if (allowedView(view) && VIEW_MODULES[view]?.load) tasks.push(VIEW_MODULES[view].load());
  });
  const results = await Promise.allSettled(tasks); if (results.some((result) => result.status === "rejected")) showPageError("Không tải được dữ liệu. Vui lòng thử lại sau.");
}