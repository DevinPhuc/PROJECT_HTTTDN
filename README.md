# Hệ thống thông tin doanh nghiệp

## Cấu trúc dự án

- `manager/`: đăng nhập và quản trị nhân sự.
- `staff/`: cổng nhân viên, dùng giao diện xanh teal riêng.
- `database/`: cấu trúc và dữ liệu cơ sở dữ liệu.
- `shared/`: tài nguyên dùng chung cho giao diện quản trị.
- `docs/`: tài liệu dự án.

Mở `manager/login.html` để truy cập cổng quản lý nhân sự.
Mở `staff/staff-login.html` để truy cập cổng nhân viên. Tài khoản cần được tạo trong Supabase Auth và liên kết với hồ sơ nhân sự.
Để xem giao diện nhân viên không cần đăng nhập, mở `staff/staff-dashboard.html?demo=1`. Chế độ này chỉ dùng dữ liệu giả trên trình duyệt; thay đổi không được lưu và không truy cập Supabase.
Admin hiện có giao diện quản lý hồ sơ, duyệt đơn nghỉ, báo cáo, phân quyền, chấm công và lương.
Cấu hình client Supabase nằm trong `shared/js/supabase-config.js`. Hai portal dùng các bảng nhân sự hiện có; migration tương thích ở `database/migrations/20261017_hr_existing_tables.sql` và không chèn dữ liệu mẫu.
Xem [hướng dẫn Supabase](docs/supabase-setup.md) để áp migration, liên kết Auth email với hồ sơ nhân viên và cấp role manager. Chạy dự án qua HTTP server; không mở trực tiếp bằng `file://`.