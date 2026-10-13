const ADMIN_SESSION_KEY = "jewels-admin-session";
const ADMIN_ACCOUNT = {
  email: "admin@jewels.vn",
  name: "Quản trị viên"
};

const DEFAULT_DATA = {
  accounts: [
    { id: 1, name: "Nguyễn Quỳnh Trang", email: "quynhtrang@jewels.vn", role: "Quản lý", status: "Hoạt động" },
    { id: 2, name: "Đỗ Minh Khánh", email: "minhkhanh@jewels.vn", role: "Quản lý kho", status: "Khóa" },
    { id: 3, name: "Trần Bảo Ngọc", email: "baongoc@jewels.vn", role: "Support", status: "Hoạt động" }
  ],
  staff: [
    { id: 1, name: "Hà Thị Lan", email: "hathilan@jewels.vn", position: "Sale Lead", status: "Làm việc" },
    { id: 2, name: "Phạm Quốc Huy", email: "quochuy@jewels.vn", position: "Designer", status: "Nghỉ phép" },
    { id: 3, name: "Vũ Minh Tâm", email: "minhtam@jewels.vn", position: "Warehouse", status: "Làm việc" }
  ],
  customers: [
    { id: 1, name: "Nguyễn Hữu An", phone: "090 123 1111", segment: "Gold", status: "Hoạt động" },
    { id: 2, name: "Mai Thanh Thảo", phone: "090 123 2222", segment: "Pearl", status: "Mới" },
    { id: 3, name: "Lê Hoàng Nam", phone: "090 123 3333", segment: "Silver", status: "Khóa" }
  ],
  products: [
    { id: 1, name: "Dây chuyền Pearl", category: "Trang sức cổ", price: 1290000, stock: 18, status: "Đang mở bán" },
    { id: 2, name: "Nhẫn vàng 18k", category: "Nhẫn", price: 2850000, stock: 7, status: "Đang mở bán" },
    { id: 3, name: "Bông tai bạc", category: "Hoa tai", price: 890000, stock: 0, status: "Hết hàng tạm thời" }
  ],
  stock: [
    { id: 1, code: "PO-23091", supplier: "Silver Shine Co.", quantity: 180, date: "2026-10-03" },
    { id: 2, code: "PO-23088", supplier: "Ruby Atelier", quantity: 96, date: "2026-10-01" },
    { id: 3, code: "PO-23072", supplier: "Bloom Jewel", quantity: 210, date: "2026-09-28" }
  ],
  invoices: [
    { id: 1, code: "HD-24012", customer: "Nguyễn Hữu An", amount: 3820000, status: "Đã thanh toán" },
    { id: 2, code: "HD-24009", customer: "Mai Thanh Thảo", amount: 2140000, status: "Đang vận chuyển" },
    { id: 3, code: "HD-24003", customer: "Lê Hoàng Nam", amount: 890000, status: "Chờ xác nhận" }
  ],
  promotions: [
    { id: 1, name: "Flash Sale", code: "FLASH20", discount: 20, status: "Hoạt động" },
    { id: 2, name: "Member Day", code: "MEM500", discount: 500000, status: "Hoạt động" },
    { id: 3, name: "Combo Tặng", code: "COMBO", discount: 10, status: "Hết hạn" }
  ],
  orders: [
    { id: 1, code: "#61024", customer: "Nguyễn Minh Châu", total: 3800000, status: "Đang xử lý" },
    { id: 2, code: "#61010", customer: "Phan Hương Ly", total: 4200000, status: "Đã xác nhận" },
    { id: 3, code: "#60998", customer: "Vũ Quỳnh Nga", total: 1700000, status: "Đang giao" }
  ]
};

function getAdminSession() {
  try {
    return JSON.parse(localStorage.getItem(ADMIN_SESSION_KEY) || "null");
  } catch {
    return null;
  }
}

