// Lương tháng: load one month's payroll and print it.
async function loadMonthlyPayroll() {
  const [year, month] = document.getElementById("salaryMonth").value.split("-").map(Number);
  const result = await callStaff({ action: "payroll_month", year, month });
  const content = document.getElementById("monthlySalaryContent"); content.replaceChildren(); if (!result.ok) throw new Error(result.error);
  const data = result.data.payroll;
  if (!data) { const empty = document.createElement("p"); empty.className = "staff-panel staff-empty-state"; empty.textContent = "Chưa có bảng lương cho tháng này."; content.append(empty); return; }
  const summary = document.createElement("section"); summary.className = "staff-salary-summary"; const amount = document.createElement("div");
  const label = document.createElement("span"); label.textContent = "Thực nhận"; const value = document.createElement("strong"); value.textContent = money(data.net_salary); const period = document.createElement("small"); period.textContent = monthLabel(year, month); amount.append(label, value, period);
  const print = document.createElement("button"); print.type = "button"; print.className = "admin-primary-btn"; print.textContent = "In bảng lương tháng"; print.addEventListener("click", () => printMonthly(data, year, month)); summary.append(amount, print);
  const panel = document.createElement("section"); panel.className = "staff-panel staff-month-details"; const titleRow = document.createElement("div"); titleRow.className = "staff-section-heading";
  const title = document.createElement("h3"); title.textContent = `Chi tiết ${monthLabel(year, month)}`; const attendance = document.createElement("span"); attendance.className = "staff-muted"; attendance.textContent = `${data.work_days ?? "-"}/${data.standard_days ?? "-"} ngày công · ${data.overtime_hours || 0} giờ tăng ca`; titleRow.append(title, attendance);
  const table = document.createElement("table"); table.className = "staff-table staff-pay-table"; const body = document.createElement("tbody");
  [["Lương cơ bản", money(data.base_salary)], ["Lương theo ngày công", money(Number(data.base_salary) * Number(data.work_days || 0) / Number(data.standard_days || 1))], ["Thưởng/phụ cấp", money(data.allowance ?? data.bonus)], ["Lương tăng ca", money(data.overtime_pay)], ["Bảo hiểm", `- ${money(data.insurance_amount)}`], ["Thuế TNCN", `- ${money(data.personal_income_tax)}`], ["Thực nhận", money(data.net_salary)]].forEach(([name, amountText], index) => { const row = document.createElement("tr"); const header = addCell(row, name, "th"); const amountCell = addCell(row, amountText); amountCell.style.textAlign = "right"; if (index === 6) row.className = "staff-net-row"; body.append(row); });
  table.append(body); panel.append(titleRow, table); content.append(summary, panel);
}

function printMonthly(record, year, month) {
  const sheet = document.getElementById("monthlyPrintSheet"); preparePrintSheet(sheet, "Bảng lương tháng", monthLabel(year, month));
  appendPrintTable(sheet, ["Khoản mục", "Số tiền"], [["Lương cơ bản", money(record.base_salary)], ["Ngày công", `${record.work_days ?? "-"}/${record.standard_days ?? "-"}`], ["Thưởng/phụ cấp", money(record.allowance ?? record.bonus)], ["Tăng ca", money(record.overtime_pay)], ["Bảo hiểm", `- ${money(record.insurance_amount)}`], ["Thuế TNCN", `- ${money(record.personal_income_tax)}`]], ["Thực nhận", money(record.net_salary)]); printSheet(sheet);
}

const now = new Date();
document.getElementById("salaryMonth").value = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
document.getElementById("salaryMonth").addEventListener("change", () => loadMonthlyPayroll().catch(() => showPageError("Không tải được bảng lương.")));

VIEW_MODULES["salary-month"] = { load: loadMonthlyPayroll };
