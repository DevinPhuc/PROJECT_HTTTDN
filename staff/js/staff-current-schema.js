(() => {
if (window.__jewelsStaffPortalInitialized) return;
window.__jewelsStaffPortalInitialized = true;

const supabase = window.jewelsSupabase;
const DEMO_MODE = new URLSearchParams(window.location.search).get("demo") === "1";
const VIEW_PERMISSION_ALIASES = {
  profile: ["profile", "view_profile", "update_profile"],
  leave: ["leave", "submit_leave", "view_leave_requests"],
  "salary-month": ["salary_month", "view_monthly_payroll", "view_payroll_monthly", "view_payroll"],
  "salary-year": ["salary_year", "view_annual_payroll", "view_payroll_yearly"]
};
const LEAVE_TYPES = { "Nghỉ phép": "annual", "Nghỉ ốm đau": "sick", "Nghỉ thai sản": "maternity", "Xin nghỉ việc": "resignation" };
const LEAVE_TYPE_LABELS = Object.fromEntries(Object.entries(LEAVE_TYPES).map(([label, value]) => [value, label]));
const LEAVE_STATUS_LABELS = { pending: "Chờ duyệt", approved: "Đã duyệt", rejected: "Từ chối" };
let employee;
let contact;
let position;
let department;
let permissionCodes = [];
let payrollRecords = [];
let demoLeaveRequests = [];

const demoToday = new Date();
const demoYear = demoToday.getFullYear();
const demoMonth = demoToday.getMonth() + 1;
const demoPayrollRecords = Array.from({ length: demoMonth }, (_, index) => {
  const month = index + 1;
  const grossSalary = 21750000;
  const totalDeductions = 2560000;
  return {
    pay_month: month,
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
    gross_salary: grossSalary,
    total_deductions: totalDeductions,
    net_salary: grossSalary - totalDeductions
  };
});

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

function populateProfile() {
  const fields = {
    name: employee.full_name,
    email: employee.email,
    birthDate: employee.date_of_birth || "",
    phone: contact?.phone_number || "",
    address: contact?.address || ""
  };
  Object.entries(fields).forEach(([name, value]) => {
    const field = document.querySelector(`#profileForm [name="${name}"]`);
    if (field) field.value = value;
  });
  document.getElementById("staffSidebarName").textContent = employee.full_name;
  document.getElementById("staffAvatar").textContent = initials(employee.full_name);
  const jobValues = [position?.position_title || "-", department?.department_name || "-", dateLabel(employee.hire_date), "Toàn thời gian"];
  document.querySelectorAll(".staff-job-card dd").forEach((node, index) => { node.textContent = jobValues[index] || "-"; });
  document.querySelector(".staff-employee-code strong").textContent = employee.employee_code || "-";
}

async function loadProfile() {
  if (DEMO_MODE) {
    populateProfile();
    return;
  }
  const [contactResult, positionResult] = await Promise.all([
    supabase.from("employee_contacts").select("employee_id,phone_number,address").eq("employee_id", employee.employee_id).limit(1),
    employee.position_id
      ? supabase.from("positions").select("position_id,position_title,department_id").eq("position_id", employee.position_id).maybeSingle()
      : Promise.resolve({ data: null, error: null })
  ]);
  if (contactResult.error || positionResult.error) throw contactResult.error || positionResult.error;
  contact = contactResult.data?.[0] || null;
  position = positionResult.data;
  if (position?.department_id) {
    const result = await supabase.from("departments").select("department_id,department_name").eq("department_id", position.department_id).maybeSingle();
    if (result.error) throw result.error;
    department = result.data;
  }
  populateProfile();
}

async function saveProfile(event) {
  event.preventDefault();
  const formData = new FormData(event.currentTarget);
  if (DEMO_MODE) {
    employee = { ...employee, full_name: String(formData.get("name") || "").trim(), date_of_birth: formData.get("birthDate") || null };
    contact = { ...contact, phone_number: String(formData.get("phone") || "").trim(), address: String(formData.get("address") || "").trim() };
    populateProfile();
    document.getElementById("profileFeedback").textContent = "Đã cập nhật dữ liệu giả trong phiên xem thử; thông tin không được lưu.";
    return;
  }
  const { error } = await supabase.rpc("update_my_hr_profile", {
    p_full_name: String(formData.get("name") || "").trim(),
    p_phone_number: String(formData.get("phone") || "").trim(),
    p_address: String(formData.get("address") || "").trim(),
    p_date_of_birth: formData.get("birthDate") || null
  });
  const feedback = document.getElementById("profileFeedback");
  feedback.textContent = error ? "Không thể lưu hồ sơ. Vui lòng kiểm tra migration/RLS." : "Đã lưu thông tin cá nhân.";
  if (!error) {
    const result = await supabase.from("employees").select("*").eq("employee_id", employee.employee_id).single();
    if (result.error) throw result.error;
    employee = result.data;
    await loadProfile();
  }
}

document.getElementById("profileForm").addEventListener("submit", (event) => saveProfile(event).catch(() => { document.getElementById("profileFeedback").textContent = "Không thể lưu hồ sơ."; }));

function statusLabel(status) {
  return LEAVE_STATUS_LABELS[status] || status;
}

async function renderLeaveRequests() {
  let data;
  if (DEMO_MODE) {
    data = demoLeaveRequests;
  } else {
    const result = await supabase.from("leave_requests").select("*").eq("employee_id", employee.employee_id).order("start_date", { ascending: false });
    if (result.error) throw result.error;
    data = result.data;
  }
  const rows = document.getElementById("leaveRows"); rows.replaceChildren();
  if (!data.length) {
    const row = document.createElement("tr"); const cell = document.createElement("td"); cell.colSpan = 4; cell.className = "staff-empty-cell"; cell.textContent = "Bạn chưa gửi đơn nào."; row.append(cell); rows.append(row); return;
  }
  data.forEach((request) => {
    const row = document.createElement("tr");
    const period = request.leave_type === "resignation" ? `Ngày dự kiến cuối: ${dateLabel(request.start_date)}` : `${dateLabel(request.start_date)} - ${dateLabel(request.end_date)}`;
    [LEAVE_TYPE_LABELS[request.leave_type] || "Chưa phân loại", period, request.reason].forEach((value) => { const cell = document.createElement("td"); cell.textContent = value; row.append(cell); });
    const statusCell = document.createElement("td"); const badge = document.createElement("span"); badge.className = "staff-status-pending"; badge.textContent = statusLabel(request.status); statusCell.append(badge); row.append(statusCell); rows.append(row);
  });
}

function updateLeaveType() {
  const resignation = document.getElementById("leaveType").value === "Xin nghỉ việc";
  const endField = document.getElementById("leaveEndField"); const endDate = document.getElementById("leaveEnd");
  endField.hidden = resignation; endDate.required = !resignation; if (resignation) endDate.value = "";
}

document.getElementById("leaveType").addEventListener("change", updateLeaveType);
document.getElementById("leaveStart").addEventListener("change", (event) => { document.getElementById("leaveEnd").min = event.target.value; });
document.getElementById("leaveForm").addEventListener("submit", async (event) => {
  event.preventDefault(); const values = Object.fromEntries(new FormData(event.currentTarget).entries());
  if (DEMO_MODE) {
    demoLeaveRequests.unshift({ leave_type: LEAVE_TYPES[values.type], start_date: values.startDate, end_date: values.endDate || null, reason: String(values.reason || "").trim(), status: "pending" });
    event.currentTarget.reset(); updateLeaveType(); document.getElementById("leaveFeedback").textContent = "Đã thêm đơn giả trong phiên xem thử; đơn không được gửi đi."; await renderLeaveRequests(); return;
  }
  const { error } = await supabase.from("leave_requests").insert({ employee_id: employee.employee_id, leave_type: LEAVE_TYPES[values.type], start_date: values.startDate, end_date: values.endDate || null, reason: String(values.reason || "").trim(), status: "pending" });
  if (error) { document.getElementById("leaveFeedback").textContent = "Không thể gửi đơn. Kiểm tra migration/RLS."; return; }
  event.currentTarget.reset(); updateLeaveType(); document.getElementById("leaveFeedback").textContent = "Đơn đã được gửi."; await renderLeaveRequests();
});

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

function payrollFor(month, year) {
  return payrollRecords.find((record) => Number(record.pay_month) === month && Number(record.pay_year) === year);
}

function payrollBreakdown(record) {
  const baseSalary = Number(record.base_salary ?? 0);
  const standardDays = Number(record.standard_days);
  const workDays = record.work_days == null ? NaN : Number(record.work_days);
  const overtimeHours = Number(record.overtime_hours ?? 0);
  const allowance = Number(record.allowance ?? record.bonus ?? 0);
  const overtimePay = Number(record.overtime_pay ?? 0);
  const insuranceRate = Number(record.insurance_rate ?? 10.5);
  const insuranceAmount = Number(record.insurance_amount ?? 0);
  const incomeTax = Number(record.personal_income_tax ?? 0);
  const basePay = standardDays > 0 && Number.isFinite(workDays)
    ? baseSalary * workDays / standardDays
    : null;
  const grossSalary = record.gross_salary == null
    ? (basePay == null ? null : basePay + allowance + overtimePay)
    : Number(record.gross_salary);
  const totalDeductions = record.total_deductions == null
    ? insuranceAmount + incomeTax
    : Number(record.total_deductions);
  const netSalary = record.net_salary == null
    ? (grossSalary == null ? null : grossSalary - totalDeductions)
    : Number(record.net_salary);
  const attendanceCalculation = standardDays > 0 && Number.isFinite(workDays)
    ? `${money(baseSalary)} × ${workDays} / ${standardDays} ngày`
    : "Không có dữ liệu ngày công chuẩn";
  const overtimeCalculation = standardDays > 0
    ? `${money(baseSalary)} / (${standardDays} × 8 giờ) × 150% × ${overtimeHours} giờ`
    : "Không có dữ liệu ngày công chuẩn";

  return {
    baseSalary,
    workDays,
    standardDays,
    overtimeHours,
    basePay,
    allowance,
    overtimePay,
    grossSalary,
    insuranceRate,
    insuranceAmount,
    incomeTax,
    totalDeductions,
    netSalary,
    rows: [
      ["Lương cơ bản", "Mức lương cơ bản được ghi nhận cho kỳ lương", baseSalary],
      ["Lương theo ngày công", attendanceCalculation, basePay],
      ["Thưởng / phụ cấp", "Khoản được quản lý ghi nhận", allowance],
      ["Lương tăng ca", overtimeCalculation, overtimePay],
      ["Tổng thu nhập", "Lương theo ngày công + thưởng/phụ cấp + lương tăng ca", grossSalary],
      ["Bảo hiểm", `${money(baseSalary)} × ${insuranceRate}%`, insuranceAmount],
      ["Thuế TNCN", "Khoản thuế được quản lý ghi nhận", incomeTax],
      ["Tổng khấu trừ", "Bảo hiểm + thuế TNCN", totalDeductions],
      ["Thực nhận", "Tổng thu nhập − tổng khấu trừ", netSalary]
    ]
  };
}

async function loadMonthlyPayroll() {
  const [year, month] = document.getElementById("salaryMonth").value.split("-").map(Number);
  let data;
  if (DEMO_MODE) {
    data = demoPayrollRecords.find((record) => record.pay_year === year && record.pay_month === month) || null;
  } else {
    const result = await supabase.from("payroll").select("*").eq("employee_id", employee.employee_id).eq("pay_year", year).eq("pay_month", month).maybeSingle();
    if (result.error) throw result.error;
    data = result.data;
  }
  const content = document.getElementById("monthlySalaryContent"); content.replaceChildren();
  if (!data) { const empty = document.createElement("p"); empty.className = "staff-panel staff-empty-state"; empty.textContent = "Chưa có bảng lương cho tháng này."; content.append(empty); return; }
  const breakdown = payrollBreakdown(data);
  const summary = document.createElement("section"); summary.className = "staff-salary-summary"; const amount = document.createElement("div");
  const label = document.createElement("span"); label.textContent = "Thực nhận"; const value = document.createElement("strong"); value.textContent = breakdown.netSalary == null ? "Chưa có dữ liệu" : money(breakdown.netSalary); const period = document.createElement("small"); period.textContent = monthLabel(year, month); amount.append(label, value, period);
  const print = document.createElement("button"); print.type = "button"; print.className = "admin-primary-btn"; print.textContent = "In bảng lương tháng"; print.addEventListener("click", () => printMonthly(data, year, month)); summary.append(amount, print);
  const panel = document.createElement("section"); panel.className = "staff-panel staff-month-details"; const titleRow = document.createElement("div"); titleRow.className = "staff-section-heading";
  const title = document.createElement("h3"); title.textContent = `Chi tiết ${monthLabel(year, month)}`; const attendance = document.createElement("span"); attendance.className = "staff-muted"; attendance.textContent = `${data.work_days ?? "-"} / ${data.standard_days ?? "-"} ngày công · ${data.overtime_hours ?? 0} giờ tăng ca`; titleRow.append(title, attendance);
  const table = document.createElement("table"); table.className = "staff-table staff-pay-table"; const head = document.createElement("thead"); const headRow = document.createElement("tr"); ["Khoản mục", "Cách tính", "Số tiền"].forEach((text) => addCell(headRow, text, "th")); head.append(headRow); table.append(head);
  const body = document.createElement("tbody");
  breakdown.rows.forEach(([name, calculation, amount], index) => {
    const row = document.createElement("tr");
    addCell(row, name, "th");
    addCell(row, calculation).className = "staff-pay-calculation";
    addCell(row, amount == null ? "Chưa có dữ liệu" : money(amount)).className = "staff-pay-amount";
    if (index === 4) row.className = "staff-gross-row";
    if (index === breakdown.rows.length - 1) row.className = "staff-net-row";
    body.append(row);
  });
  table.append(body); panel.append(titleRow, table); content.append(summary, panel);
}

async function loadAnnualPayroll() {
  const year = new Date().getFullYear(); document.getElementById("salaryYearTitle").textContent = year;
  if (DEMO_MODE) {
    payrollRecords = demoPayrollRecords;
  } else {
    const result = await supabase.from("payroll").select("*").eq("employee_id", employee.employee_id).eq("pay_year", year).order("pay_month");
    if (result.error) throw result.error;
    payrollRecords = result.data || [];
  }
  const recordMap = new Map(payrollRecords.map((record) => [Number(record.pay_month), record]));
  const rows = document.getElementById("annualRows"); rows.replaceChildren();
  for (let month = 1; month <= 12; month += 1) { const record = recordMap.get(month); const row = document.createElement("tr"); addCell(row, `Tháng ${String(month).padStart(2, "0")}`); if (record) { addCell(row, `${record.work_days ?? "-"} ngày`); addCell(row, money(record.gross_salary)); addCell(row, money(record.total_deductions || Number(record.gross_salary) - Number(record.net_salary))); addCell(row, money(record.net_salary)); } else { addCell(row, "-"); addCell(row, "Chưa có dữ liệu"); addCell(row, "-"); addCell(row, "-"); } rows.append(row); }
  const totals = payrollRecords.reduce((sum, record) => ({ gross: sum.gross + Number(record.gross_salary || 0), deduction: sum.deduction + Number(record.total_deductions || Number(record.gross_salary || 0) - Number(record.net_salary || 0)), net: sum.net + Number(record.net_salary || 0), days: sum.days + Number(record.work_days || 0) }), { gross: 0, deduction: 0, net: 0, days: 0 });
  const totalRow = document.createElement("tr"); ["Tổng năm", `${totals.days} ngày`, money(totals.gross), money(totals.deduction), money(totals.net)].forEach((value) => addCell(totalRow, value, "th")); document.getElementById("annualTotals").replaceChildren(totalRow);
  const summary = document.getElementById("annualSummary"); summary.replaceChildren(); [["Số tháng có lương", payrollRecords.length], ["Tổng thu nhập", money(totals.gross)], ["Tổng khấu trừ", money(totals.deduction)], ["Tổng thực nhận", money(totals.net)]].forEach(([captionText, valueText]) => { const item = document.createElement("div"); const caption = document.createElement("span"); caption.textContent = captionText; const value = document.createElement("strong"); value.textContent = valueText; item.append(caption, value); summary.append(item); });
}

function printMonthly(record, year, month) {
  const sheet = document.getElementById("monthlyPrintSheet"); preparePrintSheet(sheet, "Bảng lương tháng", monthLabel(year, month));
  const breakdown = payrollBreakdown(record);
  const netRow = breakdown.rows[breakdown.rows.length - 1];
  appendPrintTable(
    sheet,
    ["Khoản mục", "Cách tính", "Số tiền"],
    breakdown.rows.slice(0, -1).map(([name, calculation, amount]) => [name, calculation, amount == null ? "Chưa có dữ liệu" : money(amount)]),
    ["Thực nhận", netRow[1], breakdown.netSalary == null ? "Chưa có dữ liệu" : money(breakdown.netSalary)]
  );
  printSheet(sheet);
}

function printAnnual() {
  const year = new Date().getFullYear(); const sheet = document.getElementById("annualPrintSheet"); preparePrintSheet(sheet, "Bảng lương năm", String(year));
  const rows = Array.from({ length: 12 }, (_, index) => { const record = payrollFor(index + 1, year); return record ? [`Tháng ${String(index + 1).padStart(2, "0")}`, String(record.work_days ?? "-"), money(record.gross_salary), money(record.total_deductions || Number(record.gross_salary) - Number(record.net_salary)), money(record.net_salary)] : [`Tháng ${String(index + 1).padStart(2, "0")}`, "-", "Chưa có dữ liệu", "-", "-"]; });
  const totals = payrollRecords.reduce((sum, record) => ({ gross: sum.gross + Number(record.gross_salary || 0), deduction: sum.deduction + Number(record.total_deductions || Number(record.gross_salary || 0) - Number(record.net_salary || 0)), net: sum.net + Number(record.net_salary || 0), days: sum.days + Number(record.work_days || 0) }), { gross: 0, deduction: 0, net: 0, days: 0 });
  appendPrintTable(sheet, ["Tháng", "Ngày công", "Thu nhập", "Khấu trừ", "Thực nhận"], rows, ["Tổng năm", String(totals.days), money(totals.gross), money(totals.deduction), money(totals.net)]); printSheet(sheet);
}

async function loadStaffPortal() {
  if (DEMO_MODE) {
    document.getElementById("staffDemoNotice").hidden = false;
    employee = { employee_id: "demo-staff", full_name: "Nguyễn Minh An", email: "an.demo@example.test", date_of_birth: "1998-04-15", hire_date: "2023-06-12", employee_code: "DEMO-024" };
    contact = { phone_number: "0900 000 000", address: "Địa chỉ mẫu, chỉ dùng để xem thử" };
    position = { position_title: "Nhân viên kinh doanh" };
    department = { department_name: "Kinh doanh" };
    permissionCodes = Object.values(VIEW_PERMISSION_ALIASES).flat();
    demoLeaveRequests = [{
      leave_type: "annual",
      start_date: `${demoYear}-01-15`,
      end_date: `${demoYear}-01-16`,
      reason: "Dữ liệu minh họa",
      status: "approved"
    }];
  } else {
    const { data: { user }, error: authError } = await supabase.auth.getUser(); if (authError || !user) { window.location.replace("staff-login.html"); return; }
    const { data: employeeData, error } = await supabase.from("employees").select("*").eq("email", user.email).single();
    if (error || !employeeData) { showPageError("Chưa tìm thấy hồ sơ nhân sự liên kết email này."); return; }
    employee = employeeData;
    const [roleResult, permissionResult] = await Promise.all([
      supabase.from("user_roles").select("role_id,roles(role_name)").eq("employee_id", employee.employee_id),
      supabase.from("roles").select("role_id,role_permissions(permission_id,permissions(permission_code))")
    ]);
    if (roleResult.error || permissionResult.error) throw roleResult.error || permissionResult.error;
    const assignedRoleIds = new Set((roleResult.data || []).map((item) => item.role_id));
    permissionCodes = (permissionResult.data || []).filter((role) => assignedRoleIds.has(role.role_id)).flatMap((role) => (role.role_permissions || []).map((link) => String(link.permissions?.permission_code || "").toLowerCase()));
    if ((roleResult.data || []).some((item) => ["manager", "hr_manager", "quản lý", "quản lý nhân sự"].includes(String(item.roles?.role_name || "").toLowerCase()))) { window.location.replace("../manager/dashboard.html"); return; }
  }
  await loadProfile();
  const now = new Date(); document.getElementById("salaryMonth").value = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  document.getElementById("salaryMonth").addEventListener("change", () => loadMonthlyPayroll().catch(() => showPageError("Không tải được bảng lương.")));
  document.getElementById("printAnnualBtn").addEventListener("click", printAnnual);
  document.getElementById("leaveStart").min = now.toISOString().slice(0, 10); updateLeaveType();
  document.getElementById("adminLogoutBtn").addEventListener("click", async () => { if (!DEMO_MODE) await supabase.auth.signOut(); window.location.href = "staff-login.html"; });
  setView(window.location.hash.slice(1) || "profile");
  const tasks = [];
  if (allowedView("leave")) tasks.push(renderLeaveRequests());
  if (allowedView("salary-month")) tasks.push(loadMonthlyPayroll());
  if (allowedView("salary-year")) tasks.push(loadAnnualPayroll());
  const results = await Promise.allSettled(tasks); if (results.some((result) => result.status === "rejected")) showPageError("Không tải được dữ liệu. Kiểm tra migration/RLS.");
}

loadStaffPortal().catch(() => showPageError("Không thể kết nối Supabase."));
})();
