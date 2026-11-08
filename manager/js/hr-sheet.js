// Bảng chấm công (manager): monthly code sheet X/N/CT/P/L/O/KP, ported from
// the standalone chấm công app. Codes persist through hr-portal
// attendance_bulk into attendance_records.day_code; day_code is the source
// of truth, status stays synced server-side.
(function () {
  const CODES = {
    X: { n: "Đi làm cả ngày", lv: 1, hl: 1, kl: 0, bg: "#dcfce7", c: "#15803d" },
    P: { n: "Nghỉ phép năm", lv: 0, hl: 1, kl: 0, bg: "#dbeafe", c: "#1d4ed8" },
    L: { n: "Nghỉ lễ, Tết", lv: 0, hl: 1, kl: 0, bg: "#ede9fe", c: "#6d28d9" },
    O: { n: "Nghỉ ốm (BHXH trả)", lv: 0, hl: 0, kl: 1, bg: "#fef3c7", c: "#b45309" },
    KP: { n: "Nghỉ không lương", lv: 0, hl: 0, kl: 1, bg: "#fee2e2", c: "#b91c1c" }
  };
  // Staff-clocked rows have no painted code; derive one for display and sums.
  // shortcut: unsigned absences render as KP — upgrade when absences get typed rows.
  const FALLBACK_BY_STATUS = { present: "X", late: "X", halfday: "N", on_leave: "P", absent: "KP" };
  const STATUS_BY_CODE = { X: "present", CT: "present", N: "halfday", P: "on_leave", L: "on_leave", O: "absent", KP: "absent" };
  const DOW_NAMES = ["CN", "T2", "T3", "T4", "T5", "T6", "T7"];
  const PAGE_SIZES = [10, 20, 50, 100, 200];

  let month = "";
  let brush = "X";
  let searchQ = "";
  let deptId = "";
  let painting = false;
  let dirty = false;
  let saving = 0;
  let pg = { page: 0, size: 10 };
  // In-memory painted overlay: Map employee_id → Map dayNumber → code | "" (clear).
  let overlay = null;

  const pad = (n) => String(n).padStart(2, "0");
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const numFmt = (v) => (typeof v === "number" && !Number.isInteger(v) ? v.toFixed(1) : String(v || 0));
  const monthLabel = (ym) => {
    const [y, m] = String(ym).split("-");
    return `Tháng ${+m}/${y}`;
  };
  const daysIn = (ym) => {
    const [y, m] = ym.split("-").map(Number);
    return new Date(y, m, 0).getDate();
  };
  const dow = (ym, d) => {
    const [y, m] = ym.split("-").map(Number);
    return new Date(y, m - 1, d).getDay();
  };
  const isoNow = () => {
    const d = new Date();
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  };
  const ymNow = () => isoNow().slice(0, 7);
  const isOff = (ym, d) => dow(ym, d) === 0; // Sunday only
  const departmentNameOf = (employee) =>
    departments.find((d) => d.department_id === employee.department_id)?.department_name || "-";
  // Only Manager of dept "Nhân sự" (actor.is_hr) sees every department; other managers stay in their own.
  const canSeeAllDepts = () => Boolean(currentActor?.is_hr);
  const ownDeptId = () => String(currentActor?.department_id ?? "");

  /* ---------- Data: boot cache → overlay ---------- */
  function cachedCode(row) {
    return row.day_code || FALLBACK_BY_STATUS[String(row.status || "").toLowerCase()] || "";
  }

  function rowsForMonth(ym) {
    return attendanceCache.filter((row) => String(row.work_date || "").slice(0, 7) === ym);
  }

  function baseCodes(ym) {
    const map = new Map();
    for (const row of rowsForMonth(ym)) {
      const day = Number(String(row.work_date).slice(8, 10));
      if (!Number.isFinite(day)) continue;
      let perEmp = map.get(row.employee_id);
      if (!perEmp) map.set(row.employee_id, (perEmp = new Map()));
      perEmp.set(day, cachedCode(row));
    }
    return map;
  }

  function rebuildOverlay() {
    overlay = new Map(baseCodes(month));
    for (const [eid, perEmp] of overlay) {
      if (!perEmp.size) overlay.delete(eid);
    }
  }

  function overlayCode(eid, day) {
    return overlay?.get(eid)?.get(day) || "";
  }

  function setOverlayCode(eid, day, code) {
    let perEmp = overlay.get(eid);
    if (!perEmp) overlay.set(eid, (perEmp = new Map()));
    perEmp.set(day, code);
  }

  function rowSums(eid) {
    const sums = { lv: 0, hl: 0, kl: 0, P: 0, L: 0 };
    const perEmp = overlay.get(eid);
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

  /* ---------- Eligible employees (mirrors source app rules) ---------- */
  // Admin role holders never appear on the code sheet (any viewer, any dept).
  function isAdminHolder(eid) {
    const adminIds = roles.filter((r) => String(r.role_name || "").toLowerCase() === "admin").map((r) => r.role_id);
    return (roleAssignments.get(eid) || []).some((id) => adminIds.includes(id));
  }

  function eligibleEmployees() {
    const end = `${month}-31`;
    return employees.filter((e) =>
      !isAdminHolder(e.employee_id)
      && (!e.hire_date || e.hire_date <= end)
      && (String(e.employment_status || "").toLowerCase() !== "resigned" || overlayHasAny(e.employee_id))
      && (canSeeAllDepts()
        ? (!deptId || String(e.department_id) === deptId)
        : (e.employee_id === currentActor?.employee_id || (ownDeptId() !== "" && String(e.department_id) === ownDeptId()))));
  }

  function overlayHasAny(eid) {
    const perEmp = overlay.get(eid);
    if (!perEmp) return false;
    for (const code of perEmp.values()) if (code) return true;
    return false;
  }

  function visibleEmployees() {
    const q = searchQ.trim().toLowerCase();
    return eligibleEmployees().filter((e) =>
      !q || `${e.full_name} ${e.employee_code}`.toLowerCase().includes(q));
  }

  /* ---------- Persist ---------- */
  async function persistChanges() {
    const items = [];
    const base = baseCodes(month);
    for (const [eid, perEmp] of overlay) {
      const baseEmp = base.get(eid);
      for (const [day, code] of perEmp) {
        if ((baseEmp?.get(day) || "") === code) continue;
        items.push({ employee_id: eid, work_date: `${month}-${pad(day)}`, day_code: code || "" });
      }
    }
    if (!items.length) return;

    saving++;
    let savedCount = 0;
    try {
      // Server rejects payloads over ~1200 items; send the diff in safe batches.
      let lastError = "";
      for (let i = 0; i < items.length; i += 1000) {
        const chunk = items.slice(i, i + 1000);
        const result = await callHr({ action: "attendance_bulk", ym: month, items: chunk });
        if (!result.ok) {
          lastError = result.error;
          break;
        }
        applyToCache(chunk); // success: apply the diff so future diffs stay empty
        savedCount += chunk.length;
      }
      if (lastError) {
        feedback("mgrCcFeedback", lastError === "forbidden"
          ? "Bạn không có quyền chấm công cho một số nhân sự trong danh sách."
          : "Không lưu được bảng chấm công. Kiểm tra kết nối rồi thử lại.", true);
        rebuildOverlay();
        render();
        return;
      }
      feedback("mgrCcFeedback", `Đã lưu ${savedCount} ngày chấm công.`);
    } catch {
      feedback("mgrCcFeedback", "Không lưu được bảng chấm công.", true);
      rebuildOverlay();
      render();
    } finally {
      saving--;
    }
  }

  function applyToCache(items) {
    let changed = false;
    for (const item of items) {
      const row = attendanceCache.find((r) => r.employee_id === item.employee_id && r.work_date === item.work_date);
      if (row) {
        row.day_code = item.day_code || null;
      } else if (item.day_code) {
        attendanceCache.push({
          employee_id: item.employee_id,
          work_date: item.work_date,
          status: STATUS_BY_CODE[item.day_code] || null,
          day_code: item.day_code
        });
      }
      changed = true;
    }
    return changed;
  }

  /* ---------- Actions ---------- */
  function fillX() {
    let count = 0;
    const today = isoNow();
    for (const employee of eligibleEmployees()) {
      let perEmp = overlay.get(employee.employee_id);
      if (!perEmp) overlay.set(employee.employee_id, (perEmp = new Map()));
      for (let d = 1; d <= daysIn(month); d++) {
        if (isOff(month, d) || perEmp.get(d)) continue;
        if (`${month}-${pad(d)}` > today) continue; // not there yet (covers future months)
        perEmp.set(d, "X");
        count++;
      }
    }
    render();
    feedback("mgrCcFeedback", `Đã điền ${count} ô "X" (bỏ qua ngày nghỉ tuần và ngày chưa tới).`);
    persistChanges().then(render);
  }

  function clearMonth() {
    const scope = canSeeAllDepts() ? (deptId ? ` của phòng ban đã chọn` : "") : ` của phòng ban bạn quản lý`;
    const inScope = new Set(eligibleEmployees().map((e) => e.employee_id));
    if (!confirm(`Xóa toàn bộ chấm công ${monthLabel(month)}${scope}?`)) return;
    for (const [eid, perEmp] of overlay) {
      if (!inScope.has(eid)) continue; // only the filtered department(s)
      for (const [day, code] of [...perEmp]) {
        if (code) perEmp.set(day, ""); // clear cell = delete the row (bug fix)
      }
      if (!perEmp.size) overlay.delete(eid);
    }
    render();
    persistChanges().then(render);
  }

  /* ---------- Pager (ported pgState/pageSlice/pagerHTML/bindPager) ---------- */
  function pageSlice(list) {
    const pages = Math.max(1, Math.ceil(list.length / pg.size));
    if (pg.page >= pages) pg.page = pages - 1;
    if (pg.page < 0) pg.page = 0;
    return list.slice(pg.page * pg.size, pg.page * pg.size + pg.size);
  }

  let pagerRedraw = () => {};
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
      + `<select data-psize style="width:auto">${PAGE_SIZES.map((s) => `<option ${s === pg.size ? "selected" : ""}>${s}</option>`).join("")}</select>`
      + (pages > 1 ? `<button type="button" class="pg-n" data-pg="${p - 1}" ${p ? "" : "disabled"}>‹</button>${nums.join("")}`
        + `<button type="button" class="pg-n" data-pg="${p + 1}" ${p < pages - 1 ? "" : "disabled"}>›</button>` : "")
      + `</span>`;
  }

  /* ---------- Render ---------- */
  function paletteHTML() {
    return Object.entries(CODES).map(([k, c]) =>
      `<button type="button" class="cc-brush ${brush === k ? "on" : ""}" style="background:${c.bg};color:${c.c}" data-k="${k}">${k} <small>${c.n}</small></button>`
    ).join("")
      + `<button type="button" class="cc-brush ${brush === "" ? "on" : ""}" style="background:#f1f5f9;color:#475569" data-k="">Tẩy <small>xóa ô</small></button>`;
  }

  function paintCell(td) {
    const eid = td.dataset.e, day = +td.dataset.d;
    if (overlayCode(eid, day) === brush) return;
    setOverlayCode(eid, day, brush);
    const c = CODES[brush];
    td.textContent = brush;
    td.style.background = c ? c.bg : "";
    td.style.color = c ? c.c : "";
    const tr = td.parentElement;
    tr.querySelectorAll("td.cc-sum").forEach((x) => x.remove());
    tr.querySelector("td.cc-ot").insertAdjacentHTML("beforebegin", sumsHTML(eid));
    dirty = true;
  }

  function sumsHTML(eid) {
    const s = rowSums(eid);
    return `<td class="cc-sum">${numFmt(s.lv)}</td><td class="cc-sum">${numFmt(s.P + s.L)}</td>`
      + `<td class="cc-sum">${numFmt(s.kl)}</td><td class="cc-sum cc-hl">${numFmt(s.hl)}</td>`;
  }

  function render() {
    const ym = month;
    const n = daysIn(ym);
    const today = isoNow();
    const all = visibleEmployees();
    const emps = pageSlice(all);
    const days = Array.from({ length: n }, (_, i) => i + 1);

    document.getElementById("mgrCcPalette").innerHTML = paletteHTML();
    document.getElementById("mgrSheetMonth").value = ym;
    const deptSel = document.getElementById("mgrCcDept");
    if (canSeeAllDepts()) {
      deptSel.style.display = "";
      deptSel.innerHTML = `<option value="">Tất cả phòng ban</option>`
        + departments.map((d) => `<option value="${esc(d.department_id)}" ${d.department_id === deptId ? "selected" : ""}>${esc(d.department_name)}</option>`).join("");
    } else {
      deptId = "";
      deptSel.innerHTML = "";
      deptSel.style.display = "none";
    }

    const body = document.getElementById("mgrCcBody");
    body.innerHTML = emps.map((e) => {
      const eid = e.employee_id;
      return `<tr><td class="cc-nm"><b>${esc(e.full_name)}</b><br><small class="cc-muted">${esc(e.employee_code || "")} · ${esc(departmentNameOf(e))}</small></td>`
        + days.map((d) => {
          const k = overlayCode(eid, d);
          const c = CODES[k];
          return `<td class="cc-d ${isOff(ym, d) ? "we" : ""}" data-e="${eid}" data-d="${d}" style="${c ? `background:${c.bg};color:${c.c}` : ""}">${k}</td>`;
        }).join("")
        + sumsHTML(eid)
        + `</tr>`;
    }).join("") || `<tr><td class="cc-nm">Chưa có nhân viên</td></tr>`;

    const head = document.getElementById("mgrCcHead");
    head.innerHTML = `<tr><th class="cc-nm">Nhân viên<br><small style="font-weight:500">${monthLabel(ym)}</small></th>`
      + days.map((d) => `<th class="${`${ym}-${pad(d)}` === today ? "td" : isOff(ym, d) ? "we" : ""}">${d}<br>${DOW_NAMES[dow(ym, d)]}</th>`).join("")
      + "<th>Công<br>làm</th><th>Phép<br>+Lễ</th><th>Nghỉ<br>KL</th><th>Công<br>hưởng</th></tr>";

    document.getElementById("mgrCcPager").innerHTML = pagerHTML(all.length);
  }

  /* ---------- Excel export (minimal xlsx writer, recolored) ---------- */
  const XL = (() => {
    const T = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; T[n] = c >>> 0; }
    const crc = (b) => { let c = 0xFFFFFFFF; for (let i = 0; i < b.length; i++) c = T[(c ^ b[i]) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
    const encoder = new TextEncoder();
    function zip(files) {
      const parts = [], cd = []; let off = 0;
      const now = new Date();
      const dt = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
      const tm = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
      for (const f of files) {
        const name = encoder.encode(f.name), data = encoder.encode(f.data), cr = crc(data);
        const h = new DataView(new ArrayBuffer(30));
        h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true); h.setUint16(10, tm, true); h.setUint16(12, dt, true);
        h.setUint32(14, cr, true); h.setUint32(18, data.length, true); h.setUint32(22, data.length, true); h.setUint16(26, name.length, true);
        parts.push(new Uint8Array(h.buffer), name, data);
        const c = new DataView(new ArrayBuffer(46));
        c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true); c.setUint16(12, tm, true); c.setUint16(14, dt, true);
        c.setUint32(16, cr, true); c.setUint32(20, data.length, true); c.setUint32(24, data.length, true); c.setUint16(28, name.length, true); c.setUint32(42, off, true);
        cd.push(new Uint8Array(c.buffer), name); off += 30 + name.length + data.length;
      }
      const cdSize = cd.reduce((s, a) => s + a.length, 0);
      const e = new DataView(new ArrayBuffer(22));
      e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true); e.setUint32(12, cdSize, true); e.setUint32(16, off, true);
      return new Blob([...parts, ...cd, new Uint8Array(e.buffer)], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    }
    const x = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");
    const col = (i) => { let s = ""; i++; while (i > 0) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; };
    // Kiểu ô: 1 tiêu đề cột, 2 chữ, 5 tiêu đề lớn, 8 tổng chữ, 9 dòng phụ, 10 số lẻ, 11 chữ giữa, 12 tổng số lẻ
    const ST = { text: 2, num: 10, center: 11 };
    const styles = () => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="2"><numFmt numFmtId="164" formatCode="#,##0"/><numFmt numFmtId="167" formatCode="#,##0.0"/></numFmts><fonts count="5"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="15"/><color rgb="FF244336"/><name val="Calibri"/></font><font><i/><sz val="10"/><color rgb="FF6B726B"/><name val="Calibri"/></font></fonts><fills count="4"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF345B4A"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFE9F1EB"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left style="thin"><color rgb="FFDFE5DF"/></left><right style="thin"><color rgb="FFDFE5DF"/></right><top style="thin"><color rgb="FFDFE5DF"/></top><bottom style="thin"><color rgb="FFDFE5DF"/></bottom><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="13"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf><xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment vertical="center"/></xf><xf numFmtId="164" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1"/><xf numFmtId="164" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1"/><xf numFmtId="0" fontId="3" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment vertical="center"/></xf><xf numFmtId="164" fontId="2" fillId="3" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1"/><xf numFmtId="0" fontId="3" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment vertical="center"/></xf><xf numFmtId="0" fontId="2" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1"/><xf numFmtId="0" fontId="4" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="167" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1"/><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf><xf numFmtId="167" fontId="2" fillId="3" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1"/></cellXfs></styleSheet>`;
    function cell(ref, v, type, s) {
      if (v === null || v === undefined || v === "") return `<c r="${ref}" s="${s}"/>`;
      if (type === "num") return `<c r="${ref}" s="${s}"><v>${+v || 0}</v></c>`;
      return `<c r="${ref}" s="${s}" t="inlineStr"><is><t xml:space="preserve">${x(v)}</t></is></c>`;
    }
    function sheetXML(sh) {
      const cols = sh.columns, last = col(cols.length - 1);
      let r = 0; const rows = [], merges = [];
      if (sh.title) { r++; rows.push(`<row r="${r}" ht="24" customHeight="1">${cell("A" + r, sh.title, "text", 5)}</row>`); merges.push(`A${r}:${last}${r}`); }
      (sh.subtitles || []).filter(Boolean).forEach((t) => { r++; rows.push(`<row r="${r}">${cell("A" + r, t, "text", 9)}</row>`); merges.push(`A${r}:${last}${r}`); });
      if (r) r++;
      r++; const hr = r;
      rows.push(`<row r="${r}" ht="32" customHeight="1">${cols.map((c, i) => cell(col(i) + r, c.label, "text", 1)).join("")}</row>`);
      for (const row of sh.rows) {
        r++;
        rows.push(`<row r="${r}">${cols.map((c, i) => { const t = c.type || "text"; return cell(col(i) + r, row[i], t, ST[t] || 2); }).join("")}</row>`);
      }
      const lastData = r;
      if (sh.totals && sh.rows.length) {
        r++;
        rows.push(`<row r="${r}">${cols.map((c, i) => {
          const ref = col(i) + r;
          if (c.sum) return `<c r="${ref}" s="${c.type === "num" ? 12 : 6}"><f>SUBTOTAL(9,${col(i)}${hr + 1}:${col(i)}${lastData})</f><v>${sh.rows.reduce((s, row) => s + (+row[i] || 0), 0)}</v></c>`;
          return cell(ref, i === 0 ? "TỔNG CỘNG" : "", "text", 8);
        }).join("")}</row>`);
      }
      if ((sh.footer || []).length) r++;
      (sh.footer || []).forEach((t) => { r++; rows.push(`<row r="${r}">${cell("A" + r, t, "text", 9)}</row>`); });
      const fc = sh.freezeCols || 0;
      const pane = fc ? `<pane xSplit="${fc}" ySplit="${hr}" topLeftCell="${col(fc)}${hr + 1}" activePane="bottomRight" state="frozen"/>`
        : `<pane ySplit="${hr}" topLeftCell="A${hr + 1}" activePane="bottomLeft" state="frozen"/>`;
      return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetPr><pageSetUpPr fitToPage="1"/></sheetPr><dimension ref="A1:${last}${Math.max(r, 1)}"/><sheetViews><sheetView workbookViewId="0">${pane}</sheetView></sheetViews><sheetFormatPr defaultRowHeight="15"/><cols>${cols.map((c, i) => `<col min="${i + 1}" max="${i + 1}" width="${c.width || 18}" customWidth="1"/>`).join("")}</cols><sheetData>${rows.join("")}</sheetData>${sh.rows.length && !sh.noFilter ? `<autoFilter ref="A${hr}:${last}${lastData}"/>` : ""}${merges.length ? `<mergeCells count="${merges.length}">${merges.map((m) => `<mergeCell ref="${m}"/>`).join("")}</mergeCells>` : ""}<pageMargins left="0.4" right="0.4" top="0.5" bottom="0.5" header="0.3" footer="0.3"/><pageSetup paperSize="9" orientation="landscape" fitToWidth="1" fitToHeight="0"/></worksheet>`;
    }
    function build(sheets) {
      const used = {};
      const names = sheets.map((s) => {
        const n = String(s.name || "Sheet").replace(/[\[\]:*?\/\\]/g, " ").slice(0, 31) || "Sheet";
        let k = n, i = 2;
        while (used[k.toLowerCase()]) k = `${n.slice(0, 28)} ${i++}`;
        used[k.toLowerCase()] = 1;
        return k;
      });
      const H = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
      return zip([
        { name: "[Content_Types].xml", data: `${H}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}</Types>` },
        { name: "_rels/.rels", data: `${H}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>` },
        { name: "xl/workbook.xml", data: `${H}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${names.map((n, i) => `<sheet name="${x(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets></workbook>` },
        { name: "xl/_rels/workbook.xml.rels", data: `${H}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("")}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>` },
        { name: "xl/styles.xml", data: styles() },
        ...sheets.map((s, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: sheetXML(s) }))
      ]);
    }
    function download(blob, name) {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob); a.download = name;
      document.body.appendChild(a); a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
    }
    function save(fileName, sheets) {
      download(build(sheets), `${fileName.replace(/\.xlsx$/i, "")}.xlsx`);
    }
    return { save };
  })();

  function legend() {
    return `Ký hiệu: ${Object.entries(CODES).map(([k, c]) => `${k} = ${c.n}`).join(" · ")}`;
  }

  function exportColumns() {
    const n = daysIn(month);
    return [
      { label: "Mã NV", width: 9 },
      { label: "Họ và tên", width: 24 },
      { label: "Phòng ban", width: 14 },
      ...Array.from({ length: n }, (_, i) => ({ label: `${i + 1}\n${DOW_NAMES[dow(month, i + 1)]}`, type: "center", width: 4.3 })),
      { label: "Công làm", type: "num", sum: true, width: 8 },
      { label: "Phép + Lễ", type: "num", sum: true, width: 8 },
      { label: "Nghỉ KL", type: "num", sum: true, width: 8 },
      { label: "Công hưởng", type: "num", sum: true, width: 9 }
    ];
  }

  function exportRows() {
    const n = daysIn(month);
    return eligibleEmployees().map((e) => {
      const eid = e.employee_id;
      const s = rowSums(eid);
      return [
        e.employee_code || "", e.full_name, departmentNameOf(e),
        ...Array.from({ length: n }, (_, i) => overlayCode(eid, i + 1)),
        +(s.lv.toFixed(1)), s.P + s.L, +(s.kl.toFixed(1)), +(s.hl.toFixed(1))
      ];
    });
  }

  function exportExcel() {
    XL.save(`Bang cham cong ${month}`, [{
      name: `Chấm công ${month}`,
      title: `BẢNG CHẤM CÔNG ${monthLabel(month).toUpperCase()}`,
      subtitles: ["Ngày xuất: " + isoNow()],
      columns: exportColumns(),
      rows: exportRows(),
      totals: true,
      freezeCols: 2,
      footer: [legend()]
    }]);
    feedback("mgrCcFeedback", "Đã xuất file Excel.");
  }

  /* ---------- Print (landscape, legend, signature slots) ---------- */
  function printSheet() {
    const ym = month, n = daysIn(month);
    const cols = exportColumns();
    const rows = exportRows();
    const head = `<tr>${cols.map((c) => `<th style="padding:3px 2px;font-size:9px">${esc(c.label).replace("\n", "<br>")}</th>`).join("")}</tr>`;
    const body = rows.map((r) => `<tr>${r.map((v, i) => {
      const c = CODES[v];
      return `<td class="${i > 2 ? "c" : ""}" style="padding:3px 2px;font-size:9.5px;${c && i > 2 && i < 3 + n ? `background:${c.bg};color:${c.c};font-weight:700` : ""}">${typeof v === "number" ? numFmt(v) : esc(v)}</td>`;
    }).join("")}</tr>`).join("");
    const signs = (list) => {
      const d = new Date();
      return `<div style="text-align:right;margin-top:16px;font-style:italic">Ngày ${d.getDate()} tháng ${d.getMonth() + 1} năm ${d.getFullYear()}</div>`
        + `<div class="pr-signs">${list.map((s) => `<div><b>${esc(s)}</b><i>(Ký, ghi rõ họ tên)</i><div class="sp"></div></div>`).join("")}</div>`;
    };
    runPrint(`<div class="pr"><h2>Bảng chấm công ${monthLabel(ym)}</h2><table><thead>${head}</thead><tbody>${body}</tbody></table>`
      + `<div class="pr-note">${legend()}</div>${signs(["Người chấm công", "Phụ trách bộ phận", "Giám đốc"])}</div>`, { landscape: true, title: `Bang cham cong ${ym}` });
  }

  function runPrint(html, { landscape = false, title } = {}) {
    document.querySelectorAll("#print-root,#print-page").forEach((n) => n.remove());
    const root = document.createElement("div");
    root.id = "print-root"; root.dataset.runtime = "1"; root.innerHTML = html;
    document.body.appendChild(root);
    const st = document.createElement("style");
    st.id = "print-page"; st.dataset.runtime = "1";
    st.textContent = `@page{size:A4 ${landscape ? "landscape" : "portrait"};margin:11mm 10mm}`;
    document.head.appendChild(st);
    document.body.classList.add("is-printing");
    const t0 = document.title; if (title) document.title = title;
    const done = () => {
      document.body.classList.remove("is-printing");
      document.title = t0;
      window.removeEventListener("afterprint", done);
      const styleEl = document.getElementById("print-page");
      const rootEl = document.getElementById("print-root");
      if (rootEl) rootEl.remove();
      if (styleEl) styleEl.remove();
    };
    window.addEventListener("afterprint", done);
    setTimeout(() => { window.print(); setTimeout(() => { if (document.body.classList.contains("is-printing")) done(); }, 800); }, 120);
  }

  /* ---------- Static listeners (bound once) ---------- */
  document.getElementById("mgrSheetMonth").addEventListener("change", (event) => {
    month = event.target.value || month;
    pg.page = 0;
    rebuildOverlay();
    render();
  });

  let searchTimer = 0;
  document.getElementById("mgrCcSearch").addEventListener("input", (event) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      searchQ = event.target.value;
      pg.page = 0;
      render();
      const input = document.getElementById("mgrCcSearch");
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    }, 300);
  });

  document.getElementById("mgrCcDept").addEventListener("change", (event) => {
    deptId = event.target.value;
    pg.page = 0;
    render();
  });

  document.getElementById("mgrCcPalette").addEventListener("click", (event) => {
    const button = event.target.closest("[data-k]");
    if (!button) return;
    brush = button.dataset.k;
    document.querySelectorAll("#mgrCcPalette .cc-brush").forEach((b) => b.classList.toggle("on", b.dataset.k === brush));
  });

  const grid = document.getElementById("mgrCcBody");
  grid.addEventListener("mousedown", (event) => {
    const td = event.target.closest("td.cc-d");
    if (!td) return;
    event.preventDefault();
    painting = true;
    paintCell(td);
  });
  grid.addEventListener("mouseover", (event) => {
    if (!painting) return;
    const td = event.target.closest("td.cc-d");
    if (td) paintCell(td);
  });
  document.addEventListener("mouseup", () => {
    if (!painting) return;
    painting = false;
    if (dirty) { dirty = false; persistChanges().then(render); }
  });

  document.getElementById("mgrCcFillX").addEventListener("click", fillX);
  document.getElementById("mgrCcClearMonth").addEventListener("click", clearMonth);
  document.getElementById("mgrCcExcel").addEventListener("click", exportExcel);
  document.getElementById("mgrCcPrint").addEventListener("click", printSheet);
  document.getElementById("mgrCcPager").addEventListener("click", (event) => {
    const button = event.target.closest("[data-pg]");
    if (!button || button.disabled) return;
    pg.page = Number(button.dataset.pg);
    render();
  });
  document.getElementById("mgrCcPager").addEventListener("change", (event) => {
    const select = event.target.closest("[data-psize]");
    if (!select) return;
    pg.size = Number(select.value);
    pg.page = 0;
    render();
  });

  /* ---------- Lifecycle ---------- */
  const load = () => {
    month = month || ymNow(); // default: current system month
    rebuildOverlay();
    render();
  };
  document.addEventListener("hr:view", (event) => {
    if (event.detail.view === "attendance-sheet") load();
  });
  document.addEventListener("hr:refresh", () => {
    rebuildOverlay();
    render();
  });
  // Direct-hash loads: setView fires after async boot, but cover the rare
  // already-active case synchronously.
  if (document.querySelector('[data-hr-panel="attendance-sheet"].active')) load();
})();