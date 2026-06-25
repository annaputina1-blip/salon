const http = require("http");
const https = require("https");
const net = require("net");
const tls = require("tls");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const { services } = require("./services");

const root = __dirname;
loadEnvFile(path.join(root, ".env"));

const host = process.env.HOST || "127.0.0.1";
const port = Number(process.env.PORT || 4173);
const adminLogin = process.env.ADMIN_LOGIN || "";
const adminPassword = process.env.ADMIN_PASSWORD || "";
const sessionSecret = process.env.ADMIN_SESSION_SECRET || "change-me-session-secret";
const telegramBotToken = process.env.TELEGRAM_BOT_TOKEN || "";
const telegramChatId = process.env.TELEGRAM_CHAT_ID || "";
const httpsProxy = process.env.HTTPS_PROXY || process.env.https_proxy || "";
const makeWebhookUrl = process.env.MAKE_WEBHOOK_URL || "";
const requestsFilePath = path.join(root, "data", "requests.json");
const appointmentsFilePath = path.join(root, "data", "appointments.json");
const workdayStart = process.env.BOOKING_WORKDAY_START || "09:00";
const workdayEnd = process.env.BOOKING_WORKDAY_END || "20:00";
const bookingDaysAhead = Number(process.env.BOOKING_DAYS_AHEAD || 14);
const bookingSlotStepMinutes = Number(process.env.BOOKING_SLOT_STEP_MINUTES || 30);
const bookingTimezoneOffset = process.env.BOOKING_TIMEZONE_OFFSET || "+03:00";
const sessionTtlMs = 1000 * 60 * 60 * 24;
const sessions = new Map();
const telegramDialogState = new Map();
let telegramUpdateOffset = 0;
let telegramPolling = false;
let appointmentWriteLock = Promise.resolve();

const types = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".mp4": "video/mp4",
  ".pdf": "application/pdf",
};

