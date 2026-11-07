// Thông tin cá nhân: one collapsible form; the employee edits their own
// profile, identity fields, tax/bank data, qualifications and status history.
let profileLoaded = false;
let payrollInfoLoaded = false;
let personalInfoLoaded = false;

// Year limits come from the system clock, refreshed on every page load.
const CURRENT_YEAR = new Date().getFullYear();
function isoYearsAgo(years) {
  const past = new Date();
  past.setFullYear(past.getFullYear() - years);
  return `${past.getFullYear()}-${String(past.getMonth() + 1).padStart(2, "0")}-${String(past.getDate()).padStart(2, "0")}`;
}

// Fields that may not be left blank when saving (personal / identity / tax).
const REQUIRED_PROFILE_FIELDS = ["name", "birthDate"];

function renderBlankFieldErrors(form, names) {
  form.querySelectorAll(".staff-field-blank").forEach((el) => el.remove());
  form.querySelectorAll(".staff-input-blank").forEach((el) => el.classList.remove("staff-input-blank"));
  let firstBlank = null;
  names.forEach((name) => {
    const input = form.querySelector(`[name="${name}"]`);
    if (!input || String(input.value).trim()) return;
    input.classList.add("staff-input-blank");
    const note = document.createElement("p");
    note.className = "staff-field-blank";
    note.textContent = "⚠ Trường này không được để trống.";
    input.insertAdjacentElement("afterend", note);
    // A marked field may sit inside a closed section: open it so the error is visible.
    const section = input.closest(".accordion-collapse");
    if (section && window.bootstrap?.Collapse) window.bootstrap.Collapse.getOrCreateInstance(section).show();
    if (!firstBlank) firstBlank = input;
  });
  if (firstBlank) firstBlank.focus();
  return Boolean(firstBlank);
}

// Clear a field's blank-error state as soon as the user starts typing again.
document.getElementById("profileForm").addEventListener("input", (event) => {
  const target = event.target;
  if (target.name === "phone") {
    target.value = target.value.replace(/\D/g, "").slice(0, 10);
  }
  if (!target.classList?.contains("staff-input-blank")) return;
  target.classList.remove("staff-input-blank");
  target.closest("label")?.querySelector(".staff-field-blank")?.remove();
});

