const loginSection = document.querySelector("#loginSection");
const adminSection = document.querySelector("#adminSection");
const loginForm = document.querySelector("#loginForm");
const loginError = document.querySelector("#loginError");
const requestsList = document.querySelector("#requestsList");
const appointmentsList = document.querySelector("#appointmentsList");
const refreshBtn = document.querySelector("#refreshBtn");
const logoutBtn = document.querySelector("#logoutBtn");

function formatDate(isoString) {
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleString("ru-RU");
}

function renderRequests(items) {
  if (!items.length) {
    requestsList.innerHTML = "<p class=\"muted\">Заявок пока нет.</p>";
    return;
  }

  requestsList.innerHTML = items
    .map((item) => {
      const sourceLabel =
        item.source === "calculator" ? "С калькулятора" : item.source === "telegram_bot" ? "Из Telegram-бота" : "С сайта";
      return `
        <article class="request">
          <h3>${item.name || "Без имени"}</h3>
          <p><b>Телефон:</b> ${item.phone || "-"}</p>
          <p><b>Дата/время клиента:</b> ${item.date || "-"}</p>
          <p><b>Источник:</b> ${sourceLabel}</p>
          <p><b>Создано:</b> ${formatDate(item.submittedAt)}</p>
          <p><b>Сообщение:</b></p>
          <div class="message">${item.message || "-"}</div>
        </article>
      `;
    })
    .join("");
}

function renderAppointments(items) {
  if (!items.length) {
    appointmentsList.innerHTML = "<h2>Записи</h2><p class=\"muted\">Активных записей пока нет.</p>";
    return;
  }

  appointmentsList.innerHTML = `
    <h2>Записи</h2>
    ${items
      .map(
        (item) => `
          <article class="request">
            <h3>${item.date || "-"} ${item.time || ""} · ${item.clientName || "Без имени"}</h3>
            <p><b>Телефон:</b> ${item.clientPhone || "-"}</p>
            <p><b>Услуга:</b> ${item.serviceTitle || "-"}</p>
            <p><b>Стоимость:</b> ${item.price ? `${item.price} ₽` : "-"}</p>
            <p><b>Длительность:</b> ${item.durationMinutes || "-"} мин.</p>
            <p><b>Статус:</b> ${item.status || "active"}</p>
          </article>
        `
      )
      .join("")}
  `;
}

async function loadRequests() {
  const response = await fetch("/api/admin/requests", { credentials: "same-origin" });
  if (response.status === 401) {
    showLogin();
    return;
  }

  const data = await response.json();
  if (!response.ok || !data.ok) {
    throw new Error(data.message || "Не удалось загрузить заявки");
  }

  showAdmin();
  renderRequests(data.requests || []);
}

async function loadAppointments() {
  const response = await fetch("/api/admin/appointments", { credentials: "same-origin" });
  if (response.status === 401) {
    showLogin();
    return;
  }

  const data = await response.json();
  if (!response.ok || !data.ok) {
    throw new Error(data.message || "Не удалось загрузить записи");
  }

  showAdmin();
  renderAppointments(data.appointments || []);
}

async function loadDashboard() {
  await Promise.all([loadRequests(), loadAppointments()]);
}

function showLogin() {
  loginSection.classList.remove("hidden");
  adminSection.classList.add("hidden");
}

function showAdmin() {
  loginSection.classList.add("hidden");
  adminSection.classList.remove("hidden");
}

loginForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  loginError.textContent = "";

  const login = document.querySelector("#login")?.value.trim() || "";
  const password = document.querySelector("#password")?.value || "";

  const response = await fetch("/api/admin/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify({ login, password }),
  });

  const data = await response.json();
  if (!response.ok || !data.ok) {
    loginError.textContent = data.message || "Ошибка входа";
    return;
  }

  await loadDashboard();
});

refreshBtn?.addEventListener("click", () => {
  loadDashboard().catch((error) => {
    alert(error.message || "Ошибка загрузки");
  });
});

logoutBtn?.addEventListener("click", async () => {
  await fetch("/api/admin/logout", { method: "POST", credentials: "same-origin" });
  showLogin();
});

loadDashboard().catch(() => {
  showLogin();
});