http
  .createServer(async (request, response) => {
    try {
      if (!request.url) {
        sendJson(response, 400, { ok: false, message: "Bad request" });
        return;
      }

      const requestUrl = new URL(request.url, `http://${request.headers.host || "localhost"}`);
      const pathname = decodeURIComponent(requestUrl.pathname);

      if (pathname === "/api/requests" && request.method === "OPTIONS") {
        response.writeHead(204, {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        });
        response.end();
        return;
      }

      if (request.method === "POST" && pathname === "/api/requests") {
        response.setHeader("Access-Control-Allow-Origin", "*");
        const body = await readJsonBody(request);
        const payload = {
          name: cleanText(body?.name),
          phone: cleanText(body?.phone),
          date: cleanText(body?.date),
          message: cleanText(body?.message),
          source: body?.source === "calculator" ? "calculator" : "site",
          submittedAt: new Date().toISOString(),
        };

        await saveRequest(payload);
        await notifyIntegrations(payload);
        sendJson(response, 201, { ok: true });
        return;
      }

      if (request.method === "POST" && pathname === "/api/admin/login") {
        if (!adminLogin || !adminPassword) {
          sendJson(response, 500, { ok: false, message: "Admin credentials are not configured in .env" });
          return;
        }

        const body = await readJsonBody(request);
        const login = String(body?.login || "");
        const password = String(body?.password || "");

        if (login !== adminLogin || password !== adminPassword) {
          sendJson(response, 401, { ok: false, message: "Invalid login or password" });
          return;
        }

        const sessionId = crypto.randomBytes(18).toString("hex");
        const signature = signSession(sessionId);
        sessions.set(sessionId, Date.now() + sessionTtlMs);
        setCookie(response, "admin_session", `${sessionId}.${signature}`, {
          httpOnly: true,
          sameSite: "Strict",
          path: "/",
          maxAge: 60 * 60 * 24,
        });
        sendJson(response, 200, { ok: true });
        return;
      }

      if (request.method === "POST" && pathname === "/api/admin/logout") {
        const rawCookie = parseCookies(request.headers.cookie || "").admin_session;
        if (rawCookie) {
          const [sessionId] = rawCookie.split(".");
          sessions.delete(sessionId);
        }
        setCookie(response, "admin_session", "", {
          httpOnly: true,
          sameSite: "Strict",
          path: "/",
          maxAge: 0,
        });
        sendJson(response, 200, { ok: true });
        return;
      }

      if (request.method === "GET" && pathname === "/api/admin/requests") {
        if (!isAuthorized(request)) {
          sendJson(response, 401, { ok: false, message: "Unauthorized" });
          return;
        }

        const rows = await loadRequests();
        rows.sort((a, b) => Date.parse(b.submittedAt || "") - Date.parse(a.submittedAt || ""));
        sendJson(response, 200, { ok: true, requests: rows });
        return;
      }

      if (request.method === "GET" && pathname === "/api/admin/appointments") {
        if (!isAuthorized(request)) {
          sendJson(response, 401, { ok: false, message: "Unauthorized" });
          return;
        }

        const rows = await loadAppointments();
        rows.sort((a, b) => Date.parse(a.startAt || "") - Date.parse(b.startAt || ""));
        sendJson(response, 200, { ok: true, appointments: rows });
        return;
      }

      const requestedPath = pathname === "/" ? "index.html" : pathname.slice(1);
      const filePath = path.resolve(root, requestedPath);

      if (!filePath.startsWith(root)) {
        response.writeHead(403);
        response.end("Forbidden");
        return;
      }

      fs.readFile(filePath, (error, data) => {
        if (error) {
          response.writeHead(404);
          response.end("Not found");
          return;
        }

        response.writeHead(200, {
          "Content-Type": types[path.extname(filePath)] || "application/octet-stream",
        });
        response.end(data);
      });
    } catch (error) {
      sendJson(response, 500, { ok: false, message: error.message || "Server error" });
    }
  })
  .listen(port, host, () => {
    console.log(`http://${host}:${port}`);
    startTelegramBot();
  })
  .on("error", (error) => {
    if (error.code === "EADDRINUSE") {
      console.error(`Port ${port} is already in use. Start with another port: set PORT=4174 && node server.js`);
    } else {
      console.error(error.message);
    }
    process.exit(1);
  });

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  const content = fs.readFileSync(filePath, "utf8");
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index < 1) continue;
    const key = trimmed.slice(0, index).trim();
    let value = trimmed.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

function cleanText(value) {
  return String(value || "").trim().slice(0, 4000);
}

function parseCookies(cookieHeader) {
  const result = {};
  for (const pair of cookieHeader.split(";")) {
    const [rawName, ...rawValue] = pair.trim().split("=");
    if (!rawName) continue;
    result[rawName] = decodeURIComponent(rawValue.join("="));
  }
  return result;
}

function signSession(sessionId) {
  return crypto.createHmac("sha256", sessionSecret).update(sessionId).digest("hex");
}

function isAuthorized(request) {
  const rawCookie = parseCookies(request.headers.cookie || "").admin_session;
  if (!rawCookie) return false;
  const [sessionId, signature] = rawCookie.split(".");
  if (!sessionId || !signature) return false;
  const validSignature = signSession(sessionId);
  if (signature !== validSignature) return false;
  const expiresAt = sessions.get(sessionId);
  if (!expiresAt || expiresAt < Date.now()) {
    sessions.delete(sessionId);
    return false;
  }
  return true;
}

function setCookie(response, name, value, options = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  if (options.maxAge !== undefined) parts.push(`Max-Age=${options.maxAge}`);
  if (options.path) parts.push(`Path=${options.path}`);
  if (options.httpOnly) parts.push("HttpOnly");
  if (options.sameSite) parts.push(`SameSite=${options.sameSite}`);
  response.setHeader("Set-Cookie", parts.join("; "));
}