const currentSession = getAdminSession();
if (!currentSession || currentSession.email !== ADMIN_ACCOUNT.email) {
  window.location.replace("login.html");
}

const adminLogoutBtn = document.getElementById("adminLogoutBtn");
if (adminLogoutBtn) {
  adminLogoutBtn.addEventListener("click", () => {
    localStorage.removeItem(ADMIN_SESSION_KEY);
    window.location.href = "login.html";
  });
}

const STORAGE_KEYS = {
  accounts: "jewels-admin-accounts",
  staff: "jewels-admin-staff",
  customers: "jewels-admin-customers",
  products: "jewels-admin-products",
  stock: "jewels-admin-stock",
  invoices: "jewels-admin-invoices",
  promotions: "jewels-admin-promotions",
  orders: "jewels-admin-orders"
};

const state = {};
Object.entries(DEFAULT_DATA).forEach(([key, value]) => {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEYS[key]) || "null");
    state[key] = Array.isArray(saved) ? saved : value;
  } catch {
    state[key] = value;
  }
});

function saveState(key) {
  localStorage.setItem(STORAGE_KEYS[key], JSON.stringify(state[key]));
}

function getStatusClass(status) {
  const lower = String(status || "").toLowerCase();
  if (["hoạt động", "làm việc", "đã thanh toán", "đã xác nhận"].some((value) => lower.includes(value))) return "status-online";
  if (["đang xử lý", "đang vận chuyển", "đang giao", "mới", "chờ duyệt", "chờ xác nhận"].some((value) => lower.includes(value))) return "status-progress";
  return "status-away";
}

function formatMoney(value) {
  return new Intl.NumberFormat("vi-VN").format(Number(value || 0)) + "đ";
}

function buildRowHeader(columns) {
  return `
    <div class="admin-row admin-row-header">
      ${columns.map((column) => `<span>${column}</span>`).join("")}
    </div>
  `;
}

function setModule(moduleName) {
  document.querySelectorAll(".admin-module").forEach((module) => {
    const active = module.dataset.module === moduleName;
    module.hidden = !active;
    module.classList.toggle("active", active);
  });

  document.querySelectorAll(".admin-nav-item").forEach((item) => {
    const active = item.getAttribute("href") === `#${moduleName}`;
    item.classList.toggle("is-active", active);
  });
}

function bindModuleNavigation() {
  document.querySelectorAll(".admin-nav-item").forEach((item) => {
    item.addEventListener("click", (event) => {
      event.preventDefault();
      const target = item.getAttribute("href").replace("#", "");
      setModule(target);
      window.location.hash = `#${target}`;
    });
  });
}

function fillForm(formId, data) {
  const form = document.getElementById(formId);
  if (!form) return;
  const entries = new FormData(form);
  entries.forEach((_, field) => form.elements[field].value = "");
  Object.entries(data || {}).forEach(([key, value]) => {
    const field = form.elements.namedItem(key);
    if (field) field.value = value;
  });
}

function resetForm(formId) {
  const form = document.getElementById(formId);
  if (!form) return;
  form.reset();
  form.querySelector('input[name="id"]').value = "";
}

