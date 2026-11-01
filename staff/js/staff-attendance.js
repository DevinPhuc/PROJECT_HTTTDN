// Chấm công: two buttons — "Vào làm" (clock-in) and "Ra về" (clock-out) — over
// the two-column card. Mỗi lượt vào/ra là một dòng trong database; một ngày có
// thể có nhiều lượt. Cả hai nút luôn bấm được (chỉ khóa trong lúc đang gửi).
const ATT_STATUS_LABELS = {
  present: "Có mặt",
  absent: "Vắng mặt",
  late: "Đi muộn",
  halfday: "Nửa ngày",
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
    summary.innerHTML = `Hôm nay: đang trong ca (lượt ${sessions.length}), vào <strong>${timeShort(activeRecord.check_in)}</strong> · ra —`;
  } else if (sessions.length > 0) {
    summary.textContent = `Hôm nay đã hoàn thành ${sessions.length} lượt chấm công. Sẵn sàng cho lượt mới.`;
  } else {
    summary.textContent = "Chưa chấm công hôm nay";
  }
}

async function renderAttendancePanel(preloaded) {
  const result = preloaded || await callStaff({ action: "attendance_list" });
  if (!result.ok) throw new Error(result.error);
  attendanceState = { today: result.data.today, records: result.data.records || [] };

  const rows = document.getElementById("attendanceRows"); rows.replaceChildren();
  if (!attendanceState.records.length) {
    const row = document.createElement("tr"); const cell = document.createElement("td");
    cell.colSpan = 4; cell.className = "staff-empty-cell"; cell.textContent = "Chưa có dữ liệu chấm công."; row.append(cell); rows.append(row);
  }
  attendanceState.records.forEach((record) => {
    const row = document.createElement("tr");
    [dateLabel(record.work_date), record.check_in ? timeShort(record.check_in) : "—", record.check_out ? timeShort(record.check_out) : "—"].forEach((value) => {
      const cell = document.createElement("td"); cell.textContent = value; row.append(cell);
    });
    const statusCell = document.createElement("td"); statusCell.append(attendanceStatusBadge(record.status)); row.append(statusCell);
    rows.append(row);
  });
  refreshAttendanceUI();
  return result;
}

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