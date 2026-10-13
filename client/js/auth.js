(() => {
"use strict";

const authDialog = document.getElementById("authDialog");
const authForm = document.getElementById("authForm");
const authFeedback = document.getElementById("authFeedback");
const authNameField = authForm.elements.namedItem("name");
const authConfirmField = authForm.elements.namedItem("confirmPassword");
const authRegisterOnly = document.querySelectorAll("[data-register-only]");
const authModeButtons = document.querySelectorAll("[data-auth-mode]");
const authSubmitButton = document.getElementById("authSubmit");
const accountsStorageKey = "jewels-auth-accounts";
const adminSessionKey = "jewels-admin-session";
const adminAccount = {
  name: "Quản trị viên",
  email: "admin@jewels.vn",
  password: "Admin@123"
};
const previousDemoEmail = "minhanh.demo@jewels.vn";
const demoAccount = {
  name: "Thanh Tuấn",
  email: "npttcontact@gmail.com",
  salt: "c8a2f05e114793d879a13648e2ad637b",
  passwordHash: "ef22097bbc381829325eb9b079984ef8879476529f0e7985771580e415e35c43"
};
const shouldOpenAdminLogin = new URLSearchParams(window.location.search).get("admin") === "1";

if (document.body.dataset.authSuccess === "home") {
  try {
    const session = JSON.parse(localStorage.getItem("jewels-auth-session"));
    if (session && session.email) {
      window.location.replace("home.html");
      return;
    }
  } catch {
    localStorage.removeItem("jewels-auth-session");
  }
}

function setAuthMode(mode) {
  const isRegister = mode === "register";
  authModeButtons.forEach((button) => {
    const isSelected = button.dataset.authMode === mode;
    button.classList.toggle("is-active", isSelected);
    button.setAttribute("aria-selected", String(isSelected));
  });
  authRegisterOnly.forEach((element) => {
    element.hidden = !isRegister;
  });
  authNameField.required = isRegister;
  authConfirmField.required = isRegister;
  authForm.elements.namedItem("password").autocomplete = isRegister ? "new-password" : "current-password";
  document.getElementById("authTitle").textContent = isRegister ? "Tạo tài khoản" : "Chào mừng trở lại";
  document.getElementById("authIntro").textContent = isRegister
    ? "Tạo tài khoản để lưu lại những lựa chọn yêu thích."
    : "Đăng nhập để tiếp tục hành trình của bạn.";
  document.getElementById("authSubmit").textContent = isRegister ? "Tạo tài khoản" : "Đăng nhập";
  authFeedback.textContent = "";
}

function openAuthDialog(mode = "login") {
  setAuthMode(mode);
  authDialog.showModal();
  authForm.elements.namedItem("email").focus();
}

document.querySelectorAll("[data-auth-open]").forEach((button) => {
  button.addEventListener("click", () => openAuthDialog());
});

document.addEventListener("jewels:open-auth", (event) => {
  openAuthDialog(event.detail?.mode || "login");
});

document.querySelector("[data-auth-close]").addEventListener("click", () => authDialog.close());

authDialog.addEventListener("click", (event) => {
  if (event.target === authDialog) authDialog.close();
});

authModeButtons.forEach((button) => {
  button.addEventListener("click", () => setAuthMode(button.dataset.authMode));
});

document.querySelector("[data-auth-forgot]").addEventListener("click", (event) => {
  event.preventDefault();
  authFeedback.textContent = "Vui lòng liên hệ cửa hàng để được hỗ trợ đặt lại mật khẩu.";
});

function getAccounts() {
  try {
    const storedAccounts = JSON.parse(localStorage.getItem(accountsStorageKey) || "[]");
    const accounts = Array.isArray(storedAccounts) ? storedAccounts : [];
    const previousIndex = accounts.findIndex((account) => account.email === previousDemoEmail);
    const updatedIndex = accounts.findIndex((account) => account.email === demoAccount.email);
    let accountsChanged = false;

    if (previousIndex >= 0) {
      if (updatedIndex >= 0) {
        accounts.splice(previousIndex, 1);
      } else {
        accounts[previousIndex] = demoAccount;
      }
      accountsChanged = true;
    }

    if (!accounts.some((account) => account.email === demoAccount.email)) {
      accounts.push(demoAccount);
      accountsChanged = true;
    }

    if (accountsChanged) localStorage.setItem(accountsStorageKey, JSON.stringify(accounts));
    return accounts;
  } catch {
    return [];
  }
}

function bytesToHex(bytes) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(hex) {
  return new Uint8Array(hex.match(/.{2}/g).map((byte) => parseInt(byte, 16)));
}

async function hashPassword(password, salt = crypto.getRandomValues(new Uint8Array(16))) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const hash = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: 120000, hash: "SHA-256" },
    key,
    256
  );
  return bytesToHex(new Uint8Array(hash));
}

authForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const isRegister = document.querySelector('[data-auth-mode="register"]').getAttribute("aria-selected") === "true";
  const email = authForm.elements.namedItem("email").value.trim().toLowerCase();
  const password = authForm.elements.namedItem("password").value;

  if (isRegister && authConfirmField.value !== password) {
    authConfirmField.setCustomValidity("Mật khẩu xác nhận chưa khớp.");
    authConfirmField.reportValidity();
    authConfirmField.addEventListener("input", () => authConfirmField.setCustomValidity(""), { once: true });
    return;
  }

  authSubmitButton.disabled = true;
  authSubmitButton.textContent = "Đang xử lý...";
  let account;
  let name;
  try {
    if (!isRegister && email === adminAccount.email && password === adminAccount.password) {
      localStorage.setItem(adminSessionKey, JSON.stringify({ name: adminAccount.name, email: adminAccount.email }));
      window.location.href = "../admin/dashboard.html";
      return;
    }

    const accounts = getAccounts();

    if (isRegister) {
      if (accounts.some((savedAccount) => savedAccount.email === email)) {
        authFeedback.textContent = "Email này đã được đăng ký. Hãy đăng nhập.";
        return;
      }

      const salt = crypto.getRandomValues(new Uint8Array(16));
      account = {
        name: authNameField.value.trim(),
        email,
        salt: bytesToHex(salt),
        passwordHash: await hashPassword(password, salt)
      };
      accounts.push(account);
      localStorage.setItem(accountsStorageKey, JSON.stringify(accounts));
    } else {
      account = accounts.find((savedAccount) => savedAccount.email === email);
      if (!account) {
        authFeedback.textContent = "Chưa tìm thấy tài khoản này. Hãy đăng ký trước.";
        return;
      }

      const passwordHash = await hashPassword(password, hexToBytes(account.salt));
      if (passwordHash !== account.passwordHash) {
        authFeedback.textContent = "Email hoặc mật khẩu chưa chính xác.";
        return;
      }
    }

    name = account.name || email.split("@")[0];
    localStorage.setItem("jewels-auth-session", JSON.stringify({ name, email }));
  } catch (error) {
    authFeedback.textContent = error.name === "NotSupportedError" || error.name === "TypeError"
      ? "Trình duyệt không hỗ trợ lưu tài khoản an toàn. Hãy mở trang qua máy chủ cục bộ."
      : "Không thể lưu tài khoản trong trình duyệt này.";
    return;
  } finally {
    authSubmitButton.disabled = false;
    authSubmitButton.textContent = isRegister ? "Tạo tài khoản" : "Đăng nhập";
  }

  if (document.body.dataset.authSuccess === "home") {
    window.location.href = "home.html";
    return;
  }

  document.dispatchEvent(new CustomEvent("jewels:authenticated"));
});

if (shouldOpenAdminLogin) {
  openAuthDialog("login");
}
  })();