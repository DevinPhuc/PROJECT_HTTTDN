create table if not exists public.hr_employment_status_history (
  status_history_id bigint generated always as identity primary key,
  employee_id uuid not null references public.employees(employee_id) on delete cascade,
  employment_status text not null
    check (employment_status in ('active', 'on_leave', 'resigned')),
  is_baseline boolean not null default false,
  effective_from date not null,
  effective_to date,
  changed_by uuid references public.employees(employee_id) on delete set null,
  reason text,
  created_at timestamptz not null default now(),
  check (effective_to is null or effective_to >= effective_from)
);

alter table public.hr_employment_status_history
  add column if not exists is_baseline boolean not null default false;

create index if not exists hr_employment_status_history_employee_dates_idx
  on public.hr_employment_status_history(employee_id, effective_from desc);

alter table public.hr_employment_status_history enable row level security;

update public.hr_employment_status_history
set is_baseline = true
where changed_by is null
  and reason = 'Trạng thái ban đầu khi khởi tạo lịch sử'
  and is_baseline is false;

insert into public.hr_employment_status_history
  (employee_id, employment_status, is_baseline, effective_from, reason)
select
  e.employee_id,
  case
    when lower(e.employment_status::text) in ('onleave', 'on_leave', 'on leave', 'đang nghỉ phép')
      then 'on_leave'
    when lower(e.employment_status::text) in ('resigned', 'inactive', 'đã nghỉ việc', 'nghỉ việc')
      then 'resigned'
    else 'active'
  end,
  true,
  greatest(coalesce(e.hire_date, (now() at time zone 'Asia/Ho_Chi_Minh')::date),
           (now() at time zone 'Asia/Ho_Chi_Minh')::date),
  'Trạng thái ban đầu khi khởi tạo lịch sử'
from public.employees e
where not exists (
  select 1
  from public.hr_employment_status_history h
  where h.employee_id = e.employee_id
);
