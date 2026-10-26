// Lương tháng: load one month's payroll and print it.
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
  const result = await callStaff({ action: "payroll_month", year, month });
  const content = document.getElementById("monthlySalaryContent"); content.replaceChildren(); if (!result.ok) throw new Error(result.error);
  const data = result.data.payroll;
  if (!data) { const empty = document.createElement("p"); empty.className = "staff-panel staff-empty-state"; empty.textContent = "Chưa có bảng lương cho tháng này."; content.append(empty); return; }
  const breakdown = payrollBreakdown(data);
  const summary = document.createElement("section"); summary.className = "staff-salary-summary"; const amount = document.createElement("div");
  const label = document.createElement("span"); label.textContent = "Thực nhận"; const value = document.createElement("strong"); value.textContent = breakdown.netSalary == null ? "Chưa có dữ liệu" : money(breakdown.netSalary); const period = document.createElement("small"); period.textContent = monthLabel(year, month); amount.append(label, value, period);
  const print = document.createElement("button"); print.type = "button"; print.className = "admin-primary-btn"; print.textContent = "In bảng lương tháng"; print.addEventListener("click", () => printMonthly(data, year, month)); summary.append(amount, print);
  const panel = document.createElement("section"); panel.className = "staff-panel staff-month-details"; const titleRow = document.createElement("div"); titleRow.className = "staff-section-heading";
  const title = document.createElement("h3"); title.textContent = `Chi tiết ${monthLabel(year, month)}`; const attendance = document.createElement("span"); attendance.className = "staff-muted"; attendance.textContent = `${data.work_days ?? "-"}/${data.standard_days ?? "-"} ngày công · ${data.overtime_hours || 0} giờ tăng ca`; titleRow.append(title, attendance);
  const table = document.createElement("table"); table.className = "staff-table staff-pay-table"; const head = document.createElement("thead"); const headRow = document.createElement("tr"); ["Khoản mục", "Cách tính", "Số tiền"].forEach((text) => addCell(headRow, text, "th")); head.append(headRow); table.append(head);
  const body = document.createElement("tbody");
  breakdown.rows.forEach(([name, calculation, value], index) => {
    const row = document.createElement("tr");
    addCell(row, name, "th");
    addCell(row, calculation).className = "staff-pay-calculation";
    addCell(row, value == null ? "Chưa có dữ liệu" : money(value)).className = "staff-pay-amount";
    if (index === 4) row.className = "staff-gross-row";
    if (index === breakdown.rows.length - 1) row.className = "staff-net-row";
    body.append(row);
  });
  table.append(body); panel.append(titleRow, table); content.append(summary, panel);
}

function printMonthly(record, year, month) {
  const sheet = document.getElementById("monthlyPrintSheet"); preparePrintSheet(sheet, "Bảng lương tháng", monthLabel(year, month));
  const breakdown = payrollBreakdown(record);
  appendPrintTable(
    sheet,
    ["Khoản mục", "Cách tính", "Số tiền"],
    breakdown.rows.slice(0, -1).map(([name, calculation, value]) => [name, calculation, value == null ? "Chưa có dữ liệu" : money(value)]),
    ["Thực nhận", breakdown.rows[breakdown.rows.length - 1][1], breakdown.netSalary == null ? "Chưa có dữ liệu" : money(breakdown.netSalary)]
  );
  printSheet(sheet);
}

const now = new Date();
document.getElementById("salaryMonth").value = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
document.getElementById("salaryMonth").addEventListener("change", () => loadMonthlyPayroll().catch(() => showPageError("Không tải được bảng lương.")));

VIEW_MODULES["salary-month"] = { load: loadMonthlyPayroll };
