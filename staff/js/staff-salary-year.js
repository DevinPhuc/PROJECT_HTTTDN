// Lương năm: annual table, totals and print.
let payrollRecords = [];

function payrollFor(month, year) {
  return payrollRecords.find((record) => Number(record.pay_month) === month && Number(record.pay_year) === year);
}

async function loadAnnualPayroll(data) {
  const year = new Date().getFullYear(); document.getElementById("salaryYearTitle").textContent = year;
  if (!data) {
    const result = await callStaff({ action: "payroll_year", year });
    if (!result.ok) throw new Error(result.error);
    data = result.data;
  }
  payrollRecords = data.payroll || []; const recordMap = new Map(payrollRecords.map((record) => [Number(record.pay_month), record]));
  const rows = document.getElementById("annualRows"); rows.replaceChildren();
  for (let month = 1; month <= 12; month += 1) { const record = recordMap.get(month); const row = document.createElement("tr"); addCell(row, `Tháng ${String(month).padStart(2, "0")}`); if (record) { addCell(row, `${record.work_days ?? "-"} ngày`); addCell(row, money(record.gross_salary)); addCell(row, money(record.total_deductions ?? Number(record.gross_salary || 0) - Number(record.net_salary || 0))); addCell(row, money(record.net_salary)); } else { addCell(row, "-"); addCell(row, "Chưa có dữ liệu"); addCell(row, "-"); addCell(row, "-"); } rows.append(row); }
  const totals = payrollRecords.reduce((sum, record) => ({ gross: sum.gross + Number(record.gross_salary || 0), deduction: sum.deduction + Number(record.total_deductions ?? Number(record.gross_salary || 0) - Number(record.net_salary || 0)), net: sum.net + Number(record.net_salary || 0), days: sum.days + Number(record.work_days || 0) }), { gross: 0, deduction: 0, net: 0, days: 0 });
  const totalRow = document.createElement("tr"); ["Tổng năm", `${totals.days} ngày`, money(totals.gross), money(totals.deduction), money(totals.net)].forEach((value) => addCell(totalRow, value, "th")); document.getElementById("annualTotals").replaceChildren(totalRow);
  const summary = document.getElementById("annualSummary"); summary.replaceChildren(); [["Số tháng có lương", payrollRecords.length], ["Tổng thu nhập", money(totals.gross)], ["Tổng khấu trừ", money(totals.deduction)], ["Tổng thực nhận", money(totals.net)]].forEach(([captionText, valueText]) => { const item = document.createElement("div"); const caption = document.createElement("span"); caption.textContent = captionText; const value = document.createElement("strong"); value.textContent = valueText; item.append(caption, value); summary.append(item); });
}

function printAnnual() {
  const year = new Date().getFullYear(); const sheet = document.getElementById("annualPrintSheet"); preparePrintSheet(sheet, "Bảng lương năm", String(year));
  const rows = Array.from({ length: 12 }, (_, index) => { const record = payrollFor(index + 1, year); return record ? [`Tháng ${String(index + 1).padStart(2, "0")}`, String(record.work_days ?? "-"), money(record.gross_salary), money(record.total_deductions ?? Number(record.gross_salary || 0) - Number(record.net_salary || 0)), money(record.net_salary)] : [`Tháng ${String(index + 1).padStart(2, "0")}`, "-", "Chưa có dữ liệu", "-", "-"]; });
  const totals = payrollRecords.reduce((sum, record) => ({ gross: sum.gross + Number(record.gross_salary || 0), deduction: sum.deduction + Number(record.total_deductions ?? Number(record.gross_salary || 0) - Number(record.net_salary || 0)), net: sum.net + Number(record.net_salary || 0), days: sum.days + Number(record.work_days || 0) }), { gross: 0, deduction: 0, net: 0, days: 0 });
  appendPrintTable(sheet, ["Tháng", "Ngày công", "Thu nhập", "Khấu trừ", "Thực nhận"], rows, ["Tổng năm", String(totals.days), money(totals.gross), money(totals.deduction), money(totals.net)]); printSheet(sheet);
}

document.getElementById("printAnnualBtn").addEventListener("click", printAnnual);

VIEW_MODULES["salary-year"] = { load: () => loadAnnualPayroll() };
