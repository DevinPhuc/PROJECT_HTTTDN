// Chấm công (manager): same clock card as the staff portal, reusing the
// hr-portal edge actions with the manager token. Manager and employee
// tokens carry the same employee_id claim, so staff actions authenticate
// the manager's own attendance.
(function () {
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
  const ATT_PAGE_SIZE = 10;
  const ATT_PAGE_SIZES = [10, 20, 50, 100];
  const attendanceView = { filter: "all", page: 1, pageSize: 10, sort: "desc", month: null, week: null };
  let attendanceState = { today: "", records: [] };
  let attendanceClockTimer = 0;
  let attendanceFeedbackTimer = 0;

  const callHrAttendance = (body) => portal.callPortal("manager", "hr-portal", body, { loginUrl: "login.html" });

  // Month/week options come from the system clock, built once per page load.
  (function initAttendancePickerOptions() {
    const year = new Date().getFullYear();
    const monthSel = document.getElementById("mgrAttendanceMonth");
    for (let m = 1; m <= 12; m++) {
      const option = document.createElement("option");
      option.value = `${year}-${String(m).padStart(2, "0")}`;
      option.textContent = `Tháng ${m}`;
      monthSel.append(option);
    }
    const weekSel = document.getElementById("mgrAttendanceWeek");
    for (let w = 1; w <= 4; w++) {
      const option = document.createElement("option");
      option.value = String(w);
      option.textContent = `Tuần ${w}`;
      weekSel.append(option);
    }
  })();

  function updateAttendancePickerControls() {
    const monthSel = document.getElementById("mgrAttendanceMonth");
    const weekSel = document.getElementById("mgrAttendanceWeek");
    monthSel.hidden = !["week", "month"].includes(attendanceView.filter);
    weekSel.hidden = attendanceView.filter !== "week";
    if (!monthSel.hidden) monthSel.value = attendanceView.month;
    if (!weekSel.hidden) weekSel.value = String(attendanceView.week);
  }

  // yyyy-mm-dd → local Date (no toISOString UTC shift).
  function parseIsoDate(value) {
    const [y, m, d] = String(value).slice(0, 10).split("-").map(Number);
    return new Date(y, m - 1, d);
  }

  // Only data from the current system year and earlier is shown.
  function attendanceFiltered() {
    const year = String(attendanceState.today).slice(0, 4);
    const records = attendanceState.records.filter((r) => r.work_date.slice(0, 4) <= year);
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
      records = records.filter((r) => {
        if (r.work_date.slice(0, 7) !== attendanceView.month) return false;
        const day = Number(r.work_date.slice(8, 10));
        return day >= startDay && day <= endDay;
      });
    }
    const mult = attendanceView.sort === "asc" ? 1 : -1;
    return [...records].sort((a, b) => {
      const cmpDate = String(a.work_date || "").localeCompare(String(b.work_date || "")) * mult;
      if (cmpDate !== 0) return cmpDate;
      const timeA = String(a.check_in || "");
      const timeB = String(b.check_in || "");
      return timeA.localeCompare(timeB) * mult;
    });
  }

  function setAttendanceFeedback(message) {
    const feedback = document.getElementById("mgrAttendanceFeedback");
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
    badge.className = `mgr-status mgr-status-${key}`;
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
    return document.getElementById(phase === "in" ? "mgrAttendanceCheckInBtn" : "mgrAttendanceCheckOutBtn");
  }

  function refreshAttendanceUI() {
    const activeRecord = activeTodayRecord();

    document.getElementById("mgrAttendanceCheckIn").textContent = activeRecord ? timeShort(activeRecord.check_in) : NOT_CHECKED;
    document.getElementById("mgrAttendanceCheckOut").textContent = NOT_CHECKED;

    const inBtn = attendanceButton("in");
    const outBtn = attendanceButton("out");
    if (inBtn) inBtn.disabled = Boolean(activeRecord) || inBtn.dataset.loading === "1";
    if (outBtn) outBtn.disabled = !activeRecord || outBtn.dataset.loading === "1";

    const summary = document.getElementById("mgrAttendanceSummary");
    const sessions = todayRecords().filter((item) => item.check_in);
    if (summary) {
      if (activeRecord) {
        summary.innerHTML = `Hôm nay đang trong ca · vào <strong>${timeShort(activeRecord.check_in)}</strong>`;
      } else if (sessions.length > 0) {
        summary.textContent = `Hôm nay đã hoàn thành ${sessions.length} lượt chấm công.`;
      } else {
        summary.textContent = "Chưa chấm công hôm nay";
      }
    }
  }

  async function renderAttendancePanel(preloaded) {
    const result = preloaded || await callHrAttendance({ action: "attendance_list" });
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
    const rows = document.getElementById("mgrAttendanceRows"); rows.replaceChildren();
    const filtered = attendanceFiltered();
    const total = filtered.length;
    const size = attendanceView.pageSize || ATT_PAGE_SIZE;
    const totalPages = Math.max(1, Math.ceil(total / size));
    attendanceView.page = Math.min(Math.max(1, attendanceView.page), totalPages);

    if (!filtered.length) {
      const row = document.createElement("tr"); const cell = document.createElement("td");
      cell.colSpan = 4; cell.className = "mgr-empty-cell"; cell.textContent = "Chưa có dữ liệu chấm công."; row.append(cell); rows.append(row);
    } else {
      const pageStart = (attendanceView.page - 1) * size;
      filtered.slice(pageStart, pageStart + size).forEach((record) => {
        const row = document.createElement("tr");
        [dateLabel(record.work_date), record.check_in ? timeShort(record.check_in) : "—", record.check_out ? timeShort(record.check_out) : "—"].forEach((value) => {
          const cell = document.createElement("td"); cell.textContent = value; row.append(cell);
        });
        const statusCell = document.createElement("td"); statusCell.append(attendanceStatusBadge(record.status)); row.append(statusCell);
        rows.append(row);
      });
    }
    renderAttendancePager(total, totalPages);
  }

  function renderAttendancePager(total, totalPages) {
    const pager = document.getElementById("mgrAttendancePager");
    if (!pager) return;
    const size = attendanceView.pageSize || ATT_PAGE_SIZE;
    const p = attendanceView.page - 1;
    const from = total ? p * size + 1 : 0;
    const to = Math.min(total, (p + 1) * size);
    const nums = [];
    const add = (i) => nums.push(`<button type="button" class="pg-n ${i === p ? "on" : ""}" data-pg="${i}">${i + 1}</button>`);
    if (totalPages <= 7) {
      for (let i = 0; i < totalPages; i++) add(i);
    } else {
      add(0);
      const a = Math.max(1, p - 1), b = Math.min(totalPages - 2, p + 1);
      if (a > 1) nums.push('<span class="pg-dot">…</span>');
      for (let i = a; i <= b; i++) add(i);
      if (b < totalPages - 2) nums.push('<span class="pg-dot">…</span>');
      add(totalPages - 1);
    }

    pager.innerHTML = `<span>Hiển thị <b>${from}-${to}</b> / ${total} dòng</span><span class="pg">Số dòng/trang `
      + `<select data-psize>${ATT_PAGE_SIZES.map((s) => `<option value="${s}" ${s === size ? "selected" : ""}>${s}</option>`).join("")}</select>`
      + `<button type="button" class="pg-n" data-pg="${p - 1}" ${p > 0 ? "" : "disabled"}>‹</button>${nums.join("")}`
      + `<button type="button" class="pg-n" data-pg="${p + 1}" ${p < totalPages - 1 ? "" : "disabled"}>›</button>`
      + `</span>`;
    pager.hidden = false;
  }

  document.getElementById("mgrAttendanceFilter")?.addEventListener("change", (event) => {
    attendanceView.filter = event.target.value;
    attendanceView.page = 1;
    renderAttendanceSlice();
  });

  document.getElementById("mgrAttendanceMonth")?.addEventListener("change", (event) => {
    attendanceView.month = event.target.value;
    attendanceView.page = 1;
    renderAttendanceSlice();
  });

  document.getElementById("mgrAttendanceWeek")?.addEventListener("change", (event) => {
    attendanceView.week = Number(event.target.value);
    attendanceView.page = 1;
    renderAttendanceSlice();
  });

  document.getElementById("mgrAttendanceSort")?.addEventListener("change", (event) => {
    attendanceView.sort = event.target.value;
    attendanceView.page = 1;
    renderAttendanceSlice();
  });

  const mgrPagerEl = document.getElementById("mgrAttendancePager");
  if (mgrPagerEl) {
    mgrPagerEl.addEventListener("click", (event) => {
      const btn = event.target.closest("button.pg-n");
      if (!btn || btn.disabled) return;
      const targetPg = Number(btn.dataset.pg);
      if (!Number.isNaN(targetPg)) {
        attendanceView.page = targetPg + 1;
        renderAttendanceSlice();
      }
    });
    mgrPagerEl.addEventListener("change", (event) => {
      const sel = event.target.closest("select[data-psize]");
      if (sel) {
        attendanceView.pageSize = Number(sel.value) || 10;
        attendanceView.page = 1;
        renderAttendanceSlice();
      }
    });
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
    const label = button.querySelector(".mgr-clock-btn-label") || button;
    const originalLabel = label.textContent;
    button.dataset.loading = "1";
    refreshAttendanceUI();
    label.textContent = LOADING_LABELS[phase];

    let result;
    try {
      // "phase" cho server biết đây là lượt vào hay lượt ra.
      result = await callHrAttendance({ action: "attendance_clock", phase });
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
  function tickAttendanceClock() {
    const now = new Date();
    // "Thứ Sáu, 30/10/2026" — vi-VN renders the weekday lowercase.
    const dateText = now.toLocaleDateString("vi-VN", {
      weekday: "long", day: "2-digit", month: "2-digit", year: "numeric", timeZone: "Asia/Ho_Chi_Minh"
    });
    document.getElementById("mgrClockDate").textContent = dateText.replace(/^./, (c) => c.toUpperCase());
  }

  function startAttendanceClock() {
    clearInterval(attendanceClockTimer);
    attendanceClockTimer = setInterval(tickAttendanceClock, 1000);
    tickAttendanceClock();
  }

  function stopAttendanceClock() {
    clearInterval(attendanceClockTimer);
    setAttendanceFeedback("");
  }

  // Listen for global data refresh event
  document.addEventListener("hr:refresh", () => {
    renderAttendancePanel().catch(() => {});
  });

  // Load/leave lifecycle: the manager portal has no per-view loader, so the
  // setView-dispatched hr:view event drives both directions.
  document.addEventListener("hr:view", (event) => {
    const { view } = event.detail;
    if (view !== "attendance-clock") {
      stopAttendanceClock();
      return;
    }
    startAttendanceClock();
    renderAttendancePanel().catch(() => {
      refreshAttendanceUI();
      setAttendanceFeedback("Không thể tải dữ liệu chấm công. Vui lòng thử lại sau.");
    });
  });

  // The first view may already be active before listeners attach
  // (initHrPortal hashes to #attendance-clock and calls setView synchronously).
  if (document.querySelector('[data-hr-panel="attendance-clock"].active')) {
    startAttendanceClock();
    renderAttendancePanel().catch(() => {
      refreshAttendanceUI();
      setAttendanceFeedback("Không thể tải dữ liệu chấm công. Vui lòng thử lại sau.");
    });
  }
})();
