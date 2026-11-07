# Manager attendance tools Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the staff-style clock card (Chấm công) and the monthly code sheet (Bảng chấm công) to the manager dashboard, with painted codes persisted via a new `day_code` column.

**Architecture:** Clock card calls the existing staff-portal edge actions with the manager token (same HS256 actor model). Sheet reads boot data, paints visually, and persists batches through a new hr-portal `attendance_bulk` action backed by a `day_code` column on `attendance_records`.

**Tech Stack:** Static HTML/CSS/vanilla JS portals, Deno edge functions, postgres.js over Supabase, SQL migrations.

**Spec:** `docs/superpowers/specs/2026-11-05-manager-attendance-design.md`

## Global Constraints
- Browser never touches tables; all writes via edge functions (`callPortal` wrapper).
- `attendance_records.status` enum unchanged: Present/Absent/Late/HalfDay/OnLeave.
- `day_code` CHECK: `('X','N','CT','P','L','O','KP')`.
- Code→status map: X/CT→present, N→halfday, P/L→on_leave, O/KP→absent.
- Sum formulas per spec (lv/hl/kl table). OT column read-only (sum of per-day `overtime_hours`).
- Sunday-only off days; painting never erases clock timestamps; clear = `day_code = NULL`.
- Manager scope is enforced server-side by hr-portal (own department, Admin sees all).

## Review Focus
- Painted month ending up inconsistent with `status` when only one of the two is written → bulk action must write both atomically; test: after painting P, boot row shows day_code P + status OnLeave.
- Clear-cell deleting clock facts → clear sets `day_code = NULL` and keeps row + check_in/out; test: clear a clocked day keeps timestamps.
- `attendance_save` (payroll panel path) with no `day_code` must behave exactly as before (backward compat); test: existing payroll-panel flow still upserts without touching day_code.
- Sheet rendered for rows whose `day_code` is NULL but status is Present/Late (staff-clocked) → renders as X via fallback; verify sums count X×1.
- Month boundary/invalid month strings from the tools must be rejected (`invalid_request`), not corrupt data.

---

### Task 1: Migration + hr-portal storage of `day_code`
**Files:** Create `database/migrations/20261105_attendance_day_code.sql`; modify `supabase/functions/hr-portal/index.ts` (attendance select in boot ~line 335, attendanceSaveAction ~line 700).
**Interfaces:** Produces: `attendance_save` accepts optional `day_code` (string in set, or null/absent = clear-to-NULL; absent keeps behavior: when property missing and row has clocks → leave day_code as-is); new action `attendance_bulk` `{ ym: "YYYY-MM", items: [{employee_id, work_date, day_code|null}] }` → upserts in one transaction returning `{ ok, count }`; boot attendance rows include `day_code`.
Steps: write migration (ALTER TABLE attendance_records ADD COLUMN day_code text CHECK constraint; comment), extend attendanceSaveAction validation + mapping, add bulkSaveAction + route, include day_code in boot select. Verify: `deno check` if available or manual type review; commit.

### Task 2: Manager dashboard wiring (`dashboard.html`)
**Files:** Modify `manager/dashboard.html`.
**Interfaces:** Consumes: nothing new in HTML besides panels; Produces: nav items `data-hr-view="attendance-clock"` and `data-hr-view="attendance-sheet"`, panels `data-hr-panel="attendance-clock"` (markup ported from staff attendance panel, ids prefixed `mgr`) and `data-hr-panel="attendance-sheet"` (`.cc` table host + toolbar), script tags for the two new JS files.
Steps: add nav links, add panels, add scripts, verify hash routing shows both panes; commit.

### Task 3: Clock card (`manager/js/hr-attendance.js`)
**Files:** Create `manager/js/hr-attendance.js`; modify `manager/css/manager.css` (clock card styles, recolored from `staff/css/staff-portal.css`).
**Interfaces:** Consumes: `jewelsPortal.callPortal("manager","staff-portal",{action:"attendance_clock"|"attendance_list"})`; staff logic ported 1:1. Produces: self-initializing `VIEW_MODULES.attendance` equivalent hooked to `data-hr-panel="attendance-clock"` load/leave events, rendering into the Task 2 panel ids.
Steps: port constants/messages/logic (clock, summary, filters, pager, GMT+7 clock), add CSS, wire panel open/open-close lifecycle; verify in browser (clock-in toggles); commit.

### Task 4: Code sheet logic (`manager/js/hr-sheet.js`)
**Files:** Create `manager/js/hr-sheet.js`; modify `manager/css/manager.css` (`.cc` styles + toolbar/legend).
**Interfaces:** Consumes: boot arrays (`employees`, `attendance` incl. `day_code`, `departments`), Task 1 `attendance_bulk`, `callHr`, shared helpers from `hr-current-schema.js` (`feedback`, `dateLabel`, `toast`, `showToast`). Produces: `hrSheet` module with `render()`, month tool, drag-paint, auto-fill, clear-month, pagination, `hrSheet.exportExcel()`, `hrSheet.print()`.
Steps: port CODES + isOff + sum formulas from source app (`C:\Users\Admin\Downloads\Cham_cong_Tinh_luong_ThayDat_V2.html`, CODES ~line 863, vCham ~line 1197), port minimal XL/Print runners, department filter from boot departments, OT read-only, debounce single-call bulk paint on mouseup; verify paint persists and reloads correctly; commit.

### Task 5: End-to-end verification + deploy notes
**Files:** none (verification only).
Steps: apply migration to the project database; deploy hr-portal function; run `manager/dashboard.html`, exercise clock card + sheet (paint, clear, export, print, filters); confirm manager sees only own-department employees; commit any fixups.

## Self-review result
- Spec coverage: every spec part maps to Tasks 1-5. Gap found: none.
- Type consistency: `day_code` used identically in migration, edge fn, boot payload, sheet JS.
- Proportion: plan shorter than spec; code bodies left to implementer except pinned tables/maps.