function updateProfileSubmitButton() {
  const submitBtn = document.querySelector("#profileForm button[type='submit']");
  if (submitBtn) {
    submitBtn.disabled = !(profileLoaded && payrollInfoLoaded && personalInfoLoaded);
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
  // Thông tin công việc is read-only reference data owned by HR.
  const jobFields = {
    jobPosition: position?.position_title || "-",
    jobDepartment: department?.department_name || "-",
    jobHireDate: dateLabel(employee.hire_date)
  };
  Object.entries(jobFields).forEach(([id, value]) => {
    document.getElementById(id).textContent = value;
  });
  document.querySelector(".staff-employee-code strong").textContent = employee.employee_code || "-";

  profileLoaded = true;
  updateProfileSubmitButton();
}

let payrollInfo = {};

function renderPayrollInfo() {
  const formFields = ["tax_code", "social_insurance_no", "health_insurance_no", "bank_name", "bank_account_no"];
  formFields.forEach((name) => {
    const input = document.querySelector(`#profileForm [name="${name}"]`);
    if (input && document.activeElement !== input) input.value = payrollInfo[name] || "";
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

// Identity record: id_type/national_id/nationality are now self-editable;
// marital_status is filled from the identity row and disabled without one.
const STATUS_LABELS = {
  Active: "Đang làm việc",
  OnLeave: "Nghỉ phép",
  Resigned: "Nghỉ việc"
};
// Existing rows store marital_status in English; the form uses Vietnamese.
const MARITAL_LABELS = {
  Single: "Độc thân",
  Married: "Đã kết hôn",
  Divorced: "Ly hôn"
};
function maritalLabel(value) {
  return MARITAL_LABELS[value] || value || "";
}
let personalInfo = null;

function renderPersonalInfo() {
  const info = personalInfo || {};
  const setField = (name, value) => {
    const input = document.querySelector(`#profileForm [name="${name}"]`);
    if (input && document.activeElement !== input) input.value = value ?? "";
  };
  setField("id_type", info.id_type || "");
  setField("national_id", info.national_id || "");
  setField("nationality", personalInfo ? (info.nationality || "Vietnam") : "");
  document.getElementById("protectedRow").hidden = !info.is_disabled;
  const protectedInput = document.querySelector("#profileForm [name='protected_until']");
  if (protectedInput) protectedInput.value = info.is_disabled ? dateLabel(info.protected_until) : "";
  const maritalSelect = document.querySelector("#profileForm [name='marital_status']");
  if (maritalSelect) {
    maritalSelect.disabled = false;
    if (document.activeElement !== maritalSelect) maritalSelect.value = maritalLabel(info.marital_status);
  }
}

// Editable qualification and status rows: each tbody row is a form row.
function cellInput(cls, type, maxlength, value, extra = {}) {
  const td = document.createElement("td");
  const input = document.createElement("input");
  input.className = cls;
  input.type = type;
  if (maxlength) input.maxLength = maxlength;
  input.value = value ?? "";
  Object.assign(input, extra);
  td.append(input);
  return td;
}

function cellSelect(cls, value) {
  const td = document.createElement("td");
  const select = document.createElement("select");
  select.className = cls;
  [["", "—"], ["Active", STATUS_LABELS.Active], ["OnLeave", STATUS_LABELS.OnLeave], ["Resigned", STATUS_LABELS.Resigned]]
    .forEach(([val, label]) => {
      const option = document.createElement("option");
      option.value = val;
      option.textContent = label;
      select.append(option);
    });
  select.value = value || "";
  td.append(select);
  return td;
}

function deleteCell() {
  const td = document.createElement("td");
  const button = document.createElement("button");
  button.type = "button";
  button.className = "admin-secondary-btn staff-row-delete";
  button.textContent = "Xoá";
  td.append(button);
  return td;
}

function qualificationRow(q = {}) {
  const tr = document.createElement("tr");
  tr.append(
    cellInput("q-level", "text", 50, q.qualification_level),
    cellInput("q-major", "text", 150, q.major_field),
    cellInput("q-inst", "text", 150, q.institution_name),
    cellInput("q-year", "number", 4, q.graduation_year ?? "", { min: 1950, max: CURRENT_YEAR }),
    deleteCell()
  );
  return tr;
}

function statusRow(row = {}) {
  const tr = document.createElement("tr");
  const dateTd = document.createElement("td");
  dateTd.textContent = dateLabel(row.effective_date) || "—";

  const endDateTd = document.createElement("td");
  endDateTd.textContent = dateLabel(row.end_date) || "—";

  const statusTd = document.createElement("td");
  const statusBadge = document.createElement("span");
  const label = STATUS_LABELS[row.status] || row.status || "Đang nghỉ phép";
  statusBadge.className = "staff-status-badge staff-status-onleave";
  statusBadge.textContent = label;
  statusTd.append(statusBadge);

  const reasonTd = document.createElement("td");
  reasonTd.textContent = row.reason || "—";

  tr.append(dateTd, endDateTd, statusTd, reasonTd);
  return tr;
}

// Collectors return null when a started row is incomplete: the save stops
// before anything is sent, with feedback naming the failing table.
function collectQualRows() {
  const rows = [...document.querySelectorAll("#qualificationRows tr")].map((tr) => ({
    qualification_level: tr.querySelector(".q-level").value.trim(),
    major_field: tr.querySelector(".q-major").value.trim(),
    institution_name: tr.querySelector(".q-inst").value.trim(),
    graduation_year: tr.querySelector(".q-year").value
  })).filter((row) => row.qualification_level || row.major_field || row.institution_name || row.graduation_year);
  if (rows.some((row) => !row.qualification_level)) return null;
  return rows;
}

function collectStatusRows() {
  const rows = [...document.querySelectorAll("#statusRows tr")].map((tr) => ({
    effective_date: tr.querySelector(".s-date").value,
    status: tr.querySelector(".s-status").value,
    reason: tr.querySelector(".s-reason").value.trim()
  })).filter((row) => row.status || row.effective_date);
  if (rows.some((row) => Boolean(row.status) !== Boolean(row.effective_date))) return null;
  return rows;
}

function addRowHandlers() {
  document.querySelectorAll("[data-row-add]").forEach((button) => {
    button.addEventListener("click", () => {
      const tbody = document.getElementById(button.dataset.rowAdd);
      tbody.append(tbody.id === "statusRows" ? statusRow() : qualificationRow());
    });
  });
  // Row deletion: delegated so rows added later keep the button working.
  document.getElementById("profileForm").addEventListener("click", (event) => {
    const button = event.target.closest(".staff-row-delete");
    if (!button) return;
    if (!confirm("Do you want to delete?")) return;
    button.closest("tr").remove();
  });
}

function renderRowTable(tbodyId, rows, build) {
  const tbody = document.getElementById(tbodyId);
  tbody.replaceChildren();
  if (tbodyId === "statusRows") {
    if (!rows.length) {
      const tr = document.createElement("tr");
      const td = document.createElement("td");
      td.colSpan = 4;
      td.style.textAlign = "center";
      td.style.padding = "24px 12px";
      td.style.color = "var(--admin-muted, #747b74)";
      td.textContent = "Chưa có lịch sử trạng thái nghỉ phép.";
      tr.append(td);
      tbody.append(tr);
    } else {
      rows.forEach((row) => tbody.append(build(row)));
    }
    return;
  }
  rows.forEach((row) => tbody.append(build(row)));
  // One empty row keeps the editable table usable when there is no data yet.
  if (!rows.length) tbody.append(build({}));
}

async function loadPersonalInfo() {
  const result = await callStaff({ action: "personal_info" });
  if (!result.ok) throw new Error(result.error);
  personalInfo = result.data.personal_info || null;
  renderPersonalInfo();
  renderRowTable("qualificationRows", result.data.qualifications || [], qualificationRow);
  renderRowTable("statusRows", result.data.status_history || [], statusRow);
  addRowHandlers();

  personalInfoLoaded = true;
  updateProfileSubmitButton();
}

// One save button pushes every section in a fixed order. Each step reports
// its own failure message so the employee knows which part landed.
function showProfileFeedback(message, persist) {
  const feedback = document.getElementById("profileFeedback");
  feedback.textContent = message;
  clearTimeout(saveProfile._timer);
  if (message && !persist) saveProfile._timer = setTimeout(() => { feedback.textContent = ""; }, 8000);
}

async function saveProfile(event) {
  event.preventDefault();
  if (!(profileLoaded && payrollInfoLoaded && personalInfoLoaded)) return;
  const formData = new FormData(event.currentTarget);

  // Section 8: required personal/identity/tax fields may not be blank.
  if (renderBlankFieldErrors(event.currentTarget, REQUIRED_PROFILE_FIELDS)) {
    showProfileFeedback("Vui lòng điền các trường còn trống.", true);
    showStaffToast("error", "Vui lòng điền các trường còn trống.");
    return;
  }

  const rawPhone = String(formData.get("phone") || "").trim();
  if (rawPhone && !/^\d{10}$/.test(rawPhone)) {
    showProfileFeedback("Số điện thoại phải gồm đúng 10 chữ số.", true);
    showStaffToast("error", "Số điện thoại phải gồm đúng 10 chữ số.");
    const phoneInput = event.currentTarget.querySelector("[name='phone']");
    if (phoneInput) {
      phoneInput.classList.add("staff-input-blank");
      phoneInput.focus();
    }
    return;
  }

  // Row validation first: any partial row stops the save before data moves.
  const qualRows = collectQualRows();
  if (qualRows === null) { showProfileFeedback("Mỗi dòng bằng cấp đã nhập cần có tên bằng cấp.", true); showStaffToast("error", "Không thành công. Vui lòng thử lại."); return; }

  const submitBtn = document.querySelector("#profileForm button[type='submit']");
  submitBtn.disabled = true;
  try {
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
    if (!result.ok) {
      showProfileFeedback(result.error === "invalid_phone" ? "Số điện thoại phải gồm đúng 10 chữ số." : result.error === "invalid_profile" ? "Vui lòng nhập đầy đủ họ tên và ngày sinh." : "Không thể lưu hồ sơ. Vui lòng thử lại.", true);
      showStaffToast("error", "Không thành công. Vui lòng thử lại.");
      return;
    }
    employee = result.data.employee;
    contact = result.data.contact;

    const bankSave = await callStaff({
      action: "payroll_info_save",
      bank_name: String(formData.get("bank_name") || "").trim(),
      bank_account_no: String(formData.get("bank_account_no") || "").trim(),
      tax_code: String(formData.get("tax_code") || "").trim(),
      social_insurance_no: String(formData.get("social_insurance_no") || "").trim(),
      health_insurance_no: String(formData.get("health_insurance_no") || "").trim()
    });
    if (!bankSave.ok) { showProfileFeedback("Đã lưu hồ sơ nhưng không thể lưu thông tin thuế & ngân hàng.", true); showStaffToast("error", "Không thành công. Vui lòng thử lại."); return; }
    payrollInfo = bankSave.data.info || {};

    const idSave = await callStaff({
      action: "personal_info_save",
      id_type: String(formData.get("id_type") || "").trim(),
      national_id: String(formData.get("national_id") || "").trim(),
      nationality: String(formData.get("nationality") || "").trim(),
      marital_status: String(formData.get("marital_status") || "").trim()
    });
    if (!idSave.ok) {
      showProfileFeedback(
        idSave.error === "duplicate" ? "Đã lưu hồ sơ nhưng số giấy tờ đã được dùng bởi nhân viên khác."
          : idSave.error === "invalid_identity" ? "Đã điền giấy tờ nhưng còn thiếu loại hoặc số giấy tờ."
          : "Đã lưu hồ sơ nhưng không thể lưu thông tin giấy tờ.",
        true);
      showStaffToast("error", "Không thành công. Vui lòng thử lại.");
      return;
    }
    if (idSave.data.personal_info) personalInfo = idSave.data.personal_info;

    const qualSave = await callStaff({ action: "qualifications_save", rows: qualRows });
    if (!qualSave.ok) { showProfileFeedback("Đã lưu hồ sơ nhưng không thể lưu bằng cấp & trình độ.", true); showStaffToast("error", "Không thành công. Vui lòng thử lại."); return; }

    renderRowTable("qualificationRows", qualSave.data.rows || [], qualificationRow);
    await loadPersonalInfo();
    populateProfile();
    renderPayrollInfo();
    renderPersonalInfo();
    showProfileFeedback("Đã lưu hồ sơ.", true);
    showStaffToast("success", "Lưu thay đổi thành công");
    saveProfile._timer = setTimeout(() => { document.getElementById("profileFeedback").textContent = ""; }, 5000);
  } finally {
    updateProfileSubmitButton();
  }
}

document.getElementById("profileForm").addEventListener("submit", (event) => saveProfile(event).catch(() => { showProfileFeedback("Không thể lưu hồ sơ.", true); showStaffToast("error", "Không thành công. Vui lòng thử lại."); }));

// A required/invalid control inside a collapsed section is invisible: expand
// the section owning it before the browser's bubble is shown to the user.
document.getElementById("profileForm").addEventListener("invalid", (event) => {
  const section = event.target.closest(".accordion-collapse");
  if (section && window.bootstrap?.Collapse) window.bootstrap.Collapse.getOrCreateInstance(section).show();
}, true);

async function loadProfile() {
  populateProfile();
  // Section 1: exact-date 18-year cutoff, e.g. today = 2026-11-04 allows
  // birth dates up to 2008-11-04 (so 31/12/2008 stays disabled).
  const birthInput = document.querySelector("#profileForm [name='birthDate']");
  if (birthInput) birthInput.max = isoYearsAgo(18);
  await Promise.all([loadPayrollInfo(), loadPersonalInfo()]);
}

VIEW_MODULES.profile = { load: loadProfile };

window.loadPersonalInfo = loadPersonalInfo;
