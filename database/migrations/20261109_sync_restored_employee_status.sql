-- Đồng bộ trạng thái nhân viên: Nếu tài khoản đã được Admin khôi phục (deleted_at IS NULL, is_active = TRUE)
-- thì trạng thái nhân viên phải là 'Active' thay vì 'Resigned' để hiển thị lại trên Hồ sơ nhân sự.
UPDATE public.employees e
SET employment_status = 'Active'
FROM public.employee_accounts a
WHERE a.employee_id = e.employee_id
  AND a.deleted_at IS NULL
  AND a.is_active = TRUE
  AND e.employment_status = 'Resigned';