function renderOverviewBlocks() {
  const overviewAccounts = document.getElementById("overviewAccounts");
  if (overviewAccounts) {
    overviewAccounts.innerHTML = buildRowHeader(["Người dùng", "Vai trò", "Trạng thái", "Hoạt động"]) + state.accounts.slice(0, 3).map((item) => `
      <div class="admin-row">
        <span>${item.name}</span>
        <span>${item.role}</span>
        <span><em class="${getStatusClass(item.status)}">${item.status}</em></span>
        <span>2 phút trước</span>
      </div>
    `).join("");
  }

  const overviewStaff = document.getElementById("overviewStaff");
  if (overviewStaff) {
    overviewStaff.innerHTML = state.staff.slice(0, 3).map((item) => `
      <div class="mini-row">
        <span>${item.name}</span>
        <strong>${item.position}</strong>
      </div>
    `).join("");
  }

  const overviewCustomers = document.getElementById("overviewCustomers");
  if (overviewCustomers) {
    overviewCustomers.innerHTML = buildRowHeader(["Tên", "VIP", "Giá trị"]) + state.customers.slice(0, 3).map((item) => `
      <div class="admin-row">
        <span>${item.name}</span>
        <span>${item.segment}</span>
        <span>${formatMoney(Math.max(800000, item.id * 8500000))}</span>
      </div>
    `).join("");
  }

  const overviewProducts = document.getElementById("overviewProducts");
  if (overviewProducts) {
    overviewProducts.innerHTML = state.products.slice(0, 3).map((item) => `
      <article class="product-card">
        <div class="product-thumb product-thumb-${item.id % 3 === 0 ? "three" : item.id % 2 === 0 ? "two" : "one"}"></div>
        <h3>${item.name}</h3>
        <div class="product-meta"><span>SKU: JW-${String(item.id).padStart(3, "0")}</span><strong>${formatMoney(item.price)}</strong></div>
      </article>
    `).join("");
  }

  const overviewStock = document.getElementById("overviewStock");
  if (overviewStock) {
    overviewStock.innerHTML = buildRowHeader(["Mã lô", "Nhà cung cấp", "Số lượng"]) + state.stock.slice(0, 3).map((item) => `
      <div class="admin-row">
        <span>${item.code}</span>
        <span>${item.supplier}</span>
        <span>${item.quantity} sp</span>
      </div>
    `).join("");
  }

  const overviewInvoices = document.getElementById("overviewInvoices");
  if (overviewInvoices) {
    overviewInvoices.innerHTML = state.invoices.slice(0, 3).map((item) => `
      <div class="mini-row">
        <span>${item.code}</span>
        <strong>${item.status}</strong>
      </div>
    `).join("");
  }

  const overviewPromotions = document.getElementById("overviewPromotions");
  if (overviewPromotions) {
    overviewPromotions.innerHTML = state.promotions.slice(0, 3).map((item) => `
      <div class="promo-item">
        <strong>${item.name}</strong>
        <span>${item.code} · Giảm ${item.discount}${item.discount > 100 ? "đ" : "%"}</span>
      </div>
    `).join("");
  }

  const overviewOrders = document.getElementById("overviewOrders");
  if (overviewOrders) {
    overviewOrders.innerHTML = buildRowHeader(["Mã đơn", "Khách hàng", "Tổng tiền", "Trạng thái"]) + state.orders.slice(0, 3).map((item) => `
      <div class="admin-row">
        <span>${item.code}</span>
        <span>${item.customer}</span>
        <span>${formatMoney(item.total)}</span>
        <span><em class="${getStatusClass(item.status)}">${item.status}</em></span>
      </div>
    `).join("");
  }
}

function renderAccountsTable() {
  const search = document.getElementById("accountSearch");
  const term = (search?.value || "").toLowerCase();
  const rows = state.accounts.filter((item) => [item.name, item.email, item.role].join(" ").toLowerCase().includes(term));
  const table = document.getElementById("accountsTable");
  if (!table) return;
  table.innerHTML = buildRowHeader(["Họ tên", "Email", "Vai trò", "Trạng thái", "Hành động"]) + rows.map((item) => `
    <div class="admin-row">
      <span>${item.name}</span>
      <span>${item.email}</span>
      <span>${item.role}</span>
      <span><em class="${getStatusClass(item.status)}">${item.status}</em></span>
      <span class="table-actions">
        <button type="button" class="mini-btn" data-edit="accounts" data-id="${item.id}">Sửa</button>
        <button type="button" class="mini-btn danger" data-delete="accounts" data-id="${item.id}">Xóa</button>
      </span>
    </div>
  `).join("");
}

