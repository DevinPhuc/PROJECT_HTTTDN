# Design: Manager attendance tools (clock card + monthly code sheet)

Date: 2026-11-05 — Approved by user in session (both menu approaches, day_code model, full Excel/Print port, OT read-only).

## Intent
Manager portal (`manager/dashboard.html`) gains two menus:

1. **Chấm công** — same clock card as the staff portal (Vào làm / Ra về, today summary, live GMT+7 clock, history table with all/tuần/tháng filters, 10-row pager, same error/feedback copy), for the manager's own attendance.
2. **Bảng chấm công** — monthly code sheet (X/N/CT/P/L/O/KP paint canvas) for every employee in the manager's department: day-number grid, drag-paint, brush palette, search, department filter, "Điền X ngày trống", "Xóa tháng", per-row sums (công làm, phép+lễ, nghỉ KL, công hưởng), 20-row pagination, Excel export (.xlsx), print layout (landscape, legend, 3 signature slots). Recolored to the manager admin palette.

## Chosen approaches
- **Clock card reuses staff-portal edge actions.** Portal tokens (staff and manager) are the same HS256 flavor with `employee_id` inside, so `callPortal("manager", "staff-portal", …)` authenticates the manager as an employee. Zero backend work; exactly the staff logic, palette-swapped. Rejected: re-implementing clock in hr-portal (duplicates behavior owned elsewhere).
- **Sheet stores its code in a new `day_code` column** on `attendance_records` (migration). `day_code` is the sheet's source of truth; `status` stays in sync via fixed map so existing views keep working.
  - Rejected status-mapping-only (O and KP would both collapse to Absent, breaking the sheet's own sums) and read-only sheet (drops the core "chấm" behavior).

## Data rules
- Code → sums (verified from source app): `lv` per code X=1, N=0.5, CT=1, P=0, L=0, O=0, KP=0; `hl` X=1, N=0.5, CT=1, P=1, L=1, O=0, KP=0; `kl` N=0.5, O=1, KP=1, else 0.
  Row columns: công làm = Σlv, phép+lễ = count(P)+count(L), nghỉ KL = Σkl, công hưởng = Σhl.
- Code → status map on save: X/CT→present, N→halfday, P/L→on_leave, O/KP→absent (status enum unchanged; existing triggers keep firing).
- Null `day_code` fallback (staff-clocked rows): present/late→X, halfday→N, on_leave→P, absent→KP. Shortcut: unsigned absences render as KP.
- Painting sets `day_code` + mapped status only — never erases clock timestamps; clearing a cell sets `day_code = NULL`, keeps the row.
- Off days: Sunday only (weekend highlight, skipped by "Điền X", still paintable).

## Parts
- `database/migrations/20261105_attendance_day_code.sql` — add `day_code text` with CHECK.
- `supabase/functions/hr-portal/index.ts` — `attendance_save` accepts/clears optional `day_code` (validated); new `attendance_bulk` action (single transaction) for drag-paint batches; `boot` attendance rows return `day_code`.
- `manager/dashboard.html` — 2 nav items + 2 `hr-view` panels + script tags.
- `manager/js/hr-attendance.js` — port of `staff/js/staff-attendance.js`, adapted to `callPortal("manager", "staff-portal", …)`.
- `manager/js/hr-sheet.js` — sheet logic + minimal xlsx writer + print runner (ported from the source app).
- `manager/css/manager.css` — clock-card styles + `.cc` sheet styles, recolored.

## Non-goals (user decision)
- No monthly OT editing from the sheet: OT column is a **read-only total** (sum of existing per-day `overtime_hours`); the user has separate overtime-attendance logic.
- No payroll coefficient settings, no per-department rest-day config, no mobile layout.
