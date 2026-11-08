-- Remove overtime/night/consent/notes logic from attendance_records.
-- Dropping each column auto-drops the check constraints and any FK that
-- reference it (overtime_hours caps, ot_consent requirement, ot_approved_by FK).
-- Data loss note: existing OT/night/notes values on attendance rows are removed.
alter table public.attendance_records
  drop column if exists overtime_hours,
  drop column if exists night_hours,
  drop column if exists overtime_type,
  drop column if exists ot_approved_by,
  drop column if exists ot_consent,
  drop column if exists notes;