function renderStaffTable() {
  const search = document.getElementById("staffSearch");
  const term = (search?.value || "").toLowerCase();
  const rows = state.staff.filter((item) => [item.name, item.email, item.position, item.status].join(" ").toLowerCase().includes(term));
  const table = document.getElementById("staffTable");
  if (!table) return;
  table.innerHTML = buildRowHeader(["Họ tên", "Email", "Chức vụ", "Trạng thái", "Hành động"]) + rows.map((item) => `
    <div class="admin-row">
      <span>${item.name}</span>
      <span>${item.email}</span>
      <span>${item.position}</span>
      <span><em class="${getStatusClass(item.status)}">${item.status}</em></span>
      <span class="table-actions">
        <button type="button" class="mini-btn" data-edit="staff" data-id="${item.id}">Sửa</button>
        <button type="button" class="mini-btn danger" data-delete="staff" data-id="${item.id}">Xóa</button>
      </span>
    </div>
  `).join("");
}

function renderCustomersTable() {
  const search = document.getElementById("customerSearch");
  const term = (search?.value || "").toLowerCase();
  const rows = state.customers.filter((item) => [item.name, item.phone, item.segment, item.status].join(" ").toLowerCase().includes(term));
  const table = document.getElementById("customersTable");
  if (!table) return;
  table.innerHTML = buildRowHeader(["Tên", "SĐT", "VIP", "Trạng thái", "Hành động"]) + rows.map((item) => `
    <div class="admin-row">
      <span>${item.name}</span>
      <span>${item.phone}</span>
      <span>${item.segment}</span>
      <span><em class="${getStatusClass(item.status)}">${item.status}</em></span>
      <span class="table-actions">
        <button type="button" class="mini-btn" data-edit="customers" data-id="${item.id}">Sửa</button>
        <button type="button" class="mini-btn danger" data-delete="customers" data-id="${item.id}">Xóa</button>
      </span>
    </div>
  `).join("");
}

function renderProductsTable() {
  const search = document.getElementById("productSearch");
  const term = (search?.value || "").toLowerCase();
  const rows = state.products.filter((item) => [item.name, item.category, item.status].join(" ").toLowerCase().includes(term));
  const table = document.getElementById("productsTable");
  if (!table) return;
  table.innerHTML = buildRowHeader(["Sản phẩm", "Danh mục", "Giá", "Tồn kho", "Hành động"]) + rows.map((item) => `
    <div class="admin-row">
      <span>${item.name}</span>
      <span>${item.category}</span>
      <span>${formatMoney(item.price)}</span>
      <span>${item.stock}</span>
      <span class="table-actions">
        <button type="button" class="mini-btn" data-edit="products" data-id="${item.id}">Sửa</button>
        <button type="button" class="mini-btn danger" data-delete="products" data-id="${item.id}">Xóa</button>
      </span>
    </div>
  `).join("");
}

function renderStockTable() {
  const search = document.getElementById("stockSearch");
  const term = (search?.value || "").toLowerCase();
  const rows = state.stock.filter((item) => [item.code, item.supplier].join(" ").toLowerCase().includes(term));
  const table = document.getElementById("stockTable");
  if (!table) return;
  table.innerHTML = buildRowHeader(["Mã phiếu", "Nhà cung cấp", "Số lượng", "Ngày nhập", "Hành động"]) + rows.map((item) => `
    <div class="admin-row">
      <span>${item.code}</span>
      <span>${item.supplier}</span>
      <span>${item.quantity}</span>
      <span>${item.date}</span>
      <span class="table-actions">
        <button type="button" class="mini-btn" data-edit="stock" data-id="${item.id}">Sửa</button>
        <button type="button" class="mini-btn danger" data-delete="stock" data-id="${item.id}">Xóa</button>
      </span>
    </div>
  `).join("");
}

function renderInvoicesTable() {
  const search = document.getElementById("invoiceSearch");
  const term = (search?.value || "").toLowerCase();
  const rows = state.invoices.filter((item) => [item.code, item.customer, item.status].join(" ").toLowerCase().includes(term));
  const table = document.getElementById("invoicesTable");
  if (!table) return;
  table.innerHTML = buildRowHeader(["Mã HD", "Khách hàng", "Tổng tiền", "Trạng thái", "Hành động"]) + rows.map((item) => `
    <div class="admin-row">
      <span>${item.code}</span>
      <span>${item.customer}</span>
      <span>${formatMoney(item.amount)}</span>
      <span><em class="${getStatusClass(item.status)}">${item.status}</em></span>
      <span class="table-actions">
        <button type="button" class="mini-btn" data-edit="invoices" data-id="${item.id}">Sửa</button>
        <button type="button" class="mini-btn danger" data-delete="invoices" data-id="${item.id}">Xóa</button>
      </span>
    </div>
  `).join("");
}

function renderPromotionsTable() {
  const search = document.getElementById("promotionSearch");
  const term = (search?.value || "").toLowerCase();
  const rows = state.promotions.filter((item) => [item.name, item.code, item.status].join(" ").toLowerCase().includes(term));
  const table = document.getElementById("promotionsTable");
  if (!table) return;
  table.innerHTML = buildRowHeader(["Tên", "Mã", "Giảm", "Trạng thái", "Hành động"]) + rows.map((item) => `
    <div class="admin-row">
      <span>${item.name}</span>
      <span>${item.code}</span>
      <span>${item.discount > 100 ? formatMoney(item.discount) : `${item.discount}%`}</span>
      <span><em class="${getStatusClass(item.status)}">${item.status}</em></span>
      <span class="table-actions">
        <button type="button" class="mini-btn" data-edit="promotions" data-id="${item.id}">Sửa</button>
        <button type="button" class="mini-btn danger" data-delete="promotions" data-id="${item.id}">Xóa</button>
      </span>
    </div>
  `).join("");
}

function renderOrdersTable() {
  const search = document.getElementById("orderSearch");
  const term = (search?.value || "").toLowerCase();
  const rows = state.orders.filter((item) => [item.code, item.customer, item.status].join(" ").toLowerCase().includes(term));
  const table = document.getElementById("ordersTable");
  if (!table) return;
  table.innerHTML = buildRowHeader(["Mã đơn", "Khách hàng", "Tổng tiền", "Trạng thái", "Hành động"]) + rows.map((item) => `
    <div class="admin-row">
      <span>${item.code}</span>
      <span>${item.customer}</span>
      <span>${formatMoney(item.total)}</span>
      <span><em class="${getStatusClass(item.status)}">${item.status}</em></span>
      <span class="table-actions">
        <button type="button" class="mini-btn" data-edit="orders" data-id="${item.id}">Sửa</button>
        <button type="button" class="mini-btn danger" data-delete="orders" data-id="${item.id}">Xóa</button>
      </span>
    </div>
  `).join("");
}

function renderTables() {
  renderOverviewBlocks();
  renderAccountsTable();
  renderStaffTable();
  renderCustomersTable();
  renderProductsTable();
  renderStockTable();
  renderInvoicesTable();
  renderPromotionsTable();
  renderOrdersTable();
}

function attachTableSearch() {
  ["accountSearch", "staffSearch", "customerSearch", "productSearch", "stockSearch", "invoiceSearch", "promotionSearch", "orderSearch"].forEach((inputId) => {
    const input = document.getElementById(inputId);
    if (!input) return;
    input.addEventListener("input", () => {
      renderTables();
    });
  });
}

function openAddForm(moduleKey) {
  const formIdMap = {
    accounts: "accountForm",
    staff: "staffForm",
    customers: "customerForm",
    products: "productForm",
    stock: "stockForm",
    invoices: "invoiceForm",
    promotions: "promotionForm",
    orders: "orderForm"
  };
  const form = document.getElementById(formIdMap[moduleKey]);
  if (!form) return;
  resetForm(formIdMap[moduleKey]);
  const firstField = form.querySelector("input:not([type='hidden']), select");
  firstField?.focus();
}

function openEditForm(moduleKey, id) {
  const formIdMap = {
    accounts: "accountForm",
    staff: "staffForm",
    customers: "customerForm",
    products: "productForm",
    stock: "stockForm",
    invoices: "invoiceForm",
    promotions: "promotionForm",
    orders: "orderForm"
  };
  const collection = state[moduleKey];
  const record = collection.find((item) => String(item.id) === String(id));
  if (!record) return;
  fillForm(formIdMap[moduleKey], record);
}

function deleteRecord(moduleKey, id) {
  state[moduleKey] = state[moduleKey].filter((item) => String(item.id) !== String(id));
  saveState(moduleKey);
  renderTables();
}

function saveModuleRecord(moduleKey, formId) {
  const form = document.getElementById(formId);
  if (!form) return;
  const formData = Object.fromEntries(new FormData(form).entries());
  const id = formData.id ? Number(formData.id) : Date.now();
  const record = { ...formData, id };

  if (formData.id) {
    state[moduleKey] = state[moduleKey].map((item) => String(item.id) === String(formData.id) ? { ...item, ...record } : item);
  } else {
    state[moduleKey].push(record);
  }

  saveState(moduleKey);
  renderTables();
  resetForm(formId);
}

function attachCrudActions() {
  document.querySelectorAll("[data-add]").forEach((button) => {
    button.addEventListener("click", () => openAddForm(button.dataset.add));
  });

  document.querySelectorAll("[data-reset]").forEach((button) => {
    button.addEventListener("click", () => resetForm({
      accounts: "accountForm",
      staff: "staffForm",
      customers: "customerForm",
      products: "productForm",
      stock: "stockForm",
      invoices: "invoiceForm",
      promotions: "promotionForm",
      orders: "orderForm"
    }[button.dataset.reset] || ""));
  });

  document.querySelectorAll("[data-edit]").forEach((button) => {
    button.addEventListener("click", () => openEditForm(button.dataset.edit, button.dataset.id));
  });

  document.querySelectorAll("[data-delete]").forEach((button) => {
    button.addEventListener("click", () => deleteRecord(button.dataset.delete, button.dataset.id));
  });

  document.getElementById("accountForm")?.addEventListener("submit", (event) => {
    event.preventDefault();
    saveModuleRecord("accounts", "accountForm");
  });
  document.getElementById("staffForm")?.addEventListener("submit", (event) => {
    event.preventDefault();
    saveModuleRecord("staff", "staffForm");
  });
  document.getElementById("customerForm")?.addEventListener("submit", (event) => {
    event.preventDefault();
    saveModuleRecord("customers", "customerForm");
  });
  document.getElementById("productForm")?.addEventListener("submit", (event) => {
    event.preventDefault();
    saveModuleRecord("products", "productForm");
  });
  document.getElementById("stockForm")?.addEventListener("submit", (event) => {
    event.preventDefault();
    saveModuleRecord("stock", "stockForm");
  });
  document.getElementById("invoiceForm")?.addEventListener("submit", (event) => {
    event.preventDefault();
    saveModuleRecord("invoices", "invoiceForm");
  });
  document.getElementById("promotionForm")?.addEventListener("submit", (event) => {
    event.preventDefault();
    saveModuleRecord("promotions", "promotionForm");
  });
  document.getElementById("orderForm")?.addEventListener("submit", (event) => {
    event.preventDefault();
    saveModuleRecord("orders", "orderForm");
  });
}

bindModuleNavigation();
attachTableSearch();
attachCrudActions();
renderTables();

const hash = window.location.hash.replace("#", "");
if (hash && document.querySelector(`.admin-module[data-module="${hash}"]`)) {
  setModule(hash);
} else {
  setModule("overview");
}
