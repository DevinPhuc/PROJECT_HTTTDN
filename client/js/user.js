"use strict";

const products = [
  {
    name: "Dây chuyền Pearl",
    image: "product-item3.jpg",
    price: 1290000,
    date: "18/09/2026",
    order: "JW-260918"
  },
  {
    name: "Bông tai giọt sương",
    image: "product-item8.jpg",
    price: 890000,
    date: "18/09/2026",
    order: "JW-260918"
  },
  {
    name: "Nhẫn vàng thanh mảnh",
    image: "product-item11.jpg",
    price: 1850000,
    date: "22/08/2026",
    order: "JW-260822"
  }
];

const invoices = [
  {
    id: "JW-260918",
    date: "18/09/2026",
    status: "Đã giao",
    items: [
      { name: "Dây chuyền Pearl", quantity: 1, price: 1290000 },
      { name: "Bông tai giọt sương", quantity: 1, price: 890000 }
    ],
    shipping: 30000
  },
  {
    id: "JW-260822",
    date: "22/08/2026",
    status: "Đã giao",
    items: [
      { name: "Nhẫn vàng thanh mảnh", quantity: 1, price: 1850000 }
    ],
    shipping: 30000
  }
];

const defaultProfile = {
  name: "Thanh Tuấn",
  email: "npttcontact@email.com",
  phone: "090 123 4567",
  birthday: "1995-06-12",
  address: "12 Nguyễn Huệ, Quận 1, TP. Hồ Chí Minh"
};

const profileStorageKey = "jewels-account-profile";
const form = document.getElementById("profileForm");
const profileFields = ["name", "email", "phone", "birthday", "address"];
const invoiceDialog = document.getElementById("invoiceDialog");

function formatMoney(value) {
  return `${new Intl.NumberFormat("vi-VN").format(value)}đ`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[character]);
}

function getProfile() {
  try {
    const savedProfile = localStorage.getItem(profileStorageKey);
    return savedProfile ? { ...defaultProfile, ...JSON.parse(savedProfile) } : { ...defaultProfile };
  } catch {
    return { ...defaultProfile };
  }
}

let profile = getProfile();

function renderProducts() {
  document.getElementById("ownedProducts").innerHTML = products.map((product) => `
    <article class="owned-product">
      <div class="owned-product-image">
        <img src="../shared/images/${product.image}" alt="${product.name}" loading="lazy">
        <span class="product-status">Đã giao</span>
      </div>
      <h3>${product.name}</h3>
      <p class="owned-product-meta">Mua ngày ${product.date} · ${product.order}</p>
      <p class="owned-product-price">${formatMoney(product.price)}</p>
    </article>
  `).join("");
}

function getInvoiceTotal(invoice) {
  return invoice.items.reduce((sum, item) => sum + item.price * item.quantity, 0) + invoice.shipping;
}

function renderInvoices() {
  document.getElementById("invoiceList").innerHTML = invoices.map((invoice) => `
    <article class="invoice-row">
      <div><span class="invoice-row-label">Mã hóa đơn</span><strong>${invoice.id}</strong></div>
      <div><span class="invoice-row-label">Ngày đặt</span><strong>${invoice.date}</strong></div>
      <div><span class="invoice-row-label">Tổng thanh toán</span><strong>${formatMoney(getInvoiceTotal(invoice))}</strong></div>
      <div><span class="invoice-row-label">Trạng thái</span><span class="invoice-state">${invoice.status}</span></div>
      <button class="view-invoice" type="button" data-invoice="${invoice.id}">Xem hóa đơn</button>
    </article>
  `).join("");
}

function syncProfile(profileToDisplay) {
  profileFields.forEach((field) => {
    form.elements.namedItem(field).value = profileToDisplay[field] || "";
  });

  const nameParts = (profileToDisplay.name || "").trim().split(/\s+/).filter(Boolean);
  const initials = nameParts.slice(-2).map((part) => part.charAt(0)).join("").toUpperCase() || "JW";
  document.getElementById("welcomeName").textContent = nameParts[0] || "bạn";
  document.getElementById("overviewName").textContent = profileToDisplay.name || "Khách hàng Jewels";
  document.getElementById("overviewEmail").textContent = profileToDisplay.email || "";
  document.getElementById("accountAvatar").textContent = initials;
}

