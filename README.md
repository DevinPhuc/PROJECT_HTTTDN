# Hệ thống thông tin doanh nghiệp

## Cấu trúc dự án

- `manager/`: đăng nhập và quản trị nhân sự.
- `staff/`: cổng nhân viên, dùng giao diện xanh teal riêng.
- `database/`: cấu trúc và dữ liệu cơ sở dữ liệu.
- `shared/`: tài nguyên dùng chung cho giao diện quản trị.
- `docs/`: tài liệu dự án.

Mở `manager/login.html` để truy cập cổng quản lý nhân sự.
Mở `staff/staff-login.html` để truy cập cổng nhân viên. Tài khoản nằm trong bảng `employee_accounts` của cơ sở dữ liệu.
Admin hiện có giao diện quản lý hồ sơ, duyệt đơn nghỉ, báo cáo, phân quyền, chấm công và lương.

Kiến trúc xác thực: cả hai portal dùng token HS256 do edge function `admin-login` phát hành, kiểm tra qua header `x-admin-token`. Dữ liệu cập nhật hoàn toàn qua edge function riêng — `staff-portal` và `supabase/functions/hr-portal`; trình duyệt không gọi bảng trực tiếp. Plumbing dùng chung nằm ở `shared/js/portal-api.js` (phiên đăng nhập, `sbInvoke`, ánh xạ lỗi). Hàm DB `portal_login` xác định portal được phép theo vai trò.

Cấu hình Supabase (URL, key) cho các portal nằm trong `shared/js/supabase-client.js` (tạo client, retry khi mất kết nối; không dùng Supabase Auth).
Xem [hướng dẫn Supabase](docs/supabase-setup.md) để áp migration và cấp vai trò manager. Chạy dự án qua HTTP server (cập nhật dính `sbInvoke` cần cả `supabase-client.js` trước `portal-api.js`); không mở trực tiếp bằng `file://`.