async function readJsonBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = Buffer.concat(chunks).toString("utf8");
  if (!body) return {};
  return JSON.parse(body);
}

async function ensureRequestsStorage() {
  const dir = path.dirname(requestsFilePath);
  await fsp.mkdir(dir, { recursive: true });
  if (!fs.existsSync(requestsFilePath)) {
    await fsp.writeFile(requestsFilePath, "[]", "utf8");
  }
}

async function loadRequests() {
  await ensureRequestsStorage();
  const content = await fsp.readFile(requestsFilePath, "utf8");
  try {
    const data = JSON.parse(content);
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

async function ensureAppointmentsStorage() {
  const dir = path.dirname(appointmentsFilePath);
  await fsp.mkdir(dir, { recursive: true });
  if (!fs.existsSync(appointmentsFilePath)) {
    await fsp.writeFile(appointmentsFilePath, "[]", "utf8");
  }
}

async function loadAppointments() {
  await ensureAppointmentsStorage();
  const content = await fsp.readFile(appointmentsFilePath, "utf8");
  try {
    const data = JSON.parse(content);
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

async function saveRequest(item) {
  const data = await loadRequests();
  data.push({
    id: crypto.randomUUID(),
    ...item,
  });
  await fsp.writeFile(requestsFilePath, JSON.stringify(data, null, 2), "utf8");
}

async function reserveAppointment(item) {
  const operation = appointmentWriteLock.then(async () => {
    const data = await loadAppointments();
    const hasOverlap = data.some((existing) => appointmentsOverlap(existing, item.startAt, item.endAt));
    if (hasOverlap) return false;

    data.push({
      id: crypto.randomUUID(),
      status: "active",
      createdAt: new Date().toISOString(),
      ...item,
    });
    await fsp.writeFile(appointmentsFilePath, JSON.stringify(data, null, 2), "utf8");
    return true;
  });

  appointmentWriteLock = operation.catch(() => {});
  return operation;
}

function startTelegramBot() {
  if (!telegramBotToken || telegramPolling) return;
  telegramPolling = true;
  telegramApi("deleteWebhook", { drop_pending_updates: false })
    .catch((error) => {
      console.error("Telegram deleteWebhook error:", error.message);
    })
    .finally(() => {
      pollTelegramUpdates();
    });
}

async function pollTelegramUpdates() {
  if (!telegramPolling) return;

  try {
    const data = await telegramApi("getUpdates", {
      offset: telegramUpdateOffset || undefined,
      timeout: 20,
      allowed_updates: ["message", "callback_query"],
    });

    for (const update of data.result || []) {
      telegramUpdateOffset = Math.max(telegramUpdateOffset, update.update_id + 1);
      await handleTelegramUpdate(update);
    }
  } catch (error) {
    console.error("Telegram polling error:", error.message);
  } finally {
    setTimeout(pollTelegramUpdates, 1500);
  }
}

async function handleTelegramUpdate(update) {
  if (update.callback_query) {
    await handleTelegramCallback(update.callback_query);
    return;
  }

  const message = update.message;
  if (!message?.chat?.id) return;

  const chatId = message.chat.id;
  const text = cleanText(message.text || message.contact?.phone_number);

  if (text === "/start" || text === "/book" || text === "Записаться") {
    telegramDialogState.set(chatId, {});
    await sendServiceCategories(chatId);
    return;
  }

  if (text === "/services") {
    await sendTelegramMessage(chatId, buildServicesText());
    return;
  }

  if (text === "/cancel") {
    telegramDialogState.delete(chatId);
    await sendTelegramMessage(chatId, "Запись отменена. Чтобы начать заново, нажмите /start.");
    return;
  }

  if (text === "/appointments") {
    if (!telegramChatId || String(chatId) !== String(telegramChatId)) {
      await sendTelegramMessage(chatId, "Эта команда доступна только мастеру.");
      return;
    }
    await sendTelegramMessage(chatId, await buildAppointmentsText());
    return;
  }

  const state = telegramDialogState.get(chatId);
  if (!state) {
    await sendTelegramMessage(chatId, "Здравствуйте! Нажмите /start, чтобы выбрать услугу и свободное время.");
    return;
  }

  if (state.step === "name") {
    if (text.length < 2) {
      await sendTelegramMessage(chatId, "Напишите, пожалуйста, имя: минимум 2 символа.");
      return;
    }

    state.name = text.slice(0, 80);
    state.step = "phone";
    telegramDialogState.set(chatId, state);
    await sendTelegramMessage(chatId, "Оставьте телефон в формате +7 918 421 44 94.");
    return;
  }

  if (state.step === "phone") {
    const phone = formatRussianPhone(text);
    if (!phone) {
      await sendTelegramMessage(chatId, "Не похоже на российский номер. Пример: +7 918 421 44 94.");
      return;
    }

    state.phone = phone;
    await finishTelegramBooking(chatId, state);
  }
}

async function handleTelegramCallback(callback) {
  const chatId = callback.message?.chat?.id;
  const data = String(callback.data || "");
  if (!chatId) return;

  await answerCallback(callback.id);

  if (data === "restart") {
    telegramDialogState.set(chatId, {});
    await sendServiceCategories(chatId);
    return;
  }

  if (data.startsWith("cat:")) {
    const categoryKey = data.slice(4);
    const category = categoryKey === "laser" ? "Лазерная эпиляция" : "LPG-массаж";
    telegramDialogState.set(chatId, { category });
    await sendServices(chatId, category);
    return;
  }

  if (data.startsWith("svc:")) {
    const service = getServiceById(data.slice(4));
    if (!service) {
      await sendTelegramMessage(chatId, "Не нашла эту услугу. Давайте начнем заново.", restartKeyboard());
      return;
    }

    telegramDialogState.set(chatId, { serviceId: service.id });
    await sendDates(chatId, service);
    return;
  }

  if (data.startsWith("date:")) {
    const state = telegramDialogState.get(chatId) || {};
    const service = getServiceById(state.serviceId);
    const date = data.slice(5);
    if (!service || !isDateSelectable(date)) {
      await sendTelegramMessage(chatId, "Дата уже недоступна. Выберите заново.", restartKeyboard());
      return;
    }

    state.date = date;
    telegramDialogState.set(chatId, state);
    await sendSlots(chatId, service, date);
    return;
  }

  if (data.startsWith("slot:")) {
    const state = telegramDialogState.get(chatId) || {};
    const service = getServiceById(state.serviceId);
    const [, date, rawTime] = data.split(":");
    const time = rawTime ? rawTime.replace("-", ":") : "";
    if (!service || !date || !time) {
      await sendTelegramMessage(chatId, "Слот уже недоступен. Выберите заново.", restartKeyboard());
      return;
    }

    const available = await isSlotAvailable(date, time, service.durationMinutes);
    if (!available) {
      await sendTelegramMessage(chatId, "Это время только что заняли. Показываю актуальные свободные окна.");
      await sendSlots(chatId, service, date);
      return;
    }

    state.date = date;
    state.time = time;
    state.step = "name";
    telegramDialogState.set(chatId, state);
    await sendTelegramMessage(chatId, "Как вас записать? Напишите имя.");
  }
}

async function finishTelegramBooking(chatId, state) {
  const service = getServiceById(state.serviceId);
  if (!service || !state.date || !state.time) {
    telegramDialogState.delete(chatId);
    await sendTelegramMessage(chatId, "Не хватает данных для записи. Нажмите /start и попробуйте еще раз.");
    return;
  }

  const startAt = buildDateTimeIso(state.date, state.time);
  const endAt = addMinutesIso(startAt, service.durationMinutes);
  const appointment = {
    source: "telegram_bot",
    telegramChatId: String(chatId),
    clientName: state.name,
    clientPhone: state.phone,
    serviceId: service.id,
    serviceTitle: service.title,
    serviceCategory: service.category,
    price: service.price,
    durationMinutes: service.durationMinutes,
    date: state.date,
    time: state.time,
    startAt,
    endAt,
  };

  const reserved = await reserveAppointment(appointment);
  if (!reserved) {
    telegramDialogState.delete(chatId);
    await sendTelegramMessage(chatId, "Пока вводили данные, это время заняли. Давайте выберем другое.", restartKeyboard());
    return;
  }

  await saveRequest({
    name: state.name,
    phone: state.phone,
    date: `${formatDateRu(state.date)} ${state.time}`,
    message: `${service.category}: ${service.title}. Цена: ${formatRub(service.price)}. Длительность: ${service.durationMinutes} мин.`,
    source: "telegram_bot",
    submittedAt: new Date().toISOString(),
  });
  telegramDialogState.delete(chatId);

  const userText = [
    "Запись создана.",
    "",
    `Услуга: ${service.title}`,
    `Дата и время: ${formatDateRu(state.date)} ${state.time}`,
    `Стоимость: ${formatRub(service.price)}`,
    `Имя: ${state.name}`,
    `Телефон: ${state.phone}`,
  ].join("\n");
  await sendTelegramMessage(chatId, userText, restartKeyboard("Записаться еще"));
  await notifyAppointmentTelegram(appointment);
}

async function sendServiceCategories(chatId) {
  await sendTelegramMessage(chatId, "Выберите направление:", {
    inline_keyboard: [
      [{ text: "Лазерная эпиляция", callback_data: "cat:laser" }],
      [{ text: "LPG-массаж", callback_data: "cat:lpg" }],
    ],
  });
}

async function sendServices(chatId, category) {
  const rows = services
    .filter((service) => service.category === category)
    .map((service) => [
      {
        text: `${service.title} - ${formatRub(service.price)}`,
        callback_data: `svc:${service.id}`,
      },
    ]);

  await sendTelegramMessage(chatId, "Выберите услугу:", { inline_keyboard: rows });
}

async function sendDates(chatId, service) {
  const dates = getSelectableDates();
  const rows = chunk(
    dates.map((date) => ({
      text: formatShortDateRu(date),
      callback_data: `date:${date}`,
    })),
    2
  );

  await sendTelegramMessage(
    chatId,
    `Услуга: ${service.title}\nДлительность: ${service.durationMinutes} мин.\nВыберите день:`,
    { inline_keyboard: rows }
  );
}

async function sendSlots(chatId, service, date) {
  const slots = await getAvailableSlots(date, service.durationMinutes);
  if (!slots.length) {
    await sendTelegramMessage(chatId, "На этот день свободных окон нет. Выберите другой день.", {
      inline_keyboard: [[{ text: "Выбрать дату", callback_data: `svc:${service.id}` }]],
    });
    return;
  }

  const rows = chunk(
    slots.map((time) => ({
      text: time,
      callback_data: `slot:${date}:${time.replace(":", "-")}`,
    })),
    3
  );

  await sendTelegramMessage(chatId, `Свободное время на ${formatDateRu(date)}:`, { inline_keyboard: rows });
}

async function notifyAppointmentTelegram(appointment) {
  if (!telegramChatId) return;
  const text = [
    "Новая запись из Telegram-бота",
    "",
    `Имя: ${appointment.clientName}`,
    `Телефон: ${appointment.clientPhone}`,
    `Услуга: ${appointment.serviceTitle}`,
    `Цена: ${formatRub(appointment.price)}`,
    `Дата и время: ${formatDateRu(appointment.date)} ${appointment.time}`,
    `Длительность: ${appointment.durationMinutes} мин.`,
  ].join("\n");

  try {
    await sendTelegramMessage(telegramChatId, text);
  } catch (error) {
    console.error("Telegram appointment notification error:", error.message);
  }
}

async function buildAppointmentsText() {
  const data = await loadAppointments();
  const upcoming = data
    .filter((item) => item.status !== "cancelled" && Date.parse(item.endAt || "") >= Date.now())
    .sort((a, b) => Date.parse(a.startAt || "") - Date.parse(b.startAt || ""))
    .slice(0, 12);

  if (!upcoming.length) return "Ближайших записей пока нет.";

  return [
    "Ближайшие записи:",
    "",
    ...upcoming.map(
      (item) =>
        `${formatDateRu(item.date)} ${item.time} - ${item.clientName}, ${item.clientPhone}, ${item.serviceTitle}`
    ),
  ].join("\n");
}

function buildServicesText() {
  const lines = ["Услуги и цены:", ""];
  for (const category of [...new Set(services.map((service) => service.category))]) {
    lines.push(category);
    for (const service of services.filter((item) => item.category === category)) {
      lines.push(`- ${service.title}: ${formatRub(service.price)}, ${service.durationMinutes} мин.`);
    }
    lines.push("");
  }
  return lines.join("\n").trim();
}

function getServiceById(id) {
  return services.find((service) => service.id === id);
}

function getSelectableDates() {
  const dates = [];
  const now = new Date();
  for (let index = 0; index < bookingDaysAhead; index += 1) {
    const date = new Date(now);
    date.setDate(now.getDate() + index);
    dates.push(toDateKey(date));
  }
  return dates;
}

function isDateSelectable(date) {
  return getSelectableDates().includes(date);
}

async function getAvailableSlots(date, durationMinutes) {
  const result = [];
  const startMinutes = parseTimeToMinutes(workdayStart);
  const endMinutes = parseTimeToMinutes(workdayEnd);

  for (let minutes = startMinutes; minutes + durationMinutes <= endMinutes; minutes += bookingSlotStepMinutes) {
    const time = minutesToTime(minutes);
    if (await isSlotAvailable(date, time, durationMinutes)) {
      result.push(time);
    }
  }

  return result;
}

async function isSlotAvailable(date, time, durationMinutes) {
  if (!date || !time) return false;

  const startAt = buildDateTimeIso(date, time);
  const endAt = addMinutesIso(startAt, durationMinutes);
  if (Date.parse(startAt) < Date.now() + 1000 * 60 * 60) return false;

  const appointments = await loadAppointments();
  return !appointments.some((item) => appointmentsOverlap(item, startAt, endAt));
}

function appointmentsOverlap(item, startAt, endAt) {
  if (item.status === "cancelled") return false;
  if (!item.startAt || !item.endAt) return false;
  return Date.parse(startAt) < Date.parse(item.endAt) && Date.parse(endAt) > Date.parse(item.startAt);
}

function parseTimeToMinutes(value) {
  const match = String(value || "").match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return 0;
  return Number(match[1]) * 60 + Number(match[2]);
}

function minutesToTime(minutes) {
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return `${String(hours).padStart(2, "0")}:${String(mins).padStart(2, "0")}`;
}

function buildDateTimeIso(date, time) {
  return `${date}T${time}:00${bookingTimezoneOffset}`;
}

function addMinutesIso(isoString, minutes) {
  return new Date(Date.parse(isoString) + minutes * 60 * 1000).toISOString();
}

function toDateKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function formatDateRu(date) {
  const value = new Date(`${date}T12:00:00${bookingTimezoneOffset}`);
  return value.toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric" });
}

function formatShortDateRu(date) {
  const value = new Date(`${date}T12:00:00${bookingTimezoneOffset}`);
  const weekday = value.toLocaleDateString("ru-RU", { weekday: "short" }).replace(".", "");
  const day = String(value.getDate()).padStart(2, "0");
  const month = String(value.getMonth() + 1).padStart(2, "0");
  return `${weekday} ${day}.${month}`;
}

function formatRub(value) {
  return `${new Intl.NumberFormat("ru-RU").format(Number(value || 0))} ₽`;
}

function formatRussianPhone(value) {
  const digits = String(value || "").replace(/\D/g, "");
  let normalized = digits;
  if (digits.length === 11 && digits.startsWith("8")) {
    normalized = `7${digits.slice(1)}`;
  }
  if (digits.length === 10 && digits.startsWith("9")) {
    normalized = `7${digits}`;
  }
  if (normalized.length !== 11 || !normalized.startsWith("7")) return "";
  return `+7 ${normalized.slice(1, 4)} ${normalized.slice(4, 7)} ${normalized.slice(7, 9)} ${normalized.slice(9, 11)}`;
}

function chunk(items, size) {
  const result = [];
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }
  return result;
}

function restartKeyboard(text = "Начать заново") {
  return { inline_keyboard: [[{ text, callback_data: "restart" }]] };
}

async function sendTelegramMessage(chatId, text, replyMarkup) {
  await telegramApi("sendMessage", {
    chat_id: chatId,
    text,
    reply_markup: replyMarkup || undefined,
  });
}

async function answerCallback(callbackQueryId) {
  if (!callbackQueryId) return;
  await telegramApi("answerCallbackQuery", {
    callback_query_id: callbackQueryId,
  });
}

function telegramApi(method, payload) {
  return postTelegram(`/bot${telegramBotToken}/${method}`, payload);
}

async function notifyIntegrations(payload) {
  await Promise.allSettled([notifyTelegram(payload), notifyMakeWebhook(payload)]);
}

async function notifyTelegram(payload) {
  if (!telegramBotToken || !telegramChatId) return;

  const lines = [
    "Новая заявка с сайта",
    "",
    `Имя: ${payload.name || "-"}`,
    `Телефон: ${payload.phone || "-"}`,
    `Услуги: ${payload.message || "-"}`,
    `Источник: ${payload.source || "-"}`,
    `Время: ${payload.submittedAt || "-"}`,
  ];

  const text = lines.join("\n");
  const pathName = `/bot${telegramBotToken}/sendMessage`;

  try {
    await postTelegram(pathName, {
      chat_id: telegramChatId,
      text,
    });
  } catch (error) {
    console.error("Telegram notification error:", error.message);
  }
}

async function notifyMakeWebhook(payload) {
  if (!makeWebhookUrl) return;

  try {
    const response = await fetch(makeWebhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: payload.name || "",
        phone: payload.phone || "",
        services: payload.message || "",
        source: payload.source || "",
        submittedAt: payload.submittedAt || "",
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      console.error("Make webhook notification failed:", response.status, body);
    }
  } catch (error) {
    console.error("Make webhook notification error:", error.message);
  }
}

function postTelegram(pathName, payload) {
  if (httpsProxy) {
    return postTelegramViaProxy(pathName, payload, httpsProxy);
  }

  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const request = https.request(
      {
        protocol: "https:",
        hostname: "api.telegram.org",
        path: pathName,
        method: "POST",
        family: 4,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
        timeout: 15000,
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          if (response.statusCode && response.statusCode >= 200 && response.statusCode < 300) {
            resolve(parseTelegramJson(text));
            return;
          }
          reject(new Error(`Telegram API failed: ${response.statusCode || 0} ${text}`));
        });
      }
    );

    request.on("timeout", () => {
      request.destroy(new Error("Telegram request timeout"));
    });
    request.on("error", reject);
    request.write(body);
    request.end();
  });
}

