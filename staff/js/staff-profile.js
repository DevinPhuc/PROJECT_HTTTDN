// Thông tin cá nhân: fill and save the employee's own profile.
function populateProfile() {
  const fields = {
    name: employee.full_name,
    email: employee.email,
    birthDate: (employee.date_of_birth || "").slice(0, 10),
    phone: contact?.phone_number || "",
    address: contact?.address || ""
  };
  Object.entries(fields).forEach(([name, value]) => {
    const field = document.querySelector(`#profileForm [name="${name}"]`);
    if (field) field.value = value;
  });
  document.getElementById("staffSidebarName").textContent = employee.full_name;
  document.getElementById("staffAvatar").textContent = initials(employee.full_name);
  const jobValues = [position?.position_title || "-", department?.department_name || "-", dateLabel(employee.hire_date), "Toàn thời gian"];
  document.querySelectorAll(".staff-job-card dd").forEach((node, index) => { node.textContent = jobValues[index] || "-"; });
  document.querySelector(".staff-employee-code strong").textContent = employee.employee_code || "-";
}

async function saveProfile(event) {
  event.preventDefault();
  const formData = new FormData(event.currentTarget);
  const result = await callStaff({
    action: "update_profile",
    full_name: String(formData.get("name") || "").trim(),
    phone_number: String(formData.get("phone") || "").trim(),
    address: String(formData.get("address") || "").trim(),
    date_of_birth: formData.get("birthDate") || null
  });
  const feedback = document.getElementById("profileFeedback");
  feedback.textContent = result.ok ? "Đã lưu thông tin cá nhân." : (result.error === "invalid_profile" ? "Vui lòng nhập đầy đủ họ tên và ngày sinh." : "Không thể lưu hồ sơ. Vui lòng thử lại.");
  // Success note disappears after 5s; a re-submit restarts the timer.
  clearTimeout(saveProfile._timer);
  if (result.ok) saveProfile._timer = setTimeout(() => { feedback.textContent = ""; }, 5000);
  if (result.ok) {
    employee = result.data.employee;
    contact = result.data.contact;
    populateProfile();
  }
}

document.getElementById("profileForm").addEventListener("submit", (event) => saveProfile(event).catch(() => { document.getElementById("profileFeedback").textContent = "Không thể lưu hồ sơ."; }));

VIEW_MODULES.profile = { load: populateProfile };
