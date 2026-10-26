// Đơn nghỉ phép: list own requests and submit new ones.
const LEAVE_TYPE_LABELS = { annual: "Nghỉ phép", sick: "Nghỉ ốm đau", maternity: "Nghỉ thai sản", resignation: "Xin nghỉ việc" };
const LEAVE_STATUS_LABELS = { pending: "Chờ duyệt", approved: "Đã duyệt", rejected: "Từ chối" };

function statusLabel(status) {
  return LEAVE_STATUS_LABELS[String(status || "").toLowerCase()] || status;
}

async function renderLeaveRequests(data) {
  if (!data) {
    const result = await callStaff({ action: "leave_list" });
    if (!result.ok) throw new Error(result.error);
    data = result.data;
  }
  const rows = document.getElementById("leaveRows"); rows.replaceChildren();
  const requests = data.requests || [];
  if (!requests.length) {
    const row = document.createElement("tr"); const cell = document.createElement("td"); cell.colSpan = 4; cell.className = "staff-empty-cell"; cell.textContent = "Bạn chưa gửi đơn nào."; row.append(cell); rows.append(row); return;
  }
  requests.forEach((request) => {
    const row = document.createElement("tr");
    const period = request.leave_type === "resignation" ? `Ngày dự kiến cuối: ${dateLabel(request.start_date)}` : `${dateLabel(request.start_date)} - ${dateLabel(request.end_date)}`;
    [LEAVE_TYPE_LABELS[request.leave_type] || request.leave_type_label || "Chưa phân loại", period, request.reason].forEach((value) => { const cell = document.createElement("td"); cell.textContent = value; row.append(cell); });
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
  const result = await callStaff({ action: "leave_create", type: values.type, start_date: values.startDate, end_date: values.endDate || null, reason: String(values.reason || "").trim() });
  const feedback = document.getElementById("leaveFeedback");
  feedback.textContent = result.ok ? "Đơn đã được gửi."
    : { invalid_type: "Loại nghỉ không hợp lệ.", invalid_dates: "Ngày nghỉ không hợp lệ.", missing_reason: "Vui lòng nhập lý do.", leave_rule: "Số ngày vượt quy định của loại nghỉ này." }[result.error]
      || "Không thể gửi đơn. Vui lòng thử lại.";
  if (result.ok) {
    event.currentTarget.reset(); updateLeaveType();
    await renderLeaveRequests(result.data);
  }
});

document.getElementById("leaveStart").min = new Date().toISOString().slice(0, 10);
updateLeaveType();

VIEW_MODULES.leave = { load: () => renderLeaveRequests() };
