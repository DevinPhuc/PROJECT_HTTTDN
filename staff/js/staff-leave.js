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
    // Card navigation matches rows through these read-only markers.
    row.dataset.leaveId = String(request.leave_request_id ?? "");
    row.dataset.leaveType = String(request.leave_type ?? "");
    row.dataset.leaveStatus = String(request.status ?? "pending").toLowerCase();
    const period = request.leave_type === "resignation" ? `Ngày dự kiến cuối: ${dateLabel(request.start_date)}` : `${dateLabel(request.start_date)} - ${dateLabel(request.end_date)}`;
    [LEAVE_TYPE_LABELS[request.leave_type] || request.leave_type_label || "Chưa phân loại", period, request.reason].forEach((value) => { const cell = document.createElement("td"); cell.textContent = value; row.append(cell); });
    const statusCell = document.createElement("td"); const badge = document.createElement("span"); badge.className = `staff-status staff-status-${String(request.status || "pending").toLowerCase()}`; badge.textContent = statusLabel(request.status); statusCell.append(badge); row.append(statusCell); rows.append(row);
  });
}

function updateLeaveType() {
  const resignation = document.getElementById("leaveType").value === "Xin nghỉ việc";
  const endField = document.getElementById("leaveEndField"); const endDate = document.getElementById("leaveEnd");
  endField.hidden = resignation; endDate.required = !resignation; if (resignation) endDate.value = "";
}

// ---------- KPI tổng quan ----------
// Data comes from the leave_summary action; numeric rules live server-side.
let leaveUpcoming = null;
let kpiHighlightTimer = 0;

function highlightLeaveRows(match) {
  const rows = document.querySelectorAll('[data-staff-panel="leave"] #leaveRows tr');
  rows.forEach((row) => row.classList.toggle("staff-row-highlight", match(row)));
  const history = document.querySelector('[data-staff-panel="leave"] .staff-history-panel');
  if (history) history.scrollIntoView({ behavior: "smooth", block: "start" });
  clearTimeout(kpiHighlightTimer);
  kpiHighlightTimer = setTimeout(() => { rows.forEach((row) => row.classList.remove("staff-row-highlight")); }, 2500);
}

function setLeaveKpiError() {
  document.getElementById("kpiAnnualBalance").textContent = "–";
  document.getElementById("kpiUsed").textContent = "–";
  document.getElementById("kpiPending").textContent = "–";
  document.getElementById("kpiUpcoming").textContent = "–";
  ["kpiAnnualBalanceDetail", "kpiUsedDetail", "kpiPendingDetail", "kpiUpcomingDetail"].forEach((id) => {
    document.getElementById(id).textContent = "Không tải được dữ liệu.";
  });
}

function renderLeaveSummary(summary) {
  leaveUpcoming = summary.upcoming;
  const remaining = Math.max(0, (summary.annual_granted || 0) - (summary.annual_committed || 0));
  document.getElementById("kpiAnnualBalance").textContent = `${remaining} ngày`;
  // Pending annual days are committed to the quota by the create rule, so they are spelled out.
  const pendingAnnualNote = summary.annual_pending_days > 0 ? ` · ${summary.annual_pending_days} ngày chờ duyệt` : "";
  document.getElementById("kpiAnnualBalanceDetail").textContent = `Đã dùng ${summary.annual_committed}/${summary.annual_granted} ngày${pendingAnnualNote}`;
  document.getElementById("kpiUsed").textContent = `${summary.used_days} ngày`;
  document.getElementById("kpiUsedDetail").textContent = `Từ đầu năm ${summary.year}`;
  document.getElementById("kpiPending").textContent = `${summary.pending_count} đơn`;
  document.getElementById("kpiPendingDetail").textContent = `Tổng ${summary.pending_days} ngày nghỉ`;
  if (summary.upcoming) {
    document.getElementById("kpiUpcoming").textContent = dateLabel(summary.upcoming.start_date);
    document.getElementById("kpiUpcomingDetail").textContent =
      `${dateLabel(summary.upcoming.end_date)} · ${LEAVE_TYPE_LABELS[summary.upcoming.leave_type] || summary.upcoming.leave_type_label || "Nghỉ"} · ${summary.upcoming.num_days} ngày`;
  } else {
    document.getElementById("kpiUpcoming").textContent = "—";
    document.getElementById("kpiUpcomingDetail").textContent = "Chưa có kỳ nghỉ sắp tới.";
  }
}

async function renderLeaveKpis() {
  try {
    const result = await callStaff({ action: "leave_summary" });
    if (!result.ok) throw new Error(result.error);
    renderLeaveSummary(result.data.summary);
  } catch {
    setLeaveKpiError();
  }
}

document.getElementById("kpiUsedBtn").addEventListener("click", () => {
  highlightLeaveRows((row) => row.dataset.leaveStatus === "approved" && row.dataset.leaveType !== "resignation");
});
document.getElementById("kpiPendingBtn").addEventListener("click", () => {
  highlightLeaveRows((row) => row.dataset.leaveStatus === "pending");
});
document.getElementById("kpiUpcomingBtn").addEventListener("click", () => {
  const upcoming = leaveUpcoming;
  highlightLeaveRows((row) => row.dataset.leaveId === String(upcoming?.leave_request_id ?? "")
    || (upcoming && !upcoming.leave_request_id && row.dataset.leaveType === String(upcoming.leave_type || "")));
});

document.getElementById("leaveType").addEventListener("change", updateLeaveType);
document.getElementById("leaveStart").addEventListener("change", (event) => { document.getElementById("leaveEnd").min = event.target.value; });
// Toast auto-clears after 5s; timer is reset on every message so rapid resubmits don't flicker.
let leaveFeedbackTimer = 0;
function setLeaveFeedback(message) {
  const feedback = document.getElementById("leaveFeedback");
  feedback.textContent = message;
  clearTimeout(leaveFeedbackTimer);
  if (message) leaveFeedbackTimer = setTimeout(() => { feedback.textContent = ""; }, 5000);
}

document.getElementById("leaveForm").addEventListener("submit", async (event) => {
  // Capture before the first await — event.currentTarget is null afterwards.
  const form = event.currentTarget;
  event.preventDefault();
  if (!form.checkValidity()) {
    setLeaveFeedback("Vui lòng nhập đầy đủ thông tin.");
    form.reportValidity();
    return;
  }
  const values = Object.fromEntries(new FormData(form).entries());
  const result = await callStaff({ action: "leave_create", type: values.type, start_date: values.startDate, end_date: values.endDate || null, reason: String(values.reason || "").trim() });
  setLeaveFeedback(result.ok ? "Đơn đã được gửi."
    : { invalid_type: "Loại nghỉ không hợp lệ.", invalid_dates: "Ngày nghỉ không hợp lệ.", missing_reason: "Vui lòng nhập lý do.", leave_rule: "Số ngày vượt quy định của loại nghỉ này." }[result.error]
      || "Không thể gửi đơn. Vui lòng thử lại.");
  if (result.ok) {
    form.reset(); updateLeaveType();
    await Promise.all([renderLeaveRequests(), renderLeaveKpis()]); // fresh fetch — the create response doesn't carry the lists
  }
});

document.getElementById("leaveStart").min = new Date().toISOString().slice(0, 10);
updateLeaveType();

// Clearing the form when the employee navigates away mid-entry.
VIEW_MODULES.leave = {
  load: () => Promise.all([renderLeaveRequests(), renderLeaveKpis()]),
  leave: () => {
    const form = document.getElementById("leaveForm");
    form.reset(); updateLeaveType(); setLeaveFeedback("");
  }
};
