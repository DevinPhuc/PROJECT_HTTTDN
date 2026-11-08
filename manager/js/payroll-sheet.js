// Bảng lương (manager portal).
// Port của màn hình "Bảng lương" trong Cham_cong_Tinh_luong_ThayDat_V2.html.
// Dữ liệu: dùng các biến toàn cục của hr-current-schema.js (employees, departments,
// payrollCache, attendanceCache, requests, contacts, callHr...). Nạp file này TRƯỚC
// hr-current-schema.js; mọi biến toàn cục chỉ được đọc lúc chạy, không đọc lúc nạp.
// Lưu: dùng hr-portal / payroll_save sẵn có (không đổi schema). Các cột DB không có
// (thưởng, tạm ứng, khấu trừ khác, lương đóng BH riêng, PC chịu/không chịu thuế, số NPT)
// đã được bỏ khỏi bảng.
(() => {
  "use strict";

  /* ---------- Thiết lập tính lương (sửa ở đây khi luật đổi) ---------- */
  const CFG = {
    congChuan: 26, gioCong: 8, heSoOT: 1.5,
    luongCoSo: 2530000, ltVung: 5310000,
    bhxhNLD: 8, bhytNLD: 1.5, bhtnNLD: 1,
    bhxhDN: 17.5, bhytDN: 3, bhtnDN: 1, kpcdDN: 2,
    gtBanThan: 15500000,
    bac: [
      { den: 10000000, ts: 5 }, { den: 30000000, ts: 10 }, { den: 60000000, ts: 20 },
      { den: 100000000, ts: 30 }, { den: 0, ts: 35 },
    ],
    company: { ten: "Jewels", diaChi: "", sdt: "", mst: "" },
  };
  const PAGE_SIZES = [10, 20, 50, 100];

  /* ---------- Helpers ---------- */
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const round = (n) => Math.round(+n || 0);
  const sum = (list, f) => list.reduce((s, x) => s + (+(f ? f(x) : x) || 0), 0);
  const fmt = (n) => round(n).toLocaleString("vi-VN");
  const num = (n, d = 1) => (+n || 0).toLocaleString("vi-VN", { maximumFractionDigits: d });
  const short = (n) => {
    n = +n || 0; const a = Math.abs(n);
    const f = (v, u) => (Math.abs(v) >= 100 ? Math.round(v) : Math.round(v * 10) / 10).toLocaleString("vi-VN") + u;
    return a >= 1e9 ? f(n / 1e9, " tỷ") : a >= 1e6 ? f(n / 1e6, " tr") : a >= 1e3 ? f(n / 1e3, "k") : String(round(n));
  };
  const d10 = (v) => String(v ?? "").slice(0, 10);
  const fmtDate = (v) => { const s = d10(v); if (!s) return "-"; const [y, m, d] = s.split("-"); return d ? `${d}/${m}/${y}` : s; };
  const monthLabel = (ym) => { const [y, m] = ym.split("-"); return `Tháng ${+m}/${y}`; };
  const initials = (name) => { const p = String(name || "?").trim().split(/\s+/); return ((p.length > 1 ? p[p.length - 2][0] : "") + p[p.length - 1][0]).toUpperCase(); };
  const parseMoney = (v) => { const s = String(v ?? "").replace(/[^\d]/g, ""); return s ? parseInt(s, 10) : 0; };
  const $ = (id) => document.getElementById(id);

  function vnToday() {
    const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Ho_Chi_Minh", year: "numeric", month: "2-digit", day: "2-digit",
    }).formatToParts(new Date()).map(({ type, value }) => [type, value]));
    return `${p.year}-${p.month}-${p.day}`;
  }
  // Luôn mặc định là tháng hiện tại theo hệ thống (múi giờ Việt Nam).
  function defaultMonth() {
    const t = vnToday();
    return t.slice(0, 7);
  }

  function docSo(n) {
    n = Math.round(Math.abs(+n || 0));
    if (!n) return "Không đồng";
    const c = ["không", "một", "hai", "ba", "bốn", "năm", "sáu", "bảy", "tám", "chín"];
    const u = ["", " nghìn", " triệu", " tỷ", " nghìn tỷ", " triệu tỷ"];
    const r3 = (x, full) => {
      const t = Math.floor(x / 100), ch = Math.floor(x % 100 / 10), d = x % 10; let s = "";
      if (full || t > 0) s += c[t] + " trăm";
      if (ch > 1) { s += " " + c[ch] + " mươi"; if (d === 1) s += " mốt"; else if (d === 5) s += " lăm"; else if (d === 4) s += " tư"; else if (d > 0) s += " " + c[d]; }
      else if (ch === 1) { s += " mười"; if (d === 5) s += " lăm"; else if (d > 0) s += " " + c[d]; }
      else if (d > 0) { if (full || t > 0) s += " lẻ"; s += " " + c[d]; }
      return s.trim();
    };
    const g = []; let t = n; while (t > 0) { g.push(t % 1000); t = Math.floor(t / 1000); }
    const out = [];
    for (let i = g.length - 1; i >= 0; i--) { if (g[i] === 0) continue; out.push(r3(g[i], i !== g.length - 1) + u[i]); }
    const s = out.join(" ").replace(/\s+/g, " ").trim();
    return s.charAt(0).toUpperCase() + s.slice(1) + " đồng";
  }

  /* ---------- Công thức (khớp bản mẫu) ---------- */
  function taxOf(tn) {
    let t = 0, prev = 0;
    for (const b of CFG.bac) {
      const top = +b.den || Infinity;
      if (tn <= prev) break;
      t += (Math.min(tn, top) - prev) * (+b.ts || 0) / 100;
      prev = top;
    }
    return Math.round(t);
  }
  function bhOf(base, nld = true) {
    const bx = Math.min(base, 20 * CFG.luongCoSo), bt = Math.min(base, 20 * CFG.ltVung);
    if (nld) return { bhxh: round(bx * CFG.bhxhNLD / 100), bhyt: round(bx * CFG.bhytNLD / 100), bhtn: round(bt * CFG.bhtnNLD / 100) };
    return { bhxh: round(bx * CFG.bhxhDN / 100), bhyt: round(bx * CFG.bhytDN / 100), bhtn: round(bt * CFG.bhtnDN / 100), kpcd: round(bx * CFG.kpcdDN / 100) };
  }

  // Gom dữ liệu của một kỳ lương một lần: chấm công, đơn phép năm đã duyệt, bản ghi lương đã lưu.
  function buildCtx(ym) {
    const [y, m] = ym.split("-").map(Number);
    const recs = new Map(), leaves = new Map(), pay = new Map(), sums = new Map();
    for (const r of attendanceCache) {
      if (d10(r.work_date).slice(0, 7) !== ym) continue;
      if (!recs.has(r.employee_id)) recs.set(r.employee_id, []);
      recs.get(r.employee_id).push(r);
    }
    for (const r of requests) {
      if (r.status !== "approved" || r.leave_type !== "annual") continue;
      if (!leaves.has(r.employee_id)) leaves.set(r.employee_id, []);
      leaves.get(r.employee_id).push([d10(r.start_date), d10(r.end_date || r.start_date)]);
    }
    for (const r of payrollCache) {
      if (Number(r.pay_year) === y && Number(r.pay_month) === m) pay.set(r.employee_id, r);
    }
    return { ym, y, m, recs, leaves, pay, sums };
  }

  // present/late = 1 công; absent = nghỉ KL;
  // on_leave = công hưởng lương nếu nằm trong đơn phép năm đã duyệt, ngược lại nghỉ KL.
  function summarize(ctx, id) {
    if (ctx.sums.has(id)) return ctx.sums.get(id);
    const o = { hl: 0, lv: 0, kl: 0, phep: 0, ot: 0, has: false };
    const leaves = ctx.leaves.get(id) || [];
    for (const r of ctx.recs.get(id) || []) {
      o.has = true;
      const day = d10(r.work_date);
      switch (String(r.status).toLowerCase()) {
        case "present": case "late": o.lv += 1; o.hl += 1; break;
        case "absent": o.kl += 1; break;
        case "on_leave":
          if (leaves.some(([a, b]) => a <= day && day <= b)) { o.hl += 1; o.phep += 1; } else o.kl += 1;
          break;
        default: break;
      }
    }
    ctx.sums.set(id, o);
    return o;
  }

  function calcPay(e, ctx, over = {}) {
    const id = e.employee_id, rec = ctx.pay.get(id), a = summarize(ctx, id);
    const cc = Number(rec?.standard_days) > 0 ? Number(rec.standard_days) : CFG.congChuan;
    const luongCB = over.base ?? (Number(rec?.base_salary) || 0);
    const pc = over.pc ?? (Number(rec?.allowance) || 0);
    const cong = a.has ? a.hl : (Number(rec?.work_days) || 0);
    const luongNgay = luongCB / cc, luongGio = luongNgay / CFG.gioCong;
    const luongCong = round(luongNgay * cong);
    const tienOT = round(luongGio * a.ot * CFG.heSoOT);
    const otMien = round(luongGio * a.ot * Math.max(0, CFG.heSoOT - 1));
    const gross = luongCong + pc + tienOT;
    // Dưới 14 ngày công hưởng lương trong tháng (nghỉ KL ≥14 hoặc giữa kỳ chưa đủ công) → tháng này không đóng BH.
    const noBH = !luongCB || a.kl >= 14 || a.hl < 14;
    const b = noBH ? { bhxh: 0, bhyt: 0, bhtn: 0 } : bhOf(luongCB, true);
    const bd = noBH ? { bhxh: 0, bhyt: 0, bhtn: 0, kpcd: 0 } : bhOf(luongCB, false);
    const bhNLD = b.bhxh + b.bhyt + b.bhtn, bhDN = bd.bhxh + bd.bhyt + bd.bhtn + bd.kpcd;
    const tnChiuThue = Math.max(0, gross - otMien), giamTru = CFG.gtBanThan;
    const tnTinhThue = Math.max(0, tnChiuThue - bhNLD - giamTru), thue = taxOf(tnTinhThue);
    const thucLinh = gross - bhNLD - thue;
    return {
      id, e, rec, ma: e.employee_code || "", ten: e.full_name || "",
      phongBan: departmentName(e), chucVu: positionName(e),
      luongCB, luongBH: luongCB, cc, cong, lv: a.lv, kl: a.kl, phep: a.phep, ot: a.ot,
      luongCong, pc, tienOT, otMien, gross, ...b, bhNLD, bhDN,
      bdxh: bd.bhxh, bdyt: bd.bhyt, bdtn: bd.bhtn, kpcd: bd.kpcd, noBH,
      tnChiuThue, giamTru, tnTinhThue, thue, thucLinh,
    };
  }

  /* ---------- Trạng thái ---------- */
  const st = { ym: "", dept: "", q: "", page: 0, size: 10, bound: false, chain: Promise.resolve() };

  function allRows(ctx) {
    const end = ctx.ym + "-31";
    return employees
      .filter((e) => (!e.hire_date || d10(e.hire_date) <= end)
        && (normalizedStatus(e.employment_status) !== "resigned" || ctx.recs.has(e.employee_id) || ctx.pay.has(e.employee_id)))
      .map((e) => calcPay(e, ctx));
  }
  function list() {
    const q = st.q.trim().toLowerCase();
    const ctx = buildCtx(st.ym);
    return allRows(ctx).filter((x) => (!st.dept || x.e.department_id === st.dept)
      && (!q || `${x.ten} ${x.ma} ${x.phongBan}`.toLowerCase().includes(q)));
  }

  /* ---------- Cột bảng ---------- */
  const COLS = [
    { k: "ma", l: "Mã NV", t: "text" }, { k: "ten", l: "Họ và tên", t: "text" }, { k: "phongBan", l: "Phòng ban", t: "text" },
    { k: "luongCB", l: "Lương cơ bản", t: "money", g: "Thu nhập", input: 1 },
    { k: "cong", l: "Công hưởng lương", t: "num", g: "Thu nhập" },
    { k: "luongCong", l: "Lương theo công", t: "money", g: "Thu nhập" },
    { k: "pc", l: "Phụ cấp", t: "money", g: "Thu nhập", input: 1 },
    { k: "gross", l: "Tổng thu nhập", t: "money", g: "Thu nhập", b: 1 },
    { k: "luongBH", l: "Lương đóng BH", t: "money", g: "Bảo hiểm NLĐ" },
    { k: "bhxh", l: "BHXH", t: "money", g: "Bảo hiểm NLĐ" },
    { k: "bhyt", l: "BHYT", t: "money", g: "Bảo hiểm NLĐ" },
    { k: "bhtn", l: "BHTN", t: "money", g: "Bảo hiểm NLĐ" },
    { k: "tnChiuThue", l: "TN chịu thuế", t: "money", g: "Thuế TNCN" },
    { k: "tnTinhThue", l: "TN tính thuế", t: "money", g: "Thuế TNCN" },
    { k: "thue", l: "Thuế TNCN", t: "money", g: "Thuế TNCN", b: 1 },
    { k: "thucLinh", l: "THỰC LĨNH", t: "money", b: 1 },
  ];
  const isSumCol = (c) => (c.t === "money" && !["luongCB", "luongBH"].includes(c.k)) || c.k === "cong";

  const ICON_SEARCH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>';
  const ICON_RECEIPT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 3h14v18l-3-2-2 2-2-2-2 2-2-2-3 2z"/><path d="M9 8h6M9 12h6"/></svg>';

  /* ---------- Giao diện ---------- */
  function pagerHTML(total) {
    const pages = Math.max(1, Math.ceil(total / st.size)), p = st.page;
    const from = total ? p * st.size + 1 : 0, to = Math.min(total, (p + 1) * st.size);
    const nums = [], add = (i) => nums.push(`<button type="button" class="pl-pgn ${i === p ? "on" : ""}" data-pg="${i}">${i + 1}</button>`);
    if (pages <= 7) for (let i = 0; i < pages; i++) add(i);
    else {
      add(0);
      const a = Math.max(1, p - 1), b = Math.min(pages - 2, p + 1);
      if (a > 1) nums.push('<span class="pl-dot">…</span>');
      for (let i = a; i <= b; i++) add(i);
      if (b < pages - 2) nums.push('<span class="pl-dot">…</span>');
      add(pages - 1);
    }
    return `<span>Hiển thị <b>${from}-${to}</b> / ${total} dòng · dòng Tổng cộng tính cho tất cả</span>
      <span class="pl-pg">Số dòng/trang <select class="pl-inp sm" data-psize>${PAGE_SIZES.map((s) => `<option ${s === st.size ? "selected" : ""}>${s}</option>`).join("")}</select>
      ${pages > 1 ? `<button type="button" class="pl-pgn" data-pg="${p - 1}" ${p ? "" : "disabled"}>‹</button>${nums.join("")}<button type="button" class="pl-pgn" data-pg="${p + 1}" ${p < pages - 1 ? "" : "disabled"}>›</button>` : ""}</span>`;
  }

  function draw() {
    const w = $("plW"); if (!w) return;
    const L = list();
    const pages = Math.max(1, Math.ceil(L.length / st.size));
    if (st.page >= pages) st.page = pages - 1;
    if (st.page < 0) st.page = 0;
    const off = st.page * st.size, V = L.slice(off, off + st.size);
    $("plP").innerHTML = pagerHTML(L.length);

    const LEFT = [0, 44, 116], WID = [44, 72];
    const sk = (i, extra = "") => i <= 2
      ? ` class="stk ${extra}" style="left:${LEFT[i]}px;${i < 2 ? `min-width:${WID[i]}px;max-width:${WID[i]}px;` : "min-width:170px;"}${i === 2 ? "box-shadow:inset -1px 0 0 #dfe7e5" : ""}"`
      : (extra ? ` class="${extra}"` : "");
    const fmtv = (c, v) => (c.t === "num" ? num(v) : c.t === "text" ? esc(v) : fmt(v));
    const al = (c) => (c.t !== "text" ? "r" : "");

    let r1 = `<th${sk(0, "c")} rowspan="2">STT</th>`, r2 = "";
    COLS.forEach((c, i) => {
      if (!c.g) r1 += `<th${sk(i + 1, al(c))} rowspan="2">${c.l}</th>`;
      else {
        if (!i || COLS[i - 1].g !== c.g) r1 += `<th class="grp" colspan="${COLS.filter((x) => x.g === c.g).length}">${c.g}</th>`;
        r2 += `<th class="${al(c)}" style="top:33px">${c.l}</th>`;
      }
    });

    const body = V.map((x, ri) => `<tr><td${sk(0, "c")}>${off + ri + 1}</td>${COLS.map((c, i) => (c.input
      ? `<td class="in"><input data-k="${c.k}" data-e="${esc(x.id)}" value="${x[c.k] ? fmt(x[c.k]) : ""}" data-money inputmode="numeric" placeholder="0" aria-label="${c.l}: ${esc(x.ten)}"></td>`
      : `<td${sk(i + 1, al(c) + (c.k === "thucLinh" ? " net" : ""))}>${c.k === "ten" ? `<b>${esc(x.ten)}</b>` : c.b ? `<b>${fmtv(c, x[c.k])}</b>` : fmtv(c, x[c.k])}${c.k === "luongBH" && x.noBH && x.luongBH ? ' <span class="pl-badge" title="Dưới 14 ngày công hưởng lương trong tháng: tháng này không đóng BH">!</span>' : ""}</td>`)).join("")}<td class="act"><button type="button" class="pl-ibtn" data-act="slip" data-id="${esc(x.id)}" title="In phiếu lương" aria-label="In phiếu lương ${esc(x.ten)}">${ICON_RECEIPT}</button></td></tr>`).join("")
      || '<tr><td colspan="30"><div class="pl-empty">Không có nhân viên trong kỳ này</div></td></tr>';

    const foot = L.length
      ? `<tfoot><tr><td${sk(0)}></td>${COLS.map((c, i) => `<td${sk(i + 1, al(c))}>${i === 1 ? "TỔNG CỘNG" : isSumCol(c) ? (c.t === "num" ? num(sum(L, (x) => x[c.k])) : fmt(sum(L, (x) => x[c.k]))) : ""}</td>`).join("")}<td></td></tr></tfoot>`
      : "";

    w.innerHTML = `<table class="pl-tbl"><thead><tr style="height:33px">${r1}<th rowspan="2"></th></tr><tr>${r2}</tr></thead><tbody>${body}</tbody>${foot}</table>`;
  }

  // Vẽ lại nhưng giữ vị trí cuộn và ô đang nhập (sau khi sửa một ô).
  function keepFocus() {
    setTimeout(() => {
      const a = document.activeElement;
      const key = a && a.dataset && a.dataset.k ? `[data-k="${a.dataset.k}"][data-e="${a.dataset.e}"]` : null;
      const w = $("plW"), sl = w ? w.scrollLeft : 0, stp = w ? w.scrollTop : 0;
      draw();
      const w2 = $("plW"); if (w2) { w2.scrollLeft = sl; w2.scrollTop = stp; }
      if (key) { const n = document.querySelector(key); if (n) { n.focus(); n.select && n.select(); } }
    });
  }

  function feedbackMsg(message, error = false) {
    const el = $("plFeedback"); if (!el) return;
    el.textContent = message;
    el.classList.toggle("is-error", error);
  }

  function render() {
    const root = $("plSheet"); if (!root) return;
    if (!st.ym) st.ym = defaultMonth();
    const month = $("plMonth"); if (month) month.value = st.ym;
    const deptOptions = [`<option value="">Tất cả phòng ban</option>`]
      .concat(departments.map((d) => `<option value="${esc(d.department_id)}" ${d.department_id === st.dept ? "selected" : ""}>${esc(d.department_name)}</option>`)).join("");
    root.innerHTML = `<div class="pl-card">
      <div class="pl-tools">
        <div class="pl-search">${ICON_SEARCH}<input class="pl-inp" id="plQ" type="search" placeholder="Tìm nhân viên..." value="${esc(st.q)}"></div>
        <select class="pl-inp" id="plDept" aria-label="Lọc phòng ban">${deptOptions}</select>
        <span class="pl-grow"></span>
        <span class="pl-small">Biểu thuế ${CFG.bac.length} bậc · ô vàng nhập trực tiếp</span>
      </div>
      <div class="pl-wrap" id="plW"></div>
      <div class="pl-pager" id="plP"></div>
    </div>
    <p id="plFeedback" class="pl-feedback" role="status" aria-live="polite"></p>`;
    draw();
    bindOnce();
  }

  /* ---------- Lưu ---------- */
  function cacheShape(x, base = {}) {
    return {
      ...base, employee_id: x.id, pay_year: Number(st.ym.slice(0, 4)), pay_month: Number(st.ym.slice(5, 7)),
      base_salary: x.luongCB, allowance: x.pc, total_deductions: x.bhNLD + x.thue, overtime_pay: x.tienOT,
      work_days: x.cong, standard_days: x.cc, insurance_amount: x.bhNLD, personal_income_tax: x.thue,
      gross_salary: x.gross, net_salary: x.thucLinh,
    };
  }
  function payload(x) {
    return {
      action: "payroll_save", employee_id: x.id, pay_year: Number(st.ym.slice(0, 4)), pay_month: Number(st.ym.slice(5, 7)),
      base_salary: x.luongCB, allowance: x.pc, overtime_pay: x.tienOT, work_days: x.cong, standard_days: x.cc,
      insurance_amount: x.bhNLD, personal_income_tax: x.thue, total_deductions: x.bhNLD + x.thue,
      gross_salary: x.gross, net_salary: x.thucLinh,
    };
  }
  function putCache(x) {
    const y = Number(st.ym.slice(0, 4)), m = Number(st.ym.slice(5, 7));
    const idx = payrollCache.findIndex((r) => r.employee_id === x.id && Number(r.pay_year) === y && Number(r.pay_month) === m);
    const prev = idx >= 0 ? payrollCache[idx] : null;
    const next = cacheShape(x, prev || {});
    if (idx >= 0) payrollCache[idx] = next; else payrollCache.push(next);
    return () => { // hoàn tác
      const i = payrollCache.indexOf(next);
      if (i < 0) return;
      if (prev) payrollCache[i] = prev; else payrollCache.splice(i, 1);
    };
  }
  const ERR = {
    invalid_amounts: "Số tiền không hợp lệ (thực nhận phải ≥ 0 và ≤ tổng thu nhập).",
    forbidden: "Bạn không có quyền lưu lương cho nhân sự này.",
    invalid_period: "Kỳ lương không hợp lệ.",
  };
  let payrollToastTimer = null;
  function showPayrollToast(msg) {
    const toast = $("payrollToast") || $("successToast");
    if (!toast) return;
    const span = toast.querySelector("span");
    if (span) span.textContent = msg;
    toast.classList.add("show");
    clearTimeout(payrollToastTimer);
    payrollToastTimer = setTimeout(() => toast.classList.remove("show"), 5000);
  }

  function enqueueSave(x, undo, label, savedAmount) {
    st.chain = st.chain.then(async () => {
      try {
        const res = await callHr(payload(x));
        if (!res.ok) { undo(); feedbackMsg(ERR[res.error] || `Không lưu được lương của ${label}.`, true); keepFocus(); return false; }
        const amountVal = savedAmount != null ? savedAmount : (x.luongCB || 0);
        const amountText = (amountVal ? fmt(amountVal) : "0") + " đ";
        const msg = `Đã lưu lương ${amountText} cho nhân viên ${label} thành công!`;
        feedbackMsg(msg);
        showPayrollToast(msg);
        return true;
      } catch {
        undo(); feedbackMsg("Không kết nối được máy chủ. Lương chưa được lưu.", true); keepFocus(); return false;
      }
    });
    return st.chain;
  }

  function onEdit(input) {
    const id = input.dataset.e, key = input.dataset.k;
    const e = employees.find((item) => item.employee_id === id); if (!e) return;
    const ctx = buildCtx(st.ym), cur = calcPay(e, ctx);
    const val = parseMoney(input.value);
    if (val === (key === "luongCB" ? cur.luongCB : cur.pc)) { keepFocus(); return; }
    const next = calcPay(e, ctx, key === "luongCB" ? { base: val } : { pc: val });
    if (next.thucLinh < 0) {
      feedbackMsg("Thực lĩnh âm: kiểm tra lương cơ bản, phụ cấp và ngày công.", true);
      keepFocus(); return;
    }
    const undo = putCache(next);
    keepFocus();
    enqueueSave(next, undo, next.ten, val);
  }

  async function saveAll() {
    const button = $("plSaveAll");
    const ctx = buildCtx(st.ym);
    const L = allRows(ctx).filter((x) => x.luongCB > 0 && x.thucLinh >= 0);
    if (!L.length) { feedbackMsg("Chưa có nhân sự nào có lương cơ bản để lưu.", true); return; }
    if (button) button.disabled = true;
    let ok = 0;
    for (let i = 0; i < L.length; i++) {
      feedbackMsg(`Đang lưu ${i + 1}/${L.length}...`);
      try {
        const res = await callHr(payload(L[i]));
        if (res.ok) { putCache(L[i]); ok += 1; }
      } catch { /* tiếp tục với dòng sau */ }
    }
    if (button) button.disabled = false;
    const allMsg = `Đã lưu lương cho ${ok} nhân viên thành công!`;
    feedbackMsg(allMsg, ok !== L.length);
    if (ok > 0) showPayrollToast(allMsg);
    draw();
  }

  /* ---------- In phiếu lương ---------- */
  function printHTML(html, title) {
    document.querySelectorAll("#pl-print-root,#pl-print-page").forEach((n) => n.remove());
    const root = document.createElement("div"); root.id = "pl-print-root"; root.innerHTML = html; document.body.appendChild(root);
    const style = document.createElement("style"); style.id = "pl-print-page";
    style.textContent = "@page{size:A4 portrait;margin:11mm 10mm}"; document.head.appendChild(style);
    document.body.classList.add("pl-printing");
    const t0 = document.title; if (title) document.title = title;
    const done = () => {
      document.body.classList.remove("pl-printing"); root.remove(); style.remove(); document.title = t0;
      window.removeEventListener("afterprint", done);
    };
    window.addEventListener("afterprint", done);
    setTimeout(() => {
      window.print();
      setTimeout(() => { if (document.body.classList.contains("pl-printing")) done(); }, 800);
    }, 120);
  }

  function slipHTML(x) {
    const e = x.e, c = CFG.company, [y, mo] = st.ym.split("-"), now = new Date();
    const mn = (v) => (v ? fmt(v) : "-");
    const kv = (l, v) => `<div><span>${l}</span><b>${v}</b></div>`;
    const row = (stt, label, dg, v) => `<tr><td class="c">${stt}</td><td>${label}</td><td class="dg">${dg || ""}</td><td class="r">${mn(v)}</td></tr>`;
    const ded = x.bhNLD + x.thue;
    const bhNote = (p, cap) => (x.noBH ? "Tháng này không đóng (dưới 14 ngày công hưởng lương)" : `${p}% × ${fmt(Math.min(x.luongBH, cap))}`);
    const phone = (contacts.get(x.id) || {}).phone_number || "-";
    const att = [["Công chuẩn", x.cc], ["Công làm thực tế", num(x.lv)], ["Nghỉ phép có lương", num(x.phep)], ["Nghỉ không lương", num(x.kl)], ["Giờ làm thêm", num(x.ot)], ["Công hưởng lương", num(x.cong), 1]]
      .map(([l, v, hl]) => `<div class="${hl ? "hl" : ""}"><b>${v}</b><span>${l}</span></div>`).join("");
    return `<div class="ps">
      <div class="ps-top"><div class="ps-co"><div><b>${esc(c.ten)}</b>${c.diaChi ? `<div class="l">${esc(c.diaChi)}</div>` : ""}${[c.sdt ? "ĐT: " + esc(c.sdt) : "", c.mst ? "MST: " + esc(c.mst) : ""].filter(Boolean).length ? `<div class="l">${[c.sdt ? "ĐT: " + esc(c.sdt) : "", c.mst ? "MST: " + esc(c.mst) : ""].filter(Boolean).join(" · ")}</div>` : ""}</div></div>
        <div class="ps-tt"><h1>PHIẾU LƯƠNG</h1><div>Kỳ lương: <b>Tháng ${+mo}/${y}</b></div><div>Số phiếu: <b>PL${y}${mo}-${esc(x.ma)}</b></div></div></div>
      <div class="ps-band"></div>
      <div class="ps-emp"><div class="ps-av">${esc(initials(x.ten))}</div><div class="ps-eg">${kv("Họ và tên", esc(x.ten))}${kv("Mã nhân viên", esc(x.ma))}${kv("Phòng ban", esc(x.phongBan))}${kv("Chức vụ", esc(x.chucVu))}${kv("Ngày vào làm", fmtDate(e.hire_date))}${kv("Email", esc(e.email || "-"))}${kv("Điện thoại", esc(phone))}${kv("Lương đóng BH", fmt(x.luongBH))}</div></div>
      <div class="ps-att">${att}</div>
      <table class="ps-t"><thead><tr><th style="width:38px">STT</th><th style="text-align:left">Khoản mục</th><th style="text-align:left">Diễn giải</th><th style="width:130px;text-align:right">Số tiền (đ)</th></tr></thead><tbody>
        <tr class="sec"><td colspan="4">A. CÁC KHOẢN THU NHẬP</td></tr>
        ${row(1, "Lương theo ngày công", `${fmt(x.luongCB)} ÷ ${x.cc} công × ${num(x.cong)} công`, x.luongCong)}
        ${row(2, "Phụ cấp", "", x.pc)}
        ${row(3, "Tiền làm thêm giờ", x.ot ? `${num(x.ot)} giờ × hệ số ${String(CFG.heSoOT).replace(".", ",")}` : "", x.tienOT)}
        <tr class="sub"><td></td><td colspan="2">Tổng thu nhập (A)</td><td class="r">${fmt(x.gross)}</td></tr>
        <tr class="sec"><td colspan="4">B. CÁC KHOẢN KHẤU TRỪ</td></tr>
        ${row(1, "Bảo hiểm xã hội", bhNote(CFG.bhxhNLD, 20 * CFG.luongCoSo), x.bhxh)}${row(2, "Bảo hiểm y tế", bhNote(CFG.bhytNLD, 20 * CFG.luongCoSo), x.bhyt)}${row(3, "Bảo hiểm thất nghiệp", bhNote(CFG.bhtnNLD, 20 * CFG.ltVung), x.bhtn)}
        ${row(4, "Thuế thu nhập cá nhân", x.thue ? "Theo biểu thuế lũy tiến từng phần" : "Chưa đến mức phải nộp", x.thue)}
        <tr class="sub"><td></td><td colspan="2">Tổng khấu trừ (B)</td><td class="r">${fmt(ded)}</td></tr></tbody></table>
      <div class="ps-net"><div><span>THỰC LĨNH (A - B)</span><small>Bằng chữ: ${docSo(x.thucLinh)}</small></div><b>${fmt(x.thucLinh)} đ</b></div>
      <div class="ps-2">
        <div class="ps-box"><h4>Cách tính thuế TNCN</h4>${kv("Thu nhập chịu thuế", fmt(x.tnChiuThue))}${kv("Giảm trừ bản thân", "- " + fmt(x.giamTru))}${kv("Bảo hiểm bắt buộc", "- " + fmt(x.bhNLD))}${kv("Thu nhập tính thuế", fmt(x.tnTinhThue))}${kv("Thuế TNCN phải nộp", fmt(x.thue))}</div>
        <div class="ps-box"><h4>Phần doanh nghiệp đóng (không trừ vào lương)</h4>${kv(`BHXH (${CFG.bhxhDN}%)`, fmt(x.bdxh))}${kv(`BHYT (${CFG.bhytDN}%)`, fmt(x.bdyt))}${kv(`BHTN (${CFG.bhtnDN}%)`, fmt(x.bdtn))}${kv(`Kinh phí công đoàn (${CFG.kpcdDN}%)`, fmt(x.kpcd))}${kv("Tổng doanh nghiệp đóng", fmt(x.bhDN))}</div>
      </div>
      <div class="ps-pay">Hình thức nhận lương: <b>${esc((x.rec && x.rec.payment_method) || "Chưa cập nhật")}</b></div>
      <div class="ps-date">Ngày ${now.getDate()} tháng ${now.getMonth() + 1} năm ${now.getFullYear()}</div>
      <div class="ps-sign"><div><b>Người lập phiếu</b><i>(Ký, ghi rõ họ tên)</i><div class="sp"></div></div><div><b>Kế toán trưởng</b><i>(Ký, ghi rõ họ tên)</i><div class="sp"></div></div><div><b>Người nhận lương</b><i>(Ký, ghi rõ họ tên)</i><div class="sp"></div></div></div>
      <div class="ps-foot">Phiếu lương là thông tin cá nhân, vui lòng không chia sẻ. Có thắc mắc xin phản hồi phòng Nhân sự trong vòng 03 ngày kể từ ngày nhận phiếu.</div>
    </div>`;
  }

  function printSlip(id) {
    const e = employees.find((item) => item.employee_id === id); if (!e) return;
    const x = calcPay(e, buildCtx(st.ym));
    printHTML(`<div class="pr">${slipHTML(x)}</div>`, `Phieu luong ${x.ma} ${st.ym}`);
  }
  function printAllSlips() {
    const L = list();
    if (!L.length) { feedbackMsg("Không có nhân viên để in phiếu lương.", true); return; }
    printHTML(`<div class="pr">${L.map(slipHTML).join("")}</div>`, `Phieu luong ${st.ym}`);
  }

  /* ---------- Sự kiện (gắn một lần) ---------- */
  function bindOnce() {
    if (st.bound) return;
    const root = $("plSheet"); if (!root) return;
    st.bound = true;

    root.addEventListener("click", (ev) => {
      const pg = ev.target.closest("[data-pg]");
      if (pg && !pg.disabled) { st.page = +pg.dataset.pg; draw(); return; }
      const slip = ev.target.closest('[data-act="slip"]');
      if (slip) printSlip(slip.dataset.id);
    });
    root.addEventListener("change", (ev) => {
      const t = ev.target;
      if (t.matches("[data-psize]")) { st.size = +t.value; st.page = 0; draw(); }
      else if (t.id === "plDept") { st.dept = t.value; st.page = 0; draw(); }
      else if (t.matches("input[data-k]")) onEdit(t);
    });
    root.addEventListener("input", (ev) => {
      const t = ev.target;
      if (t.id === "plQ") { st.q = t.value; st.page = 0; draw(); }
      else if (t.matches("[data-money]")) {
        const digits = t.value.replace(/[^\d]/g, "");
        t.value = digits ? Number(digits).toLocaleString("vi-VN") : "";
      }
    });
    root.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" && ev.target.matches("input[data-k]")) ev.target.blur();
    });

    const month = $("plMonth");
    if (month) month.addEventListener("change", () => {
      if (!month.value) return;
      st.ym = month.value; st.page = 0; feedbackMsg(""); draw();
    });
    const slipAll = $("plSlipAll"); if (slipAll) slipAll.addEventListener("click", printAllSlips);
    const saveBtn = $("plSaveAll"); if (saveBtn) saveBtn.addEventListener("click", () => saveAll().catch(() => feedbackMsg("Không thể lưu bảng lương.", true)));
  }

  window.PayrollSheet = { render, draw };
})();