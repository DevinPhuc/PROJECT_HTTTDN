-- The manager portal payroll form computes amounts only; it does not collect
-- payment status/method/date. Relax the two NOT NULLs so the UI's insert works.
alter table public.payroll
  alter column payment_method drop not null,
  alter column due_date drop not null;
