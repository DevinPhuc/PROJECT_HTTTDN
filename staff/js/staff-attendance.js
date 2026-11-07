// Chấm công: two buttons — "Vào làm" (clock-in) and "Ra về" (clock-out) — over
// the two-column card. Mỗi lượt vào/ra là một dòng trong database; một ngày có
// thể có nhiều lượt. Cả hai nút luôn bấm được (chỉ khóa trong lúc đang gửi).
const ATT_STATUS_LABELS = {
  present: "Có mặt",
  absent: "Vắng mặt",
  late: "Đi muộn",
  onleave: "Nghỉ phép"
};
const CLOCK_MESSAGES = { in: "Đã ghi nhận giờ vào.", out: "Đã ghi nhận giờ ra." };
const LOADING_LABELS = { in: "Đang chấm công vào…", out: "Đang chấm công ra…" };
const ATT_ERROR_MESSAGES = {
  already_in: "Bạn đang trong ca. Bấm 'Ra về' để kết thúc lượt này.",
  not_clocked_in: "Chưa có lượt vào làm đang mở. Bấm 'Vào làm' trước.",
  duplicate: "Thao tác quá nhanh. Vui lòng thử lại.",
  unauthorized: "Phiên đăng nhập đã hết hạn, vui lòng đăng nhập lại."
};
const ATT_GENERIC_ERROR = "Không ghi nhận được. Vui lòng thử lại.";
const NOT_CHECKED = "--:--";

let attendanceState = { today: "", records: [] };
let attendanceClockTimer = 0;
let attendanceFeedbackTimer = 0;
// History table (section 6): client-side filter + pagination, 10 rows per page.
// Month = yyyy-mm picker; week = 1..4 (7-day blocks of the chosen month).
const ATT_PAGE_SIZE = 10;
const attendanceView = { filter: "all", page: 1, month: null, week: null };

// Month/week options come from the system clock, built once per page load.
(function initAttendancePickerOptions() {
  const year = new Date().getFullYear();
  const monthSel = document.getElementById("attendanceMonth");
  for (let m = 1; m <= 12; m++) {
    const option = document.createElement("option");
    option.value = `${year}-${String(m).padStart(2, "0")}`;
    option.textContent = `Tháng ${m}`;
    monthSel.append(option);
  }
  const weekSel = document.getElementById("attendanceWeek");
  for (let w = 1; w <= 4; w++) {
    const option = document.createElement("option");
    option.value = String(w);
    option.textContent = `Tuần ${w}`;
    weekSel.append(option);
  }
})();

function updateAttendancePickerControls() {
  document.getElementById("attendanceMonth").hidden =
    !["week", "month"].includes(attendanceView.filter);
  document.getElementById("attendanceWeek").hidden = attendanceView.filter !== "week";
  if (!document.getElementById("attendanceMonth").hidden) {
    document.getElementById("attendanceMonth").value = attendanceView.month;
  }
  if (!document.getElementById("attendanceWeek").hidden) {
    document.getElementById("attendanceWeek").value = String(attendanceView.week);
  }
}

