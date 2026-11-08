let leaderToastTimer;
function showLeaderToast(type, message) {
  const toast = document.getElementById(type === "error" ? "leaderErrorToast" : "leaderSuccessToast");
  if (!toast) return;
  if (message) {
    const span = toast.querySelector("span");
    if (span) span.textContent = message;
  }
  clearTimeout(leaderToastTimer);
  document.querySelectorAll(".leader-toast").forEach((el) => el.classList.remove("show"));
  toast.classList.add("show");
  leaderToastTimer = setTimeout(() => toast.classList.remove("show"), 3500);
}

const portal = window.jewelsPortal;
const callLeader = (body) =>
  portal.callPortal("leader", "leader-portal", body, { loginUrl: "login.html" });

const LEAVE_TYPES = {
  annual: "Nghỉ phép",
  sick: "Nghỉ ốm đau",
  maternity: "Nghỉ thai sản",
  resignation: "Xin nghỉ việc",
};
const LEAVE_STATUSES = {
  approved: "Đã duyệt",
  rejected: "Từ chối",
};
const ATTENDANCE_CODES = [
  ["", "—"],
  ["X", "X · Có mặt"],
  ["P", "P · Nghỉ phép"],
  ["L", "L · Nghỉ lễ"],
  ["O", "O · Nghỉ ốm"],
  ["KP", "KP · Không lương"],
];
const STATUS_CODE = {
  present: "X",
  late: "X",
  on_leave: "P",
  absent: "KP",
};
const STATUS_LABEL = {
  present: "Có mặt",
  late: "Đi muộn",
  halfday: "Nửa ngày",
  on_leave: "Nghỉ phép",
  absent: "Vắng mặt",
};

let employees = [];
let attendance = [];
let requests = [];
let actor = null;
let currentMonth = "";
let ownAttendance = { today: "", records: [] };
let attendanceFeedbackTimer = 0;
let savingAttendance = false;

function localMonth() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Ho_Chi_Minh",
    year: "numeric",
    month: "2-digit",
  }).format(new Date());
}

function dateLabel(value) {
  if (!value) return "-";
  const [year, month, day] = String(value).slice(0, 10).split("-").map(Number);
  return new Intl.DateTimeFormat("vi-VN").format(new Date(year, month - 1, day));
}

function timeLabel(value) {
  return value ? String(value).slice(0, 5) : "--:--";
}

function addCell(row, value, tag = "td") {
  const cell = document.createElement(tag);
  cell.textContent = String(value ?? "");
  row.append(cell);
  return cell;
}

function showFeedback(element, message, isError = false) {
  element.textContent = message;
  element.classList.toggle("is-error", isError);
}

function showClockFeedback(message, isError = false) {
  const feedback = document.getElementById("leaderClockFeedback");
  showFeedback(feedback, message, isError);
  clearTimeout(attendanceFeedbackTimer);
  if (message) {
    attendanceFeedbackTimer = setTimeout(() => {
      feedback.textContent = "";
    }, 5000);
  }
}

function renderProfile() {
  const account = portal.getSession("leader")?.user || {};
  const name = actor?.full_name || account.full_name || account.username || "Trưởng nhóm";
  document.getElementById("leaderProfileName").textContent = name;
  document.getElementById("leaderProfileEmail").textContent = actor?.email || account.email || account.username || "";
  document.getElementById("leaderAvatar").textContent = name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0] || "")
    .join("")
    .toUpperCase();
}

async function loadTeamData(month = currentMonth) {
  const result = await callLeader({ action: "leader_boot", month });
  if (!result.ok) throw new Error(result.message || result.error);
  const data = result.data;
  employees = data.employees || [];
  attendance = data.attendance || [];
  requests = data.leave_requests || [];
  actor = data.actor || actor;
  currentMonth = data.month;
  document.getElementById("leaderClockMonth").value = currentMonth;
  document.getElementById("leaderSheetMonth").value = currentMonth.slice(5, 7);
  document.getElementById("leaderSheetYear").value = currentMonth.slice(0, 4);
  renderProfile();
  renderTeamAttendance();
  renderAttendanceSheet();
  renderRequests();
}

