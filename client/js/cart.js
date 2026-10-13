let discount = 0;
let shipping = 30000;


// Định dạng tiền Việt Nam
function formatMoney(number) {
    return number.toLocaleString("vi-VN") + "đ";
}


// Thay đổi số lượng
function changeQuantity(button, amount) {

    const item = button.closest(".cart-item");

    const quantityElement =
        item.querySelector(".quantity span");

    let quantity =
        parseInt(quantityElement.textContent);

    quantity += amount;

    if (quantity < 1) {
        quantity = 1;
    }

    quantityElement.textContent = quantity;

    updateItem(item);

    updateCart();
}


// Cập nhật thành tiền sản phẩm
function updateItem(item) {

    const price =
        parseInt(item.dataset.price);

    const quantity =
        parseInt(
            item.querySelector(".quantity span")
                .textContent
        );

    const total = price * quantity;

    item.querySelector(".item-total")
        .textContent = formatMoney(total);
}


// Cập nhật toàn bộ giỏ hàng
function updateCart() {

    const items =
        document.querySelectorAll(".cart-item");

    let subtotal = 0;

    items.forEach(item => {

        const price =
            parseInt(item.dataset.price);

        const quantity =
            parseInt(
                item.querySelector(".quantity span")
                    .textContent
            );

        subtotal += price * quantity;
    });


    // Nếu giỏ hàng trống
    if (items.length === 0) {

        shipping = 0;

        document.getElementById("cart-count")
            .textContent = "0";

    } else {

        document.getElementById("cart-count")
            .textContent = items.length;
    }


    const total =
        subtotal - discount + shipping;


    document.getElementById("subtotal")
        .textContent = formatMoney(subtotal);

    document.getElementById("discount")
        .textContent = "-" + formatMoney(discount);

    document.getElementById("shipping")
        .textContent = formatMoney(shipping);

    document.getElementById("total")
        .textContent = formatMoney(
            Math.max(total, 0)
        );
}


// Xóa sản phẩm
function removeItem(button) {

    const item =
        button.closest(".cart-item");

    item.remove();

    updateCart();
}


// Áp dụng voucher
function applyVoucher() {

    const voucher =
        document.getElementById("voucher")
            .value
            .trim()
            .toUpperCase();

    const message =
        document.getElementById("voucher-message");


    if (voucher === "JEWELRY10") {

        discount = 100000;

        message.textContent =
            "✓ Áp dụng mã giảm 100.000đ thành công.";

    } else if (voucher === "") {

        discount = 0;

        message.textContent =
            "Vui lòng nhập mã giảm giá.";

    } else {

        discount = 0;

        message.textContent =
            "Mã giảm giá không hợp lệ.";
    }

    updateCart();
}


// Thanh toán
function checkout() {

    const items =
        document.querySelectorAll(".cart-item");

    if (items.length === 0) {

        alert("Giỏ hàng đang trống!");

        return;
    }

    let session = null;
    try {
        session = JSON.parse(localStorage.getItem("jewels-auth-session"));
    } catch {
        session = null;
    }

    if (!session) {
        document.dispatchEvent(new CustomEvent("jewels:open-auth", { detail: { mode: "login" } }));
        return;
    }

    alert(
        "Chuyển đến trang thanh toán..."
    );
}

document.addEventListener("jewels:authenticated", () => {
    document.getElementById("authDialog").close();
    checkout();
});


// Khởi tạo
updateCart();