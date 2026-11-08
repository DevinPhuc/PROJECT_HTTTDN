-- Move phone_number and address from employee_contacts into employees,
-- then drop the employee_contacts table.

alter table if exists public.employees
  add column if not exists phone_number varchar(20),
  add column if not exists address text;

do $$
begin
  if exists (select 1 from information_schema.tables where table_schema = 'public' and table_name = 'employee_contacts') then
    update public.employees e
    set phone_number = c.phone_number,
        address = c.address
    from public.employee_contacts c
    where e.employee_id = c.employee_id;

    drop table if exists public.employee_contacts cascade;
  end if;
end $$;