// yyyy-mm-dd → local Date (no toISOString UTC shift).
function isoDate(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function parseIsoDate(value) {
  const [y, m, d] = String(value).slice(0, 10).split("-").map(Number);
  return new Date(y, m - 1, d);
}

// Only data from the current system year and earlier is shown.
function attendanceFiltered() {
  const year = String(attendanceState.today || isoDate(new Date())).slice(0, 4);
  const records = attendanceState.records.filter((r) => r.work_date.slice(0, 4) <= year);
  const today = parseIsoDate(attendanceState.today);
  if (attendanceView.filter === "day") return records.filter((r) => r.work_date === attendanceState.today);
  if (attendanceView.filter === "month") {
    const month = attendanceView.month;
    return records.filter((r) => r.work_date.slice(0, 7) === month);
  }
  if (attendanceView.filter === "week") {
    // Week w of the chosen month = days (1+7(w-1)) … min(7w, last day);
    // week 4 absorbs the month's tail so days 29–31 are never unreachable.
    const week = Number(attendanceView.week) || 1;
    const startDay = 1 + (week - 1) * 7;
    const monthDate = parseIsoDate(`${attendanceView.month}-01`);
    const lastDay = new Date(monthDate.getFullYear(), monthDate.getMonth() + 1, 0).getDate();
    const endDay = week === 4 ? lastDay : Math.min(7 * week, lastDay);
    return records.filter((r) => {
      if (r.work_date.slice(0, 7) !== attendanceView.month) return false;
      const day = Number(r.work_date.slice(8, 10));
      return day >= startDay && day <= endDay;
    });
  }
  return records;
}

function setAttendanceFeedback(message) {
  const feedback = document.getElementById("attendanceFeedback");
  feedback.textContent = message;
  clearTimeout(attendanceFeedbackTimer);
  if (message) attendanceFeedbackTimer = setTimeout(() => { feedback.textContent = ""; }, 5000);
}

// Backend sends "HH:MM:SS" (Asia/Ho_Chi_Minh); show "HH:MM".
function timeShort(value) {
  return String(value || "").slice(0, 5);
}

function attendanceStatusBadge(status) {
  const badge = document.createElement("span");
  const key = String(status || "").toLowerCase();
  badge.className = `staff-status staff-status-${key}`;
  badge.textContent = ATT_STATUS_LABELS[key] || status;
  return badge;
}

function todayRecords() {
  return attendanceState.records.filter((item) => item.work_date === attendanceState.today);
}

// Lượt đang mở trong ngày (đã vào, chưa ra). Không có lượt mở thì trả null,
// và hai ô giờ trên khung reset về --:--.
function activeTodayRecord() {
  return todayRecords().find((item) => item.check_in && !item.check_out) || null;
}

function attendanceButton(phase) {
  return document.getElementById(phase === "in" ? "attendanceCheckInBtn" : "attendanceCheckOutBtn");
}

function refreshAttendanceUI() {
  const activeRecord = activeTodayRecord();

  // Có lượt mở: hiện giờ vào của lượt đó. Giờ ra luôn --:-- cho tới khi bấm Ra về,
  // sau đó cả hai ô reset về --:-- cho lượt tiếp theo.
  document.getElementById("attendanceCheckIn").textContent = activeRecord ? timeShort(activeRecord.check_in) : NOT_CHECKED;
  document.getElementById("attendanceCheckOut").textContent = NOT_CHECKED;

  // Nút không bao giờ bị khóa vĩnh viễn: chỉ khóa trong lúc yêu cầu đang chạy.
  ["in", "out"].forEach((buttonPhase) => {
    const button = attendanceButton(buttonPhase);
    button.disabled = button.dataset.loading === "1";
  });

  const summary = document.getElementById("attendanceSummary");
  const sessions = todayRecords().filter((item) => item.check_in);
  if (activeRecord) {
    summary.innerHTML = `Hôm nay: đang trong ca (lượt ${sessions.length})</strong>`;
  } else if (sessions.length > 0) {
    summary.textContent = `Hôm nay đã hoàn thành ${sessions.length} lượt chấm công.`;
  } else {
    summary.textContent = "Chưa chấm công hôm nay";
  }
}

async function renderAttendancePanel(preloaded) {
  const result = preloaded || await callStaff({ action: "attendance_list" });
  if (!result.ok) throw new Error(result.error);
  attendanceState = { today: result.data.today, records: result.data.records || [] };
  // Defaults so the pickers are usable the first time week/month is chosen.
  attendanceView.month ||= attendanceState.today.slice(0, 7);
  attendanceView.week ||= Math.min(4, Math.ceil(parseIsoDate(attendanceState.today).getDate() / 7));
  renderAttendanceSlice();
  refreshAttendanceUI();
  return result;
}

// Render the current filter + page of the history table, plus the pager.
function renderAttendanceSlice() {
  updateAttendancePickerControls();
  const rows = document.getElementById("attendanceRows"); rows.replaceChildren();
  const filtered = attendanceFiltered();
  if (!filtered.length) {
    const row = document.createElement("tr"); const cell = document.createElement("td");
    cell.colSpan = 4; cell.className = "staff-empty-cell"; cell.textContent = "Chưa có dữ liệu chấm công."; row.append(cell); rows.append(row);
  }
  const totalPages = Math.max(1, Math.ceil(filtered.length / ATT_PAGE_SIZE));
  attendanceView.page = Math.min(attendanceView.page, totalPages);
  const pageStart = (attendanceView.page - 1) * ATT_PAGE_SIZE;
  filtered.slice(pageStart, pageStart + ATT_PAGE_SIZE).forEach((record) => {
    const row = document.createElement("tr");
    [dateLabel(record.work_date), record.check_in ? timeShort(record.check_in) : "—", record.check_out ? timeShort(record.check_out) : "—"].forEach((value) => {
      const cell = document.createElement("td"); cell.textContent = value; row.append(cell);
    });
    const statusCell = document.createElement("td"); statusCell.append(attendanceStatusBadge(record.status)); row.append(statusCell);
    rows.append(row);
  });
  renderAttendancePager(totalPages);
}

function renderAttendancePager(totalPages) {
  const pager = document.getElementById("attendancePager");
  pager.replaceChildren();
  if (totalPages <= 1) { pager.hidden = true; return; }
  const mkBtn = (label, target, disabled) => {
    const btn = document.createElement("button");
    btn.type = "button"; btn.className = "admin-secondary-btn"; btn.textContent = label;
    if (disabled) btn.disabled = true;
    btn.addEventListener("click", () => {
      attendanceView.page = target;
      renderAttendanceSlice();
    });
    return btn;
  };
  pager.append(mkBtn("‹ Trước", attendanceView.page - 1, attendanceView.page <= 1));
  const label = document.createElement("span");
  label.textContent = `Trang ${attendanceView.page}/${totalPages}`;
  pager.append(label);
  pager.append(mkBtn("Sau ›", attendanceView.page + 1, attendanceView.page >= totalPages));
  pager.hidden = false;
}

document.getElementById("attendanceFilter").addEventListener("change", (event) => {
  attendanceView.filter = event.target.value;
  attendanceView.page = 1;
  renderAttendanceSlice();
});

document.getElementById("attendanceMonth").addEventListener("change", (event) => {
  attendanceView.month = event.target.value;
  attendanceView.page = 1;
  renderAttendanceSlice();
});

document.getElementById("attendanceWeek").addEventListener("change", (event) => {
  attendanceView.week = Number(event.target.value);
  attendanceView.page = 1;
  renderAttendanceSlice();
});

// Chặn bấm sai thứ tự trước khi gọi server. Trả về thông báo, hoặc "" nếu hợp lệ.
function attendanceGuard(clicked) {
  const active = activeTodayRecord();
  if (clicked === "in" && active) return ATT_ERROR_MESSAGES.already_in;
  if (clicked === "out" && !active) return ATT_ERROR_MESSAGES.not_clocked_in;
  return "";
}

async function performClock(phase) {
  const button = attendanceButton(phase);
  const label = button.querySelector(".staff-clock-btn-label");
  const originalLabel = label.textContent;
  button.dataset.loading = "1";
  refreshAttendanceUI();
  label.textContent = LOADING_LABELS[phase];

  let result;
  try {
    // "phase" cho server biết đây là lượt vào hay lượt ra.
    result = await callStaff({ action: "attendance_clock", phase });
  } finally {
    label.textContent = originalLabel;
    delete button.dataset.loading;
  }

  if (!result.ok) {
    setAttendanceFeedback(ATT_ERROR_MESSAGES[result.error] || ATT_GENERIC_ERROR);
    await renderAttendancePanel().catch(() => refreshAttendanceUI());
    return;
  }

  await renderAttendancePanel(result);
  // Danh sách sắp xếp mới nhất trước: bản ghi đầu tiên của hôm nay là lượt vừa thao tác.
  const latest = todayRecords()[0];
  const stamp = phase === "in" ? latest?.check_in : latest?.check_out;
  setAttendanceFeedback(`${CLOCK_MESSAGES[phase]} ${timeShort(stamp)}`);
}

["in", "out"].forEach((phase) => {
  attendanceButton(phase).addEventListener("click", async () => {
    // Trạng thái cũ (ví dụ qua nửa đêm) có thể chặn nhầm: tải lại một lần rồi kiểm tra lại.
    let blocked = attendanceGuard(phase);
    if (blocked) {
      await renderAttendancePanel().catch(() => {});
      blocked = attendanceGuard(phase);
    }
    if (blocked) { setAttendanceFeedback(blocked); return; }

    try {
      await performClock(phase);
    } catch {
      refreshAttendanceUI();
      setAttendanceFeedback(ATT_GENERIC_ERROR);
    }
  });
});

// Live clock in the panel's home timezone (matches server-side "today").
function startAttendanceClock() {
  clearInterval(attendanceClockTimer);
  attendanceClockTimer = setInterval(tickAttendanceClock, 1000);
  tickAttendanceClock();
}

function tickAttendanceClock() {
  const now = new Date();
  // "Thứ Sáu, 30/10/2026" — vi-VN renders the weekday lowercase.
  const dateText = now.toLocaleDateString("vi-VN", {
    weekday: "long", day: "2-digit", month: "2-digit", year: "numeric", timeZone: "Asia/Ho_Chi_Minh"
  });
  document.getElementById("clockDate").textContent = dateText.replace(/^./, (c) => c.toUpperCase());
}

startAttendanceClock();

// Navigating away stops the ticking clock and clears the toast; returning
// to the view restarts it through load().
VIEW_MODULES.attendance = {
  load: () => {
    startAttendanceClock();
    return renderAttendancePanel().catch(() => {
      refreshAttendanceUI();
      setAttendanceFeedback("Không thể tải dữ liệu chấm công. Vui lòng thử lại sau.");
    });
  },
  leave: () => {
    clearInterval(attendanceClockTimer);
    setAttendanceFeedback("");
  }
};