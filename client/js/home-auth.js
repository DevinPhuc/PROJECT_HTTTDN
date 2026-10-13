(() => {
  "use strict";

  let session = null;
  try {
    session = JSON.parse(localStorage.getItem("jewels-auth-session"));
  } catch {
    session = null;
  }

  if (!session || !session.email) {
    window.location.replace("index.html");
    return;
  }

  document.getElementById("signOutButton").addEventListener("click", () => {
    localStorage.removeItem("jewels-auth-session");
    window.location.href = "index.html";
  });
})();