function renderTeamAttendance() {
  const body = document.getElementById("leaderClockRows");
  body.replaceChildren();
  const names = new Map(employees.map((employee) => [employee.employee_id, employee]));
  const rows = [...attendance].sort((a, b) =>
    String(b.work_date).localeCompare(String(a.work_date))
      || String(names.get(a.employee_id)?.full_name || "").localeCompare(
        String(names.get(b.employee_id)?.full_name || ""),
        "vi",
      ));
  if (!rows.length) {
    const row = document.createElement("tr");
    addCell(row, "Chưa có dữ liệu chấm công trong tháng.", "td").colSpan = 5;
    body.append(row);
    return;
  }
  rows.forEach((record) => {
    const row = document.createElement("tr");
    addCell(row, names.get(record.employee_id)?.full_name || "Nhân sự");
    addCell(row, dateLabel(record.work_date));
    addCell(row, timeLabel(record.check_in_time));
    addCell(row, timeLabel(record.check_out_time));
    addCell(row, STATUS_LABEL[String(record.status || "").toLowerCase()] || record.status || "-");
    body.append(row);
  });
}

function attendanceCode(record) {
  return record?.day_code || STATUS_CODE[String(record?.status || "").toLowerCase()] || "";
}

function renderAttendanceSheet() {
  const head = document.getElementById("leaderSheetHead");
  const body = document.getElementById("leaderSheetBody");
  head.replaceChildren();
  body.replaceChildren();
  const [year, month] = currentMonth.split("-").map(Number);
  const dayCount = new Date(year, month, 0).getDate();
  const header = document.createElement("tr");
  addCell(header, "Nhân sự", "th");
  for (let day = 1; day <= dayCount; day += 1) addCell(header, String(day), "th");
  head.append(header);

  const search = document.getElementById("leaderAttendanceSearch").value.trim().toLocaleLowerCase("vi");
  const visible = employees.filter((employee) =>
    `${employee.full_name || ""} ${employee.employee_code || ""}`
      .toLocaleLowerCase("vi")
      .includes(search));
  if (!visible.length) {
    const row = document.createElement("tr");
    addCell(row, employees.length ? "Không tìm thấy nhân sự phù hợp." : "Chưa có nhân sự trong nhóm.", "td").colSpan = dayCount + 1;
    body.append(row);
    return;
  }

  const records = new Map(attendance.map((record) => [
    `${record.employee_id}:${String(record.work_date).slice(0, 10)}`,
    record,
  ]));
  for (const employee of visible) {
    const row = document.createElement("tr");
    const identity = addCell(row, employee.full_name);
    const code = document.createElement("small");
    code.className = "leader-status-note";
    code.textContent = employee.employee_code || employee.position_title || "";
    identity.append(code);
    for (let day = 1; day <= dayCount; day += 1) {
      const date = `${currentMonth}-${String(day).padStart(2, "0")}`;
      const record = records.get(`${employee.employee_id}:${date}`);
      const cell = document.createElement("td");
      const select = document.createElement("select");
      select.dataset.employeeId = employee.employee_id;
      select.dataset.workDate = date;
      select.setAttribute("aria-label", `${employee.full_name}, ngày ${day}`);
      const selectedCode = attendanceCode(record);
      ATTENDANCE_CODES.forEach(([value, label]) => {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = label;
        option.selected = value === selectedCode;
        select.append(option);
      });
      cell.append(select);
      row.append(cell);
    }
    body.append(row);
  }
}

async function saveAttendanceSheet() {
  if (savingAttendance) return;
  const changes = [];
  const records = new Map(attendance.map((record) => [
    `${record.employee_id}:${String(record.work_date).slice(0, 10)}`,
    attendanceCode(record),
  ]));
  document.querySelectorAll("#leaderSheetBody select[data-employee-id]").forEach((select) => {
    const key = `${select.dataset.employeeId}:${select.dataset.workDate}`;
    if ((records.get(key) || "") === select.value) return;
    changes.push({
      employee_id: select.dataset.employeeId,
      work_date: select.dataset.workDate,
      day_code: select.value,
    });
  });
  if (!changes.length) {
    showFeedback(document.getElementById("leaderAttendanceFeedback"), "Bảng chấm công không có thay đổi.");
    return;
  }

  savingAttendance = true;
  const button = document.getElementById("leaderSaveAttendanceBtn");
  button.disabled = true;
  try {
    for (let index = 0; index < changes.length; index += 1000) {
      const result = await callLeader({
        action: "leader_attendance_bulk",
        ym: currentMonth,
        items: changes.slice(index, index + 1000),
      });
      if (!result.ok) {
        const message = result.error === "forbidden"
          ? "Không có quyền cập nhật dữ liệu ngoài nhóm của bạn."
          : "Không lưu được bảng chấm công. Vui lòng thử lại.";
        showFeedback(document.getElementById("leaderAttendanceFeedback"), message, true);
        return;
      }
    }
    await loadTeamData(currentMonth);
    showFeedback(document.getElementById("leaderAttendanceFeedback"), `Đã lưu ${changes.length} ngày chấm công.`);
  } catch (error) {
    console.error(error);
    showFeedback(document.getElementById("leaderAttendanceFeedback"), "Không thể kết nối để lưu dữ liệu.", true);
  } finally {
    savingAttendance = false;
    button.disabled = false;
  }
}

function leaveStatus(request) {
  if (request.status === "approved") return LEAVE_STATUSES.approved;
  if (request.status === "rejected") return LEAVE_STATUSES.rejected;
  if (request.leader_status === "approved") return "Chờ quản lý duyệt";
  return "Chờ trưởng nhóm duyệt";
}

function renderRequests() {
  const body = document.getElementById("leaderRequestsBody");
  const filter = document.getElementById("leaderRequestFilter").value;
  body.replaceChildren();
  const visible = requests.filter((request) => {
    if (filter === "pending") return request.status === "pending" && !request.leader_status;
    if (filter === "manager") return request.status === "pending" && request.leader_status === "approved";
    if (filter === "resolved") return request.status !== "pending";
    return true;
  });
  if (!visible.length) {
    const row = document.createElement("tr");
    addCell(row, "Không có đơn trong danh sách.", "td").colSpan = 7;
    body.append(row);
    return;
  }
  visible.forEach((request) => {
    const row = document.createElement("tr");
    const employee = document.createElement("td");
    const name = document.createElement("strong");
    name.textContent = request.full_name || "Nhân sự";
    employee.append(name);
    if (request.employee_code) {
      const code = document.createElement("small");
      code.className = "leader-status-note";
      code.textContent = request.employee_code;
      employee.append(code);
    }
    row.append(employee);
    addCell(row, LEAVE_TYPES[request.leave_type] || "Chưa phân loại");
    addCell(row, dateLabel(request.requested_at));
    const range = request.leave_type === "resignation"
      ? `Ngày dự kiến cuối: ${dateLabel(request.start_date)}`
      : `${dateLabel(request.start_date)} - ${dateLabel(request.end_date)}`;
    addCell(row, range);
    addCell(row, request.reason || "—");
    const status = addCell(row, leaveStatus(request));
    const badge = document.createElement("span");
    badge.className = `hr-status ${request.status === "rejected" ? "hr-status-rejected" : request.status === "approved" ? "hr-status-approved" : "leader-stage-waiting"}`;
    badge.textContent = status.textContent;
    status.replaceChildren(badge);
    const actions = document.createElement("td");
    if (request.status === "pending" && !request.leader_status) {
      const wrap = document.createElement("div");
      wrap.className = "leader-actions";
      [["approved", "Duyệt"], ["rejected", "Từ chối"]].forEach(([decision, label]) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = decision === "approved"
          ? "leader-button leader-button-primary"
          : "leader-button leader-button-secondary";
        button.dataset.requestId = request.leave_request_id;
        button.dataset.decision = decision;
        button.textContent = label;
        wrap.append(button);
      });
      actions.append(wrap);
    } else {
      actions.textContent = request.status === "pending" ? "Đã chuyển quản lý" : "—";
    }
    row.append(actions);
    body.append(row);
  });
}

async function reviewRequest(button) {
  const decision = button.dataset.decision;
  const request = requests.find((item) => item.leave_request_id === button.dataset.requestId);
  if (!request) return;
  const employee = request.full_name || "nhân sự";
  const actionText = decision === "approved" ? "duyệt và chuyển đơn lên quản lý" : "từ chối đơn";
  if (!window.confirm(`Bạn có chắc muốn ${actionText} của ${employee} không?`)) return;

  button.disabled = true;
  const result = await callLeader({
    action: "leader_leave_review",
    leave_request_id: request.leave_request_id,
    status: decision,
  });
  if (!result.ok) {
    button.disabled = false;
    window.alert(result.error === "already_decided"
      ? "Đơn này đã được xử lý."
      : result.error === "forbidden"
        ? "Bạn chỉ được xử lý đơn của nhân sự trong nhóm."
        : result.error === "forbidden_or_already_decided"
          ? "Đơn đã được xử lý hoặc không còn thuộc phạm vi nhóm của bạn."
        : "Không cập nhật được đơn. Vui lòng thử lại.");
    return;
  }
  await loadTeamData(currentMonth);
}