function setEditing(isEditing) {
  profileFields.forEach((field) => {
    form.elements.namedItem(field).disabled = !isEditing;
  });
  document.getElementById("editProfile").hidden = isEditing;
  document.getElementById("profileActions").hidden = !isEditing;
  document.getElementById("profileFeedback").textContent = "";
  if (isEditing) {
    form.elements.namedItem("name").focus();
  }
}

function openInvoice(invoiceId) {
  const invoice = invoices.find((item) => item.id === invoiceId);
  if (!invoice) return;

  const profileName = escapeHtml(profile.name);
  const profileAddress = escapeHtml(profile.address);
  const itemRows = invoice.items.map((item) => `
    <tr>
      <td>${item.name} × ${item.quantity}</td>
      <td>${formatMoney(item.price * item.quantity)}</td>
    </tr>
  `).join("");

  document.getElementById("invoiceDetails").innerHTML = `
    <div class="invoice-detail-title">
      <div><h2 id="invoiceTitle">Hóa đơn ${invoice.id}</h2><p>Ngày đặt hàng: ${invoice.date}</p></div>
      <strong>${invoice.status}</strong>
    </div>
    <p class="invoice-customer"><strong>${profileName}</strong><br>${profileAddress}</p>
    <table class="invoice-detail-table">
      <thead><tr><th>Sản phẩm</th><th>Thành tiền</th></tr></thead>
      <tbody>${itemRows}<tr><td>Phí vận chuyển</td><td>${formatMoney(invoice.shipping)}</td></tr></tbody>
    </table>
    <div class="invoice-total"><span>Tổng thanh toán</span><span>${formatMoney(getInvoiceTotal(invoice))}</span></div>
  `;
  invoiceDialog.showModal();
}

document.querySelectorAll("[data-tab]").forEach((tab, index, tabs) => {
  tab.addEventListener("click", () => activateTab(tab));
  tab.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const direction = event.key === "ArrowRight" ? 1 : -1;
    const nextTab = tabs[(index + direction + tabs.length) % tabs.length];
    nextTab.focus();
    activateTab(nextTab);
  });
});

function activateTab(selectedTab) {
  document.querySelectorAll("[data-tab]").forEach((tab) => {
    const isSelected = tab === selectedTab;
    tab.classList.toggle("is-active", isSelected);
    tab.setAttribute("aria-selected", String(isSelected));
  });
  document.querySelectorAll("[data-panel]").forEach((panel) => {
    panel.hidden = panel.dataset.panel !== selectedTab.dataset.tab;
  });
}

document.getElementById("editProfile").addEventListener("click", () => setEditing(true));

document.getElementById("cancelEdit").addEventListener("click", () => {
  syncProfile(profile);
  setEditing(false);
});

form.addEventListener("submit", (event) => {
  event.preventDefault();
  const updatedProfile = Object.fromEntries(new FormData(form));

  try {
    localStorage.setItem(profileStorageKey, JSON.stringify(updatedProfile));
    profile = updatedProfile;
    syncProfile(profile);
    setEditing(false);
    document.getElementById("profileFeedback").textContent = "Thông tin của bạn đã được cập nhật.";
  } catch {
    document.getElementById("profileFeedback").textContent = "Không thể lưu trên trình duyệt này. Vui lòng thử lại.";
  }
});

document.getElementById("invoiceList").addEventListener("click", (event) => {
  const invoiceButton = event.target.closest("[data-invoice]");
  if (invoiceButton) openInvoice(invoiceButton.dataset.invoice);
});

document.getElementById("closeInvoice").addEventListener("click", () => invoiceDialog.close());
document.getElementById("closeInvoiceFooter").addEventListener("click", () => invoiceDialog.close());
document.getElementById("printInvoice").addEventListener("click", () => window.print());
invoiceDialog.addEventListener("click", (event) => {
  if (event.target === invoiceDialog) invoiceDialog.close();
});

renderProducts();
renderInvoices();
syncProfile(profile);