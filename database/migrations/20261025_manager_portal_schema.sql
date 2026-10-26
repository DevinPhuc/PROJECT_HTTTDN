-- The manager portal employee form collects name, email, position, hire date,
-- status, phone and role only. employees.date_of_birth and gender are NOT NULL
-- in the live schema, which no UI fills when creating an account; relax both so
-- the manager portal can create employee records as designed.
alter table public.employees
  alter column date_of_birth drop not null,
  alter column gender drop not null;