function renderOwnAttendance() {
  const todayRows = ownAttendance.records.filter((record) => record.work_date === ownAttendance.today);
  const active = todayRows.find((record) => record.check_in && !record.check_out);
  const completed = todayRows.filter((record) => record.check_in).length;
  document.getElementById("leaderCheckIn").textContent = active ? timeLabel(active.check_in) : "--:--";
  document.getElementById("leaderCheckOut").textContent = "--:--";
  document.getElementById("leaderClockSummary").textContent = active
    ? `Hôm nay đang trong ca · vào ${timeLabel(active.check_in)}`
    : completed
      ? `Hôm nay đã hoàn thành ${completed} lượt chấm công.`
      : "Chưa chấm công hôm nay";
  document.getElementById("leaderCheckInBtn").disabled = Boolean(active);
  document.getElementById("leaderCheckOutBtn").disabled = !active;
}

async function loadOwnAttendance() {
  const result = await callLeader({ action: "leader_attendance_list" });
  if (!result.ok) throw new Error(result.error);
  ownAttendance = { today: result.data.today, records: result.data.records || [] };
  renderOwnAttendance();
}

async function clock(phase) {
  const result = await callLeader({ action: "leader_attendance_clock", phase });
  if (!result.ok) {
    showClockFeedback(result.error === "already_in"
      ? "Bạn đang trong ca làm việc."
      : result.error === "not_clocked_in"
        ? "Bạn chưa chấm công vào."
        : "Không ghi nhận được. Vui lòng thử lại.", true);
    await loadOwnAttendance();
    return;
  }
  ownAttendance = { today: result.data.today, records: result.data.records || [] };
  renderOwnAttendance();
  showClockFeedback(phase === "in" ? "Đã ghi nhận giờ vào." : "Đã ghi nhận giờ ra.");
}

function setView(name) {
  const view = ["attendance-clock", "attendance-sheet", "approvals"].includes(name) ? name : "attendance-clock";
  document.querySelectorAll("[data-leader-panel]").forEach((panel) => {
    const active = panel.dataset.leaderPanel === view;
    panel.hidden = !active;
    panel.classList.toggle("active", active);
  });
  document.querySelectorAll("[data-leader-view]").forEach((link) =>
    link.classList.toggle("is-active", link.dataset.leaderView === view));
  const activeLink = document.querySelector(`[data-leader-view="${view}"]`);
  document.getElementById("leaderPageTitle").textContent = activeLink?.textContent.trim() || "Chấm công";
  history.replaceState(null, "", `#${view}`);
}

async function refresh() {
  await loadTeamData(currentMonth);
  await loadOwnAttendance();
}

function tickClock() {
  const text = new Date().toLocaleDateString("vi-VN", {
    weekday: "long",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    timeZone: "Asia/Ho_Chi_Minh",
  });
  document.getElementById("leaderClockDate").textContent = text.replace(/^./, (char) => char.toUpperCase());
}

async function initLeaderPortal() {
  if (!portal.requireSession("leader", "login.html")) return;
  renderProfile();
  currentMonth = localMonth();
  document.getElementById("leaderClockMonth").value = currentMonth;
  document.getElementById("leaderSheetMonth").value = currentMonth.slice(5, 7);
  document.getElementById("leaderSheetYear").value = currentMonth.slice(0, 4);
  try {
    await refresh();
  } catch (error) {
    console.error(error);
    const msg = error.message === "forbidden"
      ? "Tài khoản không có quyền truy cập cổng trưởng nhóm."
      : "Không tải được dữ liệu nhóm. Vui lòng thử lại.";
    const loadingEl = document.getElementById("leaderLoading");
    loadingEl.innerHTML = `<span>${msg}</span> <button type="button" class="leader-button leader-button-secondary" id="leaderRetryBtn" style="margin-left: 12px; display: inline-flex; vertical-align: middle; padding: 4px 12px; font-size: 13px;">Thử lại</button>`;
    document.getElementById("leaderRetryBtn")?.addEventListener("click", () => {
      loadingEl.textContent = "Đang tải dữ liệu nhóm...";
      initLeaderPortal();
    });
    return;
  }
  document.getElementById("leaderLoading").hidden = true;
  document.getElementById("leaderApp").hidden = false;
  setView(location.hash.slice(1));
  tickClock();
  setInterval(tickClock, 60_000);
}

