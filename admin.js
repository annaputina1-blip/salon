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

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function getTodayKey() {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function getStatusLabel(status) {
  if (status === "completed") return "Выполнено";
  if (status === "cancelled") return "Отменена";
  return "Активна";
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
          <h3>${escapeHtml(item.name || "Без имени")}</h3>
          <p><b>Телефон:</b> ${escapeHtml(item.phone || "-")}</p>
          <p><b>Дата/время клиента:</b> ${escapeHtml(item.date || "-")}</p>
          <p><b>Источник:</b> ${escapeHtml(sourceLabel)}</p>
          <p><b>Создано:</b> ${formatDate(item.submittedAt)}</p>
          <p><b>Сообщение:</b></p>
          <div class="message">${escapeHtml(item.message || "-")}</div>
        </article>
      `;
    })
    .join("");
}

function renderAppointmentCard(item, { today = false } = {}) {
  const canComplete = today && item.status !== "completed" && item.status !== "cancelled";
  return `
    <article class="request">
      <h3>${escapeHtml(item.date || "-")} ${escapeHtml(item.time || "")} · ${escapeHtml(item.clientName || "Без имени")}</h3>
      <p><b>Телефон:</b> ${escapeHtml(item.clientPhone || "-")}</p>
      <p><b>Услуги:</b> ${escapeHtml(item.serviceTitle || "-")}</p>
      <p><b>Стоимость:</b> ${item.price ? `${escapeHtml(item.price)} ₽` : "-"}</p>
      <p><b>Длительность:</b> ${escapeHtml(item.durationMinutes || "-")} мин.</p>
      <p><b>Статус:</b> ${getStatusLabel(item.status)}</p>
      ${
        canComplete
          ? `<button type="button" class="complete-btn" data-complete-appointment="${escapeHtml(item.id)}">Услуга оказана</button>`
          : ""
      }
    </article>
  `;
}

function renderAppointments(items) {
  const todayKey = getTodayKey();
  const todayItems = items.filter((item) => item.date === todayKey && item.status !== "cancelled");

  if (!items.length) {
    appointmentsList.innerHTML = "<h2>Записи на сегодня</h2><p class=\"muted\">На сегодня записей нет.</p><h2>Все записи</h2><p class=\"muted\">Записей пока нет.</p>";
    return;
  }

  appointmentsList.innerHTML = `
    <h2>Записи на сегодня</h2>
    ${todayItems.length ? todayItems.map((item) => renderAppointmentCard(item, { today: true })).join("") : "<p class=\"muted\">На сегодня записей нет.</p>"}
    <h2>Все записи</h2>
    ${items.map((item) => renderAppointmentCard(item)).join("")}
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

async function completeAppointment(appointmentId) {
  const response = await fetch(`/api/admin/appointments/${encodeURIComponent(appointmentId)}/complete`, {
    method: "POST",
    credentials: "same-origin",
  });
  if (response.status === 401) {
    showLogin();
    return;
  }

  const data = await response.json();
  if (!response.ok || !data.ok) {
    throw new Error(data.message || "Не удалось отметить услугу оказанной");
  }

  await loadAppointments();
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

appointmentsList?.addEventListener("click", (event) => {
  const button = event.target.closest("[data-complete-appointment]");
  if (!button) return;
  button.disabled = true;
  button.textContent = "Сохраняю...";
  completeAppointment(button.dataset.completeAppointment).catch((error) => {
    alert(error.message || "Ошибка сохранения");
    button.disabled = false;
    button.textContent = "Услуга оказана";
  });
});

logoutBtn?.addEventListener("click", async () => {
  await fetch("/api/admin/logout", { method: "POST", credentials: "same-origin" });
  showLogin();
});

loadDashboard().catch(() => {
  showLogin();
});
