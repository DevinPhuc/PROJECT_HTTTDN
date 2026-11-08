// Bảng chấm công (Leader Portal): monthly code sheet X/N/CT/P/L/O/KP
// Đồng bộ giao diện và tính năng hoàn toàn giống Manager,
// Tuân thủ phân quyền: Trưởng nhóm chỉ được sửa cho nhân viên và bản thân, không sửa cho trưởng nhóm khác hoặc quản lý.
(function () {
  const CODES = {
    X: { n: "Đi làm cả ngày", lv: 1, hl: 1, kl: 0, bg: "#dcfce7", c: "#15803d" },
    P: { n: "Nghỉ phép năm", lv: 0, hl: 1, kl: 0, bg: "#dbeafe", c: "#1d4ed8" },
    L: { n: "Nghỉ lễ, Tết", lv: 0, hl: 1, kl: 0, bg: "#ede9fe", c: "#6d28d9" },
    O: { n: "Nghỉ ốm (BHXH trả)", lv: 0, hl: 0, kl: 1, bg: "#fef3c7", c: "#b45309" },
    KP: { n: "Nghỉ không lương", lv: 0, hl: 0, kl: 1, bg: "#fee2e2", c: "#b91c1c" }
  };
  const FALLBACK_BY_STATUS = { present: "X", late: "X", halfday: "N", on_leave: "P", absent: "KP" };
  const DOW_NAMES = ["CN", "T2", "T3", "T4", "T5", "T6", "T7"];
  const PAGE_SIZES = [10, 20, 50, 100, 200];

  let month = "";
  let brush = "X";
  let searchQ = "";
  let painting = false;
  let dirty = false;
  let saving = 0;
  let pg = { page: 0, size: 10 };
  let overlay = null;

  const pad = (n) => String(n).padStart(2, "0");
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const numFmt = (v) => (typeof v === "number" && !Number.isInteger(v) ? v.toFixed(1) : String(v || 0));
  const monthLabel = (ym) => {
    const [y, m] = String(ym || "").split("-");
    return `Tháng ${+m}/${y}`;
  };
  const daysIn = (ym) => {
    const [y, m] = (ym || "").split("-").map(Number);
    return new Date(y, m, 0).getDate();
  };
  const dow = (ym, d) => {
    const [y, m] = (ym || "").split("-").map(Number);
    return new Date(y, m - 1, d).getDay();
  };
  const isoNow = () => {
    const d = new Date();
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  };
  const ymNow = () => isoNow().slice(0, 7);
  const isOff = (ym, d) => dow(ym, d) === 0;

  function cachedCode(row) {
    return row.day_code || FALLBACK_BY_STATUS[String(row.status || "").toLowerCase()] || "";
  }

  function rebuildOverlay() {
    overlay = new Map();
    const prefix = `${month}-`;
    for (const r of attendance || []) {
      const w = String(r.work_date || "").slice(0, 10);
      if (!w.startsWith(prefix)) continue;
      const d = +w.slice(8, 10);
      let perEmp = overlay.get(r.employee_id);
      if (!perEmp) overlay.set(r.employee_id, (perEmp = new Map()));
      const code = cachedCode(r);
      if (code) perEmp.set(d, code);
    }
  }

  function overlayCode(eid, day) {
    return overlay?.get(eid)?.get(day) || "";
  }

  function setOverlayCode(eid, day, code) {
    if (!overlay) overlay = new Map();
    let perEmp = overlay.get(eid);
    if (!perEmp) overlay.set(eid, (perEmp = new Map()));
    if (code) perEmp.set(day, code);
    else perEmp.delete(day);
  }

  function feedback(text, isError = false) {
    const el = document.getElementById("leaderCcFeedback");
    if (!el) return;
    el.textContent = text;
    el.style.color = isError ? "#dc2626" : "#166534";
    clearTimeout(feedback.timer);
    if (text) feedback.timer = setTimeout(() => { el.textContent = ""; }, 4000);
  }

  function isSelfLeader(e) {
    if (!e) return false;
    const currentLeaderId = actor?.employee_id || (window.portal?.getSession("leader")?.user?.employee_id);
    if (currentLeaderId && e.employee_id === currentLeaderId) return true;
    const currentEmail = (actor?.email || window.portal?.getSession("leader")?.user?.email || window.portal?.getSession("leader")?.user?.username || "").trim().toLowerCase();
    if (currentEmail && e.email && e.email.trim().toLowerCase() === currentEmail) return true;
    return false;
  }

  // Phân quyền cho Trưởng nhóm:
  // - Cho phép sửa cho bản thân (tài khoản đang đăng nhập)
  // - Cho phép sửa cho nhân viên
  // - KHÔNG cho phép sửa cho các trưởng nhóm khác hoặc quản lý
  function isLeaderEditable(emp) {
    if (!emp) return false;
    if (isSelfLeader(emp)) return true;

    const roles = (emp.role_names || []).map((r) => String(r).toLowerCase());
    const isOtherLeader = roles.some((r) =>
      r.includes("trưởng nhóm") || r.includes("truong nhom") || r.includes("leader")
    );
    const isManager = roles.some((r) =>
      r.includes("quản lý") || r.includes("quan ly") || r.includes("manager")
    );
    const isAdmin = roles.some((r) => r.includes("admin"));

    const pos = String(emp.position_title || "").toLowerCase();
    const hasLeaderPosition = pos.includes("trưởng nhóm") || pos.includes("truong nhom") || (pos.includes("lead") && !pos.includes("leader"));
    const hasManagerPosition = pos.includes("quản lý") || pos.includes("manager") || pos.includes("trưởng phòng") || pos.includes("giám đốc");

    if (isOtherLeader || isManager || isAdmin || hasLeaderPosition || hasManagerPosition) {
      return false;
    }
    return true;
  }

  function eligibleEmployees() {
    return employees || [];
  }

  function visibleEmployees() {
    const q = searchQ.trim().toLowerCase();
    const filtered = eligibleEmployees().filter((e) =>
      !q || `${e.full_name} ${e.employee_code || ""}`.toLowerCase().includes(q)
    );
    return filtered.sort((a, b) => {
      const aSelf = isSelfLeader(a) ? 0 : 1;
      const bSelf = isSelfLeader(b) ? 0 : 1;
      if (aSelf !== bSelf) return aSelf - bSelf;
      return (a.full_name || "").localeCompare(b.full_name || "", "vi");
    });
  }

  function rowSums(eid) {
    const sums = { lv: 0, hl: 0, kl: 0, P: 0, L: 0, X: 0, N: 0, CT: 0, O: 0, KP: 0 };
    const perEmp = overlay?.get(eid);
    if (perEmp) {
      for (const code of perEmp.values()) {
        const c = CODES[code];
        if (!c) continue;
        sums.lv += c.lv; sums.hl += c.hl; sums.kl += c.kl;
        if (sums[code] !== undefined) sums[code]++;
      }
    }
    return sums;
  }

  function sumsHTML(eid) {
    const s = rowSums(eid);
    return `<td class="cc-sum">${numFmt(s.lv)}</td><td class="cc-sum">${numFmt(s.P + s.L)}</td>`
      + `<td class="cc-sum">${numFmt(s.kl)}</td><td class="cc-sum cc-hl">${numFmt(s.hl)}</td>`;
  }

  /* ---------- Persist to backend ---------- */
  async function persistChanges() {
    if (!overlay) return;
    const items = [];
    const prefix = `${month}-`;
    const oldByEmpDay = new Map();
    for (const r of attendance || []) {
      const w = String(r.work_date || "").slice(0, 10);
      if (!w.startsWith(prefix)) continue;
      const d = +w.slice(8, 10);
      oldByEmpDay.set(`${r.employee_id}:${d}`, cachedCode(r));
    }

    const n = daysIn(month);
    for (const emp of eligibleEmployees()) {
      const eid = emp.employee_id;
      if (!isLeaderEditable(emp)) continue; // Bỏ qua người không được phép sửa
      const perEmp = overlay.get(eid);
      for (let d = 1; d <= n; d++) {
        const cur = perEmp?.get(d) || "";
        const prev = oldByEmpDay.get(`${eid}:${d}`) || "";
        if (cur !== prev) {
          items.push({
            employee_id: eid,
            work_date: `${month}-${pad(d)}`,
            day_code: cur,
          });
        }
      }
    }

    if (!items.length) return;
    saving++;
    feedback("Đang lưu thay đổi...");
    try {
      for (let i = 0; i < items.length; i += 500) {
        const chunk = items.slice(i, i + 500);
        const result = await callLeader({ action: "leader_attendance_bulk", ym: month, items: chunk });
        if (!result.ok) throw new Error(result.message || result.error);
      }
      // Update local attendance
      for (const item of items) {
        let rec = (attendance || []).find((a) => a.employee_id === item.employee_id && String(a.work_date).slice(0, 10) === item.work_date);
        if (rec) {
          if (!item.day_code) {
            attendance = (attendance || []).filter((a) => a !== rec);
          } else {
            rec.day_code = item.day_code;
            rec.status = item.day_code === "X" ? "Present" : ["P", "L"].includes(item.day_code) ? "OnLeave" : "Absent";
          }
        } else if (item.day_code) {
          (attendance = attendance || []).push({
            employee_id: item.employee_id,
            work_date: item.work_date,
            day_code: item.day_code,
            status: item.day_code === "X" ? "Present" : ["P", "L"].includes(item.day_code) ? "OnLeave" : "Absent",
          });
        }
      }
      feedback("Đã lưu chấm công thành công!");
    } catch (err) {
      console.error("Lỗi khi lưu chấm công leader:", err);
      feedback(err.message === "forbidden" ? "Không được phép sửa chấm công của trưởng nhóm khác hoặc quản lý." : "Lỗi khi lưu bảng chấm công.", true);
      rebuildOverlay();
      render();
    } finally {
      saving = Math.max(0, saving - 1);
    }
  }

  /* ---------- Bulk Actions ---------- */
  function fillX() {
    let count = 0;
    const today = isoNow();
    const n = daysIn(month);
    for (const employee of eligibleEmployees()) {
      if (!isLeaderEditable(employee)) continue; // Bỏ qua trưởng nhóm khác
      let perEmp = overlay.get(employee.employee_id);
      if (!perEmp) overlay.set(employee.employee_id, (perEmp = new Map()));
      for (let d = 1; d <= n; d++) {
        if (isOff(month, d) || perEmp.get(d)) continue;
        if (`${month}-${pad(d)}` > today) continue;
        perEmp.set(d, "X");
        count++;
      }
    }
    render();
    feedback(`Đã điền ${count} ô "X" (bỏ qua ngày nghỉ tuần và ngày chưa tới).`);
    persistChanges().then(render);
  }

  function clearMonth() {
    if (!confirm(`Xóa toàn bộ chấm công ${monthLabel(month)} của nhóm?`)) return;
    for (const [eid, perEmp] of overlay) {
      const emp = eligibleEmployees().find((e) => e.employee_id === eid);
      if (!isLeaderEditable(emp)) continue;
      for (const [day, code] of [...perEmp]) {
        if (code) perEmp.set(day, "");
      }
      if (!perEmp.size) overlay.delete(eid);
    }
    render();
    persistChanges().then(render);
  }

  /* ---------- Pager ---------- */
  function pageSlice(list) {
    const pages = Math.max(1, Math.ceil(list.length / pg.size));
    if (pg.page >= pages) pg.page = pages - 1;
    if (pg.page < 0) pg.page = 0;
    return list.slice(pg.page * pg.size, pg.page * pg.size + pg.size);
  }

  function pagerHTML(total) {
    const pages = Math.max(1, Math.ceil(total / pg.size));
    const p = pg.page, from = total ? p * pg.size + 1 : 0, to = Math.min(total, (p + 1) * pg.size);
    const nums = [];
    const add = (i) => nums.push(`<button type="button" class="pg-n ${i === p ? "on" : ""}" data-pg="${i}">${i + 1}</button>`);
    if (pages <= 7) for (let i = 0; i < pages; i++) add(i);
    else {
      add(0);
      const a = Math.max(1, p - 1), b = Math.min(pages - 2, p + 1);
      if (a > 1) nums.push('<span class="pg-dot">…</span>');
      for (let i = a; i <= b; i++) add(i);
      if (b < pages - 2) nums.push('<span class="pg-dot">…</span>');
      add(pages - 1);
    }
    return `<span>Hiển thị <b>${from}-${to}</b> / ${total} dòng</span><span class="pg">Số dòng/trang `
      + `<select data-psize>${PAGE_SIZES.map((s) => `<option ${s === pg.size ? "selected" : ""}>${s}</option>`).join("")}</select>`
      + `<button type="button" class="pg-n" data-pg="${p - 1}" ${p > 0 ? "" : "disabled"}>‹</button>${nums.join("")}`
      + `<button type="button" class="pg-n" data-pg="${p + 1}" ${p < pages - 1 ? "" : "disabled"}>›</button>`
      + `</span>`;
  }

  /* ---------- Palette & Paint ---------- */
  function paletteHTML() {
    return Object.entries(CODES).map(([k, c]) =>
      `<button type="button" class="cc-brush ${brush === k ? "on" : ""}" style="background:${c.bg};color:${c.c}" data-k="${k}">${k} <small>${c.n}</small></button>`
    ).join("")
      + `<button type="button" class="cc-brush ${brush === "" ? "on" : ""}" style="background:#f1f5f9;color:#475569" data-k="">Tẩy <small>xóa ô</small></button>`;
  }

  function paintCell(td) {
    if (!td) return;
    const eid = td.dataset.e, day = +td.dataset.d;
    const emp = eligibleEmployees().find((e) => e.employee_id === eid);
    if (!isLeaderEditable(emp)) return;
    if (overlayCode(eid, day) === brush) return;
    setOverlayCode(eid, day, brush);
    const c = CODES[brush];
    td.textContent = brush;
    td.style.background = c ? c.bg : "";
    td.style.color = c ? c.c : "";
    const tr = td.parentElement;
    if (!tr) return;
    tr.querySelectorAll("td.cc-sum").forEach((x) => x.remove());
    const ot = tr.querySelector("td.cc-ot");
    if (ot) {
      ot.insertAdjacentHTML("beforebegin", sumsHTML(eid));
    } else {
      tr.insertAdjacentHTML("beforeend", sumsHTML(eid));
    }
    dirty = true;
  }

  /* ---------- Render ---------- */
  function render() {
    const ym = month;
    const n = daysIn(ym);
    const today = isoNow();
    const all = visibleEmployees();
    const emps = pageSlice(all);
    const days = Array.from({ length: n }, (_, i) => i + 1);

    const paletteEl = document.getElementById("leaderCcPalette");
    if (paletteEl) paletteEl.innerHTML = paletteHTML();

    const monthInput = document.getElementById("leaderSheetMonthInput");
    if (monthInput && monthInput.value !== ym) monthInput.value = ym;

    const body = document.getElementById("leaderCcBody");
    if (body) {
      body.innerHTML = emps.map((e) => {
        const eid = e.employee_id;
        const editable = isLeaderEditable(e);
        const isSelf = isSelfLeader(e);
        const tag = isSelf ? " (Bạn)" : !editable ? " (Chỉ xem)" : "";
        const deptOrPos = e.department_name || e.position_title || "Nhân viên";
        return `<tr><td class="cc-nm"><b>${esc(e.full_name)}</b><br><small class="cc-muted">${esc(e.employee_code || "")} · ${esc(deptOrPos)}${tag}</small></td>`
          + days.map((d) => {
            const k = overlayCode(eid, d);
            const c = CODES[k];
            return `<td class="cc-d ${isOff(ym, d) ? "we" : ""} ${!editable ? "cc-locked" : ""}" data-e="${eid}" data-d="${d}" ${!editable ? 'title="Chỉ được phép sửa chấm công cho nhân viên và bản thân trưởng nhóm"' : ""} style="${c ? `background:${c.bg};color:${c.c}` : ""}">${k}</td>`;
          }).join("")
          + sumsHTML(eid)
          + `</tr>`;
      }).join("") || `<tr><td class="cc-nm">Chưa có nhân viên</td></tr>`;
    }

    const head = document.getElementById("leaderCcHead");
    if (head) {
      head.innerHTML = `<tr><th class="cc-nm">Nhân viên<br><small style="font-weight:500">${monthLabel(ym)}</small></th>`
        + days.map((d) => `<th class="${`${ym}-${pad(d)}` === today ? "td" : isOff(ym, d) ? "we" : ""}">${d}<br>${DOW_NAMES[dow(ym, d)]}</th>`).join("")
        + "<th>Công<br>làm</th><th>Phép<br>+Lễ</th><th>Nghỉ<br>KL</th><th>Công<br>hưởng</th></tr>";
    }

    const pagerEl = document.getElementById("leaderCcPager");
    if (pagerEl) pagerEl.innerHTML = pagerHTML(all.length);
  }

  /* ---------- Minimal Excel Export ---------- */
  function exportExcel() {
    try {
      const ym = month;
      const n = daysIn(ym);
      const all = visibleEmployees();
      const [y, m] = ym.split("-");
      let csv = `\uFEFFBẢNG CHẤM CÔNG THÁNG ${m}/${y}\n`;
      const headers = ["Mã NV", "Họ và tên", "Chức danh", ...Array.from({ length: n }, (_, i) => String(i + 1)), "Công làm", "Phép + Lễ", "Nghỉ KL", "Công hưởng"];
      csv += headers.map((h) => `"${h}"`).join(",") + "\n";
      for (const e of all) {
        const s = rowSums(e.employee_id);
        const days = Array.from({ length: n }, (_, i) => overlayCode(e.employee_id, i + 1) || "");
        const row = [
          e.employee_code || "",
          e.full_name,
          e.position_title || "Nhân viên",
          ...days,
          numFmt(s.lv),
          numFmt(s.P + s.L),
          numFmt(s.kl),
          numFmt(s.hl)
        ];
        csv += row.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(",") + "\n";
      }
      const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `BangChamCong_Nhom_${ym}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      feedback("Đã xuất file chấm công thành công!");
    } catch (e) {
      console.error(e);
      feedback("Không thể xuất file chấm công.", true);
    }
  }

  function printSheet() {
    window.print();
  }

  /* ---------- Setup Events ---------- */
  function initEvents() {
    const monthInput = document.getElementById("leaderSheetMonthInput");
    if (monthInput) {
      monthInput.addEventListener("change", async (event) => {
        if (!event.target.value) return;
        month = event.target.value;
        if (typeof window.loadTeamData === "function") {
          await window.loadTeamData(month);
        } else {
          rebuildOverlay();
          render();
        }
      });
    }

    const searchInput = document.getElementById("leaderCcSearch");
    if (searchInput) {
      let timer = 0;
      searchInput.addEventListener("input", (event) => {
        clearTimeout(timer);
        searchQ = event.target.value;
        timer = setTimeout(() => { pg.page = 0; render(); }, 200);
      });
    }

    const paletteEl = document.getElementById("leaderCcPalette");
    if (paletteEl) {
      paletteEl.addEventListener("click", (event) => {
        const button = event.target.closest("[data-k]");
        if (!button) return;
        brush = button.dataset.k;
        document.querySelectorAll("#leaderCcPalette .cc-brush").forEach((b) => b.classList.toggle("on", b.dataset.k === brush));
      });
    }

    const grid = document.getElementById("leaderCcBody");
    if (grid) {
      grid.addEventListener("mousedown", (event) => {
        const td = event.target.closest("td.cc-d");
        if (!td || td.classList.contains("cc-locked")) return;
        const emp = eligibleEmployees().find((e) => e.employee_id === td.dataset.e);
        if (!isLeaderEditable(emp)) return;
        event.preventDefault();
        painting = true;
        paintCell(td);
      });
      grid.addEventListener("mouseover", (event) => {
        if (!painting) return;
        const td = event.target.closest("td.cc-d");
        if (td && !td.classList.contains("cc-locked")) {
          const emp = eligibleEmployees().find((e) => e.employee_id === td.dataset.e);
          if (isLeaderEditable(emp)) paintCell(td);
        }
      });
    }

    document.addEventListener("mouseup", () => {
      if (!painting) return;
      painting = false;
      if (dirty) { dirty = false; persistChanges().then(render); }
    });

    const fillXBtn = document.getElementById("leaderCcFillX");
    if (fillXBtn) fillXBtn.addEventListener("click", fillX);

    const clearMonthBtn = document.getElementById("leaderCcClearMonth");
    if (clearMonthBtn) clearMonthBtn.addEventListener("click", clearMonth);

    const excelBtn = document.getElementById("leaderCcExcel");
    if (excelBtn) excelBtn.addEventListener("click", exportExcel);

    const printBtn = document.getElementById("leaderCcPrint");
    if (printBtn) printBtn.addEventListener("click", printSheet);

    const pagerEl = document.getElementById("leaderCcPager");
    if (pagerEl) {
      pagerEl.addEventListener("click", (event) => {
        const button = event.target.closest("[data-pg]");
        if (!button || button.disabled) return;
        pg.page = Number(button.dataset.pg);
        render();
      });
      pagerEl.addEventListener("change", (event) => {
        const select = event.target.closest("[data-psize]");
        if (!select) return;
        pg.size = Number(select.value);
        pg.page = 0;
        render();
      });
    }
  }

  function reload() {
    month = currentMonth || month || ymNow();
    rebuildOverlay();
    render();
  }

  // Expose API
  window.leaderSheet = {
    reload,
    render,
  };

  document.addEventListener("DOMContentLoaded", () => {
    initEvents();
    if (currentMonth) reload();
  });

  /* ---------- Realtime Two-Way Sync with Manager & other clients ---------- */
  if (window.sb) {
    let syncTimer = null;
    try {
      window.sb
        .channel("leader-attendance-realtime-sync")
        .on(
          "postgres_changes",
          { event: "*", schema: "public", table: "attendance_records" },
          () => {
            if (saving > 0) return;
            clearTimeout(syncTimer);
            syncTimer = setTimeout(() => {
              if (saving > 0) return;
              if (typeof window.loadTeamData === "function") {
                window.loadTeamData(month).catch(() => {});
              }
            }, 400);
          }
        )
        .subscribe();
    } catch (e) {
      console.warn("Leader realtime attendance subscription failed:", e);
    }
  }

  // Refresh when switching back to this window tab if on attendance-sheet
  window.addEventListener("focus", () => {
    const panel = document.getElementById("attendance-sheet");
    if (panel && !panel.hidden && saving === 0) {
      if (typeof window.loadTeamData === "function") {
        window.loadTeamData(month).catch(() => {});
      }
    }
  });
})();