document.querySelectorAll("[data-leader-view]").forEach((link) => {
  link.addEventListener("click", (event) => {
    event.preventDefault();
    setView(link.dataset.leaderView);
  });
});
window.addEventListener("hashchange", () => setView(location.hash.slice(1)));
document.getElementById("leaderRefreshBtn").addEventListener("click", async () => {
  try {
    await refresh();
    document.getElementById("leaderLoading").hidden = true;
    document.getElementById("leaderApp").hidden = false;
  } catch (error) {
    console.error(error);
    window.alert("Không thể làm mới dữ liệu. Vui lòng thử lại.");
  }
});
document.getElementById("leaderClockMonth").addEventListener("change", async (event) => {
  try {
    await loadTeamData(event.target.value);
  } catch (error) {
    console.error(error);
    showLeaderToast("error", "Không tải được lịch sử chấm công trong tháng này.");
  }
});
document.getElementById("leaderSheetMonth").addEventListener("change", async (event) => {
  try {
    const year = document.getElementById("leaderSheetYear").value;
    await loadTeamData(`${year}-${event.target.value}`);
  } catch (error) {
    console.error(error);
    showLeaderToast("error", "Không tải được bảng chấm công trong tháng này.");
  }
});
document.getElementById("leaderSheetYear").addEventListener("change", async (event) => {
  const year = Number(event.target.value);
  if (!Number.isInteger(year) || year < 2000 || year > 2100) {
    event.target.value = currentMonth.slice(0, 4);
    return;
  }
  try {
    await loadTeamData(`${year}-${document.getElementById("leaderSheetMonth").value}`);
  } catch (error) {
    console.error(error);
    window.alert("Không tải được bảng chấm công trong tháng này.");
  }
});
document.getElementById("leaderAttendanceSearch").addEventListener("input", renderAttendanceSheet);
document.getElementById("leaderSaveAttendanceBtn").addEventListener("click", saveAttendanceSheet);
document.getElementById("leaderRequestFilter").addEventListener("change", renderRequests);
document.getElementById("leaderRequestsBody").addEventListener("click", (event) => {
  const button = event.target.closest("[data-request-id][data-decision]");
  if (button) reviewRequest(button).catch((error) => {
    console.error(error);
    window.alert("Không kết nối được máy chủ. Trạng thái đơn chưa được xác nhận.");
  });
});
document.getElementById("leaderCheckInBtn").addEventListener("click", () => clock("in").catch((error) => {
  console.error(error);
  showClockFeedback("Không ghi nhận được giờ vào.", true);
}));
document.getElementById("leaderCheckOutBtn").addEventListener("click", () => clock("out").catch((error) => {
  console.error(error);
  showClockFeedback("Không ghi nhận được giờ ra.", true);
}));

const profileToggle = document.getElementById("leaderProfileToggle");
const profileMenu = document.getElementById("leaderProfileMenu");
profileToggle.addEventListener("click", () => {
  const open = profileToggle.getAttribute("aria-expanded") === "true";
  profileToggle.setAttribute("aria-expanded", String(!open));
  profileMenu.classList.toggle("show-menu", !open);
});
document.addEventListener("click", (event) => {
  if (!event.target.closest(".leader-profile-card")) {
    profileToggle.setAttribute("aria-expanded", "false");
    profileMenu.classList.remove("show-menu");
  }
});
const logoutModal = document.getElementById("logoutModal");
const cancelLogoutBtn = document.getElementById("cancelLogoutBtn");
const confirmLogoutBtn = document.getElementById("confirmLogoutBtn");

function setLogoutModalOpen(open) {
  if (logoutModal) logoutModal.hidden = !open;
}

document.getElementById("leaderLogoutBtn")?.addEventListener("click", () => {
  profileMenu.classList.remove("show-menu");
  profileToggle.setAttribute("aria-expanded", "false");
  setLogoutModalOpen(true);
  cancelLogoutBtn?.focus();
});

cancelLogoutBtn?.addEventListener("click", () => {
  setLogoutModalOpen(false);
});

confirmLogoutBtn?.addEventListener("click", () => {
  portal.clearSession("leader");
  window.location.replace("login.html");
});

logoutModal?.addEventListener("click", (event) => {
  if (event.target === logoutModal) setLogoutModalOpen(false);
});

window.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && logoutModal && !logoutModal.hidden) {
    setLogoutModalOpen(false);
  }
});

initLeaderPortal();

// Periodic check for account/role/password changes from admin.
// Only runs when the tab is visible to prevent connection exhaustion.
let lastLeaderPing = Date.now();
async function pingLeaderStatus() {
  if (portal.validSession("leader") && !document.hidden) {
    try {
      lastLeaderPing = Date.now();
      await callLeader({ action: "ping" });
    } catch (_) {
      // background polling for account changes
    }
  }
}

setInterval(pingLeaderStatus, 15000);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && Date.now() - lastLeaderPing > 10000) {
    pingLeaderStatus();
  }
});