function postTelegramViaProxy(pathName, payload, proxyUrlRaw) {
  return new Promise((resolve, reject) => {
    let proxyUrl;
    try {
      proxyUrl = new URL(proxyUrlRaw);
    } catch {
      reject(new Error("Invalid HTTPS_PROXY URL"));
      return;
    }

    const proxyHost = proxyUrl.hostname;
    const proxyPort = Number(proxyUrl.port || (proxyUrl.protocol === "https:" ? 443 : 80));
    const proxyAuth = proxyUrl.username
      ? `${decodeURIComponent(proxyUrl.username)}:${decodeURIComponent(proxyUrl.password || "")}`
      : "";

    const connectSocket = net.connect(proxyPort, proxyHost);
    const timeoutMs = 15000;
    const authHeader = proxyAuth ? `Proxy-Authorization: Basic ${Buffer.from(proxyAuth).toString("base64")}\r\n` : "";
    const connectRequest =
      `CONNECT api.telegram.org:443 HTTP/1.1\r\n` +
      `Host: api.telegram.org:443\r\n` +
      `${authHeader}` +
      `Connection: keep-alive\r\n\r\n`;

    connectSocket.setTimeout(timeoutMs);
    connectSocket.on("timeout", () => connectSocket.destroy(new Error("Proxy tunnel timeout")));
    connectSocket.on("error", reject);

    connectSocket.once("connect", () => {
      connectSocket.write(connectRequest);
    });

    let connectResponse = "";
    connectSocket.on("data", (chunk) => {
      connectResponse += chunk.toString("utf8");
      if (!connectResponse.includes("\r\n\r\n")) return;

      const statusLine = connectResponse.split("\r\n")[0] || "";
      if (!statusLine.includes(" 200 ")) {
        connectSocket.destroy();
        reject(new Error(`Proxy CONNECT failed: ${statusLine}`));
        return;
      }

      connectSocket.removeAllListeners("data");

      const tlsSocket = tls.connect(
        {
          socket: connectSocket,
          servername: "api.telegram.org",
        },
        () => {
          const body = JSON.stringify(payload);
          const request =
            `POST ${pathName} HTTP/1.1\r\n` +
            `Host: api.telegram.org\r\n` +
            `Content-Type: application/json\r\n` +
            `Content-Length: ${Buffer.byteLength(body)}\r\n` +
            `Connection: close\r\n\r\n` +
            body;
          tlsSocket.write(request);
        }
      );

      tlsSocket.setTimeout(timeoutMs);
      tlsSocket.on("timeout", () => tlsSocket.destroy(new Error("Telegram request timeout")));
      tlsSocket.on("error", reject);

      let responseBuffer = "";
      tlsSocket.on("data", (chunk2) => {
        responseBuffer += chunk2.toString("utf8");
      });
      tlsSocket.on("end", () => {
        const statusLine2 = responseBuffer.split("\r\n")[0] || "";
        if (statusLine2.includes(" 200 ")) {
          resolve(parseTelegramJson(extractHttpBody(responseBuffer)));
          return;
        }
        reject(new Error(`Telegram API failed via proxy: ${statusLine2}`));
      });
    });
  });
}

function parseTelegramJson(text) {
  if (!text) return { ok: true };
  try {
    return JSON.parse(text);
  } catch {
    return { ok: true };
  }
}

function extractHttpBody(rawResponse) {
  const separatorIndex = rawResponse.indexOf("\r\n\r\n");
  if (separatorIndex < 0) return "";
  const headers = rawResponse.slice(0, separatorIndex).toLowerCase();
  const body = rawResponse.slice(separatorIndex + 4);
  if (!headers.includes("transfer-encoding: chunked")) return body;

  let index = 0;
  let decoded = "";
  while (index < body.length) {
    const lineEnd = body.indexOf("\r\n", index);
    if (lineEnd < 0) break;
    const size = Number.parseInt(body.slice(index, lineEnd), 16);
    if (!size) break;
    const chunkStart = lineEnd + 2;
    decoded += body.slice(chunkStart, chunkStart + size);
    index = chunkStart + size + 2;
  }
  return decoded;
}
function sendJson(response, statusCode, body) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(body));
}









