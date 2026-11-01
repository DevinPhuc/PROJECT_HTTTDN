// Thông tin cá nhân: fill and save the employee's own profile.
let profileLoaded = false;
let payrollInfoLoaded = false;

function updateProfileSubmitButton() {
  const submitBtn = document.querySelector("#profileForm button[type='submit']");
  if (submitBtn) {
    submitBtn.disabled = !(profileLoaded && payrollInfoLoaded);
  }
}

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

  profileLoaded = true;
  updateProfileSubmitButton();
}

// Bank account shows only its last 4 digits: read-only reference info on a
// screen anyone glancing at can read.
// function maskAccount(value) {
//   const digits = String(value).replace(/\s+/g, "");
//   return digits.length > 4 ? `•••• ${digits.slice(-4)}` : (digits || "—");
// }

let payrollInfo = {};

function renderPayrollInfo() {
  const cardFields = [
    ["bankBankName", payrollInfo.bank_name],
    ["bankSocialNo", payrollInfo.social_insurance_no],
    ["bankHealthNo", payrollInfo.health_insurance_no]
  ];
  cardFields.forEach(([id, value]) => { document.getElementById(id).textContent = value || "—"; });
  const hasAny = Boolean(payrollInfo.bank_account_no) || cardFields.some(([, value]) => Boolean(value));
  document.getElementById("bankInfoRows").hidden = !hasAny;
  document.getElementById("bankInfoNote").hidden = hasAny;
  const formFields = [["bank_name", "bank_name"], ["social_insurance_no", "social_insurance_no"], ["health_insurance_no", "health_insurance_no"]];
  formFields.forEach(([name, key]) => {
    const input = document.querySelector(`#profileForm [name="${name}"]`);
    if (input && document.activeElement !== input) input.value = payrollInfo[key] || "";
  });
}

async function loadPayrollInfo() {
  const result = await callStaff({ action: "payroll_info" });
  if (!result.ok) throw new Error(result.error);
  payrollInfo = result.data.info || {};
  renderPayrollInfo();

  payrollInfoLoaded = true;
  updateProfileSubmitButton();
}

async function saveProfile(event) {
  event.preventDefault();
  if (!profileLoaded || !payrollInfoLoaded) return;

  const formData = new FormData(event.currentTarget);
  const result = await callStaff({
    action: "update_profile",
    full_name: String(formData.get("name") || "").trim(),
    phone_number: String(formData.get("phone") || "").trim(),
    address: String(formData.get("address") || "").trim(),
    date_of_birth: formData.get("birthDate") || null,
    // Disabled controls are excluded from FormData, so employees without an
    // HR-seeded identity row send "" and the backend skips the update.
    marital_status: String(formData.get("marital_status") || "").trim()
  });
  const feedback = document.getElementById("profileFeedback");
  feedback.textContent = result.ok ? "Đã lưu thông tin cá nhân." : (result.error === "invalid_profile" ? "Vui lòng nhập đầy đủ họ tên và ngày sinh." : "Không thể lưu hồ sơ. Vui lòng thử lại.");
  
  clearTimeout(saveProfile._timer);
  if (result.ok) saveProfile._timer = setTimeout(() => { feedback.textContent = ""; }, 5000);
  
  if (result.ok) {
    employee = result.data.employee;
    contact = result.data.contact;
    populateProfile();
    
    if (!payrollInfoLoaded) return;

    const bankSave = await callStaff({
      action: "payroll_info_save",
      bank_name: String(formData.get("bank_name") || "").trim(),
      social_insurance_no: String(formData.get("social_insurance_no") || "").trim(),
      health_insurance_no: String(formData.get("health_insurance_no") || "").trim()
    });
    if (!bankSave.ok) {
      feedback.textContent = "Đã lưu hồ sơ nhưng không thể lưu thông tin ngân hàng.";
      return;
    }
    payrollInfo = bankSave.data.info || {};
    renderPayrollInfo();
  }
}

document.getElementById("profileForm").addEventListener("submit", (event) => saveProfile(event).catch(() => { document.getElementById("profileFeedback").textContent = "Không thể lưu hồ sơ."; }));

// Identity record, qualifications and status history: HR-owned data shown
// read-only; marital_status is the one field the form may update.
const STATUS_LABELS = {
  Active: "Đang làm việc",
  Probation: "Thử việc",
  OnLeave: "Nghỉ phép",
  Inactive: "Nghỉ việc",
  Resigned: "Nghỉ việc"
};
// Existing rows store marital_status in English; the form uses Vietnamese.
const MARITAL_LABELS = {
  Single: "Độc thân",
  Married: "Đã kết hôn",
  Divorced: "Ly hôn",
  Widowed: "Goá"
};
function maritalLabel(value) {
  return MARITAL_LABELS[value] || value || "";
}
let personalInfo = null;

function maskId(value) {
  const digits = String(value).trim();
  return digits.length > 4 ? `•••• ${digits.slice(-4)}` : (digits || "—");
}

function renderPersonalInfo() {
  const info = personalInfo || {};
  document.getElementById("idType").textContent = info.id_type || "—";
  document.getElementById("idNumber").textContent = info.national_id ? maskId(info.national_id) : "—";
  document.getElementById("idNationality").textContent = info.nationality || "—";
  document.getElementById("idMarital").textContent = info.marital_status ? maritalLabel(info.marital_status) : "—";
  document.getElementById("idProtectedRow").hidden = !info.is_disabled;
  document.getElementById("idProtectedUntil").textContent = dateLabel(info.protected_until);
  const hasInfo = Boolean(personalInfo);
  document.getElementById("idInfoRows").hidden = !hasInfo;
  document.getElementById("idInfoNote").hidden = hasInfo;
  const maritalSelect = document.querySelector("#profileForm [name='marital_status']");
  if (maritalSelect) {
    maritalSelect.disabled = !hasInfo;
    if (document.activeElement !== maritalSelect) maritalSelect.value = maritalLabel(info.marital_status);
  }
}

function fillRows(tbodyId, noteId, rows, build) {
  const body = document.getElementById(tbodyId);
  body.replaceChildren();
  rows.forEach((row) => { const tr = document.createElement("tr"); build(tr, row); body.append(tr); });
  document.getElementById(noteId).hidden = rows.length > 0;
}

async function loadPersonalInfo() {
  const result = await callStaff({ action: "personal_info" });
  if (!result.ok) throw new Error(result.error);
  personalInfo = result.data.personal_info || null;
  renderPersonalInfo();
  fillRows("qualificationRows", "qualificationNote", result.data.qualifications || [], (tr, q) => {
    addCell(tr, q.qualification_level || "-");
    addCell(tr, q.major_field || "-");
    addCell(tr, q.institution_name || "-");
    addCell(tr, q.graduation_year || "-");
  });
  fillRows("statusRows", "statusNote", result.data.status_history || [], (tr, row) => {
    addCell(tr, dateLabel(row.effective_date));
    addCell(tr, STATUS_LABELS[row.status] || row.status || "-");
    addCell(tr, row.reason || "-");
  });
}

async function loadProfile() {
  populateProfile();
  await Promise.all([loadPayrollInfo(), loadPersonalInfo()]);
}

VIEW_MODULES.profile = { load: loadProfile };