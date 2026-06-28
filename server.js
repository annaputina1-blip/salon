const http = require("http");
const https = require("https");
const net = require("net");
const tls = require("tls");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { DatabaseSync } = require("node:sqlite");
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
const telegramAdminIds = parseList(process.env.TELEGRAM_ADMIN_IDS || telegramChatId);
const httpsProxy = process.env.HTTPS_PROXY || process.env.https_proxy || "";
const makeWebhookUrl = process.env.MAKE_WEBHOOK_URL || "";
const requestsFilePath = path.join(root, "data", "requests.json");
const appointmentsFilePath = path.join(root, "data", "appointments.json");
const databaseFilePath = process.env.DATABASE_FILE
  ? path.resolve(root, process.env.DATABASE_FILE)
  : path.join(root, "data", "salon.sqlite");
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
const database = initializeDatabase();

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

function initializeDatabase() {
  fs.mkdirSync(path.dirname(databaseFilePath), { recursive: true });
  const db = new DatabaseSync(databaseFilePath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS requests (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL DEFAULT '',
      phone TEXT NOT NULL DEFAULT '',
      requested_date TEXT NOT NULL DEFAULT '',
      message TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL DEFAULT 'site',
      submitted_at TEXT NOT NULL,
      payload_json TEXT NOT NULL DEFAULT '{}'
    );

    CREATE INDEX IF NOT EXISTS idx_requests_submitted_at ON requests(submitted_at);

    CREATE TABLE IF NOT EXISTS appointments (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'telegram_bot',
      telegram_chat_id TEXT NOT NULL DEFAULT '',
      client_name TEXT NOT NULL DEFAULT '',
      client_phone TEXT NOT NULL DEFAULT '',
      service_id TEXT NOT NULL DEFAULT '',
      service_ids_json TEXT NOT NULL DEFAULT '[]',
      service_title TEXT NOT NULL DEFAULT '',
      service_titles_json TEXT NOT NULL DEFAULT '[]',
      service_category TEXT NOT NULL DEFAULT '',
      service_categories_json TEXT NOT NULL DEFAULT '[]',
      price INTEGER NOT NULL DEFAULT 0,
      duration_minutes INTEGER NOT NULL DEFAULT 0,
      appointment_date TEXT NOT NULL DEFAULT '',
      appointment_time TEXT NOT NULL DEFAULT '',
      start_at TEXT NOT NULL,
      end_at TEXT NOT NULL,
      cancelled_at TEXT NOT NULL DEFAULT '',
      cancelled_by TEXT NOT NULL DEFAULT '',
      payload_json TEXT NOT NULL DEFAULT '{}'
    );

    CREATE INDEX IF NOT EXISTS idx_appointments_start_at ON appointments(start_at);
    CREATE INDEX IF NOT EXISTS idx_appointments_status ON appointments(status);
  `);

  ensureColumn(db, "appointments", "cancelled_at", "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, "appointments", "cancelled_by", "TEXT NOT NULL DEFAULT ''");

  migrateJsonDataToDatabase(db);
  return db;
}

function ensureColumn(db, tableName, columnName, definition) {
  const columns = db.prepare(`PRAGMA table_info(${tableName})`).all();
  if (columns.some((column) => column.name === columnName)) return;
  db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
}

function migrateJsonDataToDatabase(db) {
  const requests = readJsonArraySync(requestsFilePath);
  for (const item of requests) {
    insertRequestRow(db, {
      id: item.id || crypto.randomUUID(),
      name: cleanText(item.name),
      phone: cleanText(item.phone),
      date: cleanText(item.date),
      message: cleanText(item.message),
      source: cleanText(item.source) || "site",
      submittedAt: item.submittedAt || new Date().toISOString(),
      ...item,
    });
  }

  const appointments = readJsonArraySync(appointmentsFilePath);
  for (const item of appointments) {
    insertAppointmentRow(db, {
      id: item.id || crypto.randomUUID(),
      status: item.status || "active",
      createdAt: item.createdAt || new Date().toISOString(),
      ...item,
    });
  }
}

function readJsonArraySync(filePath) {
  if (!fs.existsSync(filePath)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function insertRequestRow(db, item) {
  db.prepare(`
    INSERT OR IGNORE INTO requests (
      id, name, phone, requested_date, message, source, submitted_at, payload_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    item.id || crypto.randomUUID(),
    item.name || "",
    item.phone || "",
    item.date || "",
    item.message || "",
    item.source || "site",
    item.submittedAt || new Date().toISOString(),
    JSON.stringify(item)
  );
}

function insertAppointmentRow(db, item) {
  const serviceIds = Array.isArray(item.serviceIds) ? item.serviceIds : item.serviceId ? [item.serviceId] : [];
  const serviceTitles = Array.isArray(item.serviceTitles)
    ? item.serviceTitles
    : item.serviceTitle
      ? String(item.serviceTitle).split(",").map((value) => value.trim()).filter(Boolean)
      : [];
  const serviceCategories = Array.isArray(item.serviceCategories)
    ? item.serviceCategories
    : item.serviceCategory
      ? String(item.serviceCategory).split(",").map((value) => value.trim()).filter(Boolean)
      : [];

  db.prepare(`
    INSERT OR IGNORE INTO appointments (
      id, status, created_at, source, telegram_chat_id, client_name, client_phone,
      service_id, service_ids_json, service_title, service_titles_json,
      service_category, service_categories_json, price, duration_minutes,
      appointment_date, appointment_time, start_at, end_at, cancelled_at, cancelled_by, payload_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    item.id || crypto.randomUUID(),
    item.status || "active",
    item.createdAt || new Date().toISOString(),
    item.source || "telegram_bot",
    String(item.telegramChatId || ""),
    item.clientName || "",
    item.clientPhone || "",
    item.serviceId || serviceIds[0] || "",
    JSON.stringify(serviceIds),
    item.serviceTitle || serviceTitles.join(", "),
    JSON.stringify(serviceTitles),
    item.serviceCategory || serviceCategories.join(", "),
    JSON.stringify(serviceCategories),
    Number(item.price || 0),
    Number(item.durationMinutes || 0),
    item.date || "",
    item.time || "",
    item.startAt || "",
    item.endAt || "",
    item.cancelledAt || "",
    item.cancelledBy || "",
    JSON.stringify(item)
  );
}

function requestRowToObject(row) {
  const payload = parseJsonObject(row.payload_json);
  return {
    ...payload,
    id: row.id,
    name: row.name,
    phone: row.phone,
    date: row.requested_date,
    message: row.message,
    source: row.source,
    submittedAt: row.submitted_at,
  };
}

function appointmentRowToObject(row) {
  const payload = parseJsonObject(row.payload_json);
  const serviceIds = parseJsonArray(row.service_ids_json);
  const serviceTitles = parseJsonArray(row.service_titles_json);
  const serviceCategories = parseJsonArray(row.service_categories_json);

  return {
    ...payload,
    id: row.id,
    status: row.status,
    createdAt: row.created_at,
    source: row.source,
    telegramChatId: row.telegram_chat_id,
    clientName: row.client_name,
    clientPhone: row.client_phone,
    serviceId: row.service_id,
    serviceIds,
    serviceTitle: row.service_title,
    serviceTitles,
    serviceCategory: row.service_category,
    serviceCategories,
    price: row.price,
    durationMinutes: row.duration_minutes,
    date: row.appointment_date,
    time: row.appointment_time,
    startAt: row.start_at,
    endAt: row.end_at,
    cancelledAt: row.cancelled_at,
    cancelledBy: row.cancelled_by,
  };
}

function parseJsonObject(value) {
  try {
    const parsed = JSON.parse(value || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function parseJsonArray(value) {
  try {
    const parsed = JSON.parse(value || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function loadRequests() {
  return database
    .prepare("SELECT * FROM requests ORDER BY submitted_at DESC")
    .all()
    .map(requestRowToObject);
}

async function loadAppointments() {
  return database
    .prepare("SELECT * FROM appointments ORDER BY start_at ASC")
    .all()
    .map(appointmentRowToObject);
}

async function saveRequest(item) {
  insertRequestRow(database, {
    id: crypto.randomUUID(),
    ...item,
  });
}

async function reserveAppointment(item) {
  const operation = appointmentWriteLock.then(async () => {
    const hasOverlap = Boolean(
      database
        .prepare(
          `
            SELECT id FROM appointments
            WHERE status != 'cancelled'
              AND start_at < ?
              AND end_at > ?
            LIMIT 1
          `
        )
        .get(item.endAt, item.startAt)
    );
    if (hasOverlap) return false;

    insertAppointmentRow(database, {
      id: crypto.randomUUID(),
      status: "active",
      createdAt: new Date().toISOString(),
      ...item,
    });
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

  if (text === "/start" || text.startsWith("/start ") || text === "/book" || text === "Записаться") {
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

  if (text === "/admin") {
    if (!isTelegramAdmin(chatId)) {
      await sendTelegramMessage(chatId, "Эта команда вам не доступна");
      return;
    }

    await sendAdminMenu(chatId);
    return;
  }

  if (text === "/appointments") {
    if (!isTelegramAdmin(chatId)) {
      await sendTelegramMessage(chatId, "Эта команда вам не доступна");
      return;
    }
    await sendTelegramMessage(chatId, await buildAppointmentsText());
    return;
  }

  const state = telegramDialogState.get(chatId);
  if (!state) {
    telegramDialogState.set(chatId, { selectedServiceIds: [] });
    await sendServiceCategories(chatId);
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

  if (data.startsWith("admin:") || data.startsWith("cancel:")) {
    if (!isTelegramAdmin(chatId)) {
      await sendTelegramMessage(chatId, "Эта команда вам не доступна");
      return;
    }

    await handleAdminCallback(chatId, data);
    return;
  }

  if (data.startsWith("cat:")) {
    const categoryKey = data.slice(4);
    const category = categoryKey === "laser" ? "Лазерная эпиляция" : "LPG-массаж";
    const state = telegramDialogState.get(chatId) || {};
    state.category = category;
    state.selectedServiceIds = Array.isArray(state.selectedServiceIds) ? state.selectedServiceIds : [];
    telegramDialogState.set(chatId, state);
    await sendServices(chatId, state, callback.message?.message_id);
    return;
  }

  if (data.startsWith("svc:")) {
    const state = telegramDialogState.get(chatId) || { selectedServiceIds: [] };
    const service = getServiceById(data.slice(4));
    if (!service) {
      await sendTelegramMessage(chatId, "Не нашла эту услугу. Давайте начнем заново.", restartKeyboard());
      return;
    }

    const selected = new Set(Array.isArray(state.selectedServiceIds) ? state.selectedServiceIds : []);
    if (selected.has(service.id)) {
      selected.delete(service.id);
    } else {
      selected.add(service.id);
    }

    state.selectedServiceIds = Array.from(selected);
    state.category = service.category;
    telegramDialogState.set(chatId, state);
    await sendServices(chatId, state, callback.message?.message_id);
    return;
  }

  if (data === "choose_category") {
    const state = telegramDialogState.get(chatId) || {};
    state.selectedServiceIds = Array.isArray(state.selectedServiceIds) ? state.selectedServiceIds : [];
    telegramDialogState.set(chatId, state);
    await showServiceCategories(chatId, callback.message?.message_id);
    return;
  }

  if (data === "services_done") {
    const state = telegramDialogState.get(chatId) || {};
    const selectedServices = getSelectedServices(state);
    if (!selectedServices.length) {
      await sendTelegramMessage(chatId, "Выберите хотя бы одну услугу.");
      await sendServiceCategories(chatId);
      return;
    }

    await sendDates(chatId, selectedServices);
    return;
  }

  if (data.startsWith("date:")) {
    const state = telegramDialogState.get(chatId) || {};
    const selectedServices = getSelectedServices(state);
    const date = data.slice(5);
    if (!selectedServices.length || !isDateSelectable(date)) {
      await sendTelegramMessage(chatId, "Дата уже недоступна. Выберите заново.", restartKeyboard());
      return;
    }

    state.date = date;
    telegramDialogState.set(chatId, state);
    await sendSlots(chatId, selectedServices, date);
    return;
  }

  if (data.startsWith("slot:")) {
    const state = telegramDialogState.get(chatId) || {};
    const selectedServices = getSelectedServices(state);
    const [, date, rawTime] = data.split(":");
    const time = rawTime ? rawTime.replace("-", ":") : "";
    if (!selectedServices.length || !date || !time) {
      await sendTelegramMessage(chatId, "Слот уже недоступен. Выберите заново.", restartKeyboard());
      return;
    }

    const totalDuration = getServicesDuration(selectedServices);
    const available = await isSlotAvailable(date, time, totalDuration);
    if (!available) {
      await sendTelegramMessage(chatId, "Это время только что заняли. Показываю актуальные свободные окна.");
      await sendSlots(chatId, selectedServices, date);
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
  const selectedServices = getSelectedServices(state);
  if (!selectedServices.length || !state.date || !state.time) {
    telegramDialogState.delete(chatId);
    await sendTelegramMessage(chatId, "Не хватает данных для записи. Давайте выберем услуги заново.", restartKeyboard());
    return;
  }

  const serviceTitles = selectedServices.map((service) => service.title);
  const serviceCategories = [...new Set(selectedServices.map((service) => service.category))];
  const totalPrice = getServicesPrice(selectedServices);
  const totalDuration = getServicesDuration(selectedServices);
  const startAt = buildDateTimeIso(state.date, state.time);
  const endAt = addMinutesIso(startAt, totalDuration);
  const appointment = {
    source: "telegram_bot",
    telegramChatId: String(chatId),
    clientName: state.name,
    clientPhone: state.phone,
    serviceId: selectedServices[0].id,
    serviceIds: selectedServices.map((service) => service.id),
    serviceTitle: serviceTitles.join(", "),
    serviceTitles,
    serviceCategory: serviceCategories.join(", "),
    serviceCategories,
    price: totalPrice,
    durationMinutes: totalDuration,
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
    message: `${serviceCategories.join(", ")}: ${serviceTitles.join(", ")}. Цена: ${formatRub(totalPrice)}. Длительность: ${totalDuration} мин.`,
    source: "telegram_bot",
    submittedAt: new Date().toISOString(),
  });
  telegramDialogState.delete(chatId);

  const userText = [
    "Запись создана.",
    "",
    `Услуги: ${serviceTitles.join(", ")}`,
    `Дата и время: ${formatDateRu(state.date)} ${state.time}`,
    `Длительность: ${totalDuration} мин.`,
    `Стоимость: ${formatRub(totalPrice)}`,
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

async function showServiceCategories(chatId, messageId) {
  const replyMarkup = {
    inline_keyboard: [
      [{ text: "Лазерная эпиляция", callback_data: "cat:laser" }],
      [{ text: "LPG-массаж", callback_data: "cat:lpg" }],
    ],
  };

  if (messageId) {
    await editTelegramMessage(chatId, messageId, "Выберите направление:", replyMarkup);
    return;
  }

  await sendTelegramMessage(chatId, "Выберите направление:", replyMarkup);
}

async function sendServices(chatId, state, messageId) {
  const category = state.category;
  const selectedIds = new Set(Array.isArray(state.selectedServiceIds) ? state.selectedServiceIds : []);
  const rows = services
    .filter((service) => service.category === category)
    .map((service) => [
      {
        text: `${selectedIds.has(service.id) ? "✓ " : ""}${service.title} - ${formatRub(service.price)}`,
        callback_data: `svc:${service.id}`,
      },
    ]);

  rows.push([{ text: "Добавить другое направление", callback_data: "choose_category" }]);
  rows.push([{ text: "Готово", callback_data: "services_done" }]);

  const selectedServices = getSelectedServices(state);
  const summary = selectedServices.length
    ? `\n\nВыбрано: ${selectedServices.map((service) => service.title).join(", ")}\nИтого: ${formatRub(
        getServicesPrice(selectedServices)
      )}, ${getServicesDuration(selectedServices)} мин.`
    : "";

  const text = `Выберите одну или несколько услуг.${summary}\n\nКогда закончите выбор, нажмите «Готово».`;
  if (messageId) {
    await editTelegramMessage(chatId, messageId, text, { inline_keyboard: rows });
    return;
  }

  await sendTelegramMessage(chatId, text, { inline_keyboard: rows });
}

async function sendDates(chatId, selectedServices) {
  const dates = getSelectableDates();
  const rows = chunk(
    dates.map((date) => ({
      text: formatShortDateRu(date),
      callback_data: `date:${date}`,
    })),
    1
  );

  await sendTelegramMessage(
    chatId,
    `${buildServicesSummary(selectedServices)}\n\nВыберите день:`,
    { inline_keyboard: rows }
  );
}

async function sendSlots(chatId, selectedServices, date) {
  const totalDuration = getServicesDuration(selectedServices);
  const slots = await getAvailableSlots(date, totalDuration);
  if (!slots.length) {
    await sendTelegramMessage(chatId, "На этот день свободных окон нет. Выберите другой день.", {
      inline_keyboard: [[{ text: "Выбрать дату", callback_data: "services_done" }]],
    });
    return;
  }

  const rows = chunk(
    slots.map((time) => ({
      text: `${formatDateWithWeekdayRu(date)}, ${time}`,
      callback_data: `slot:${date}:${time.replace(":", "-")}`,
    })),
    1
  );

  await sendTelegramMessage(chatId, `Свободное время на ${formatDateWithWeekdayRu(date)}:`, { inline_keyboard: rows });
}

async function notifyAppointmentTelegram(appointment) {
  if (!telegramChatId) return;
  const text = [
    "Новая запись из Telegram-бота",
    "",
    `Имя: ${appointment.clientName}`,
    `Телефон: ${appointment.clientPhone}`,
    `Услуги: ${appointment.serviceTitle}`,
    `Цена: ${formatRub(appointment.price)}`,
    `Дата и время: ${formatDateWithWeekdayRu(appointment.date)}, ${appointment.time}`,
    `Длительность: ${appointment.durationMinutes} мин.`,
  ].join("\n");

  try {
    await sendTelegramMessage(telegramChatId, text);
  } catch (error) {
    console.error("Telegram appointment notification error:", error.message);
  }
}

async function sendAdminMenu(chatId) {
  await sendTelegramMessage(chatId, "Администратор", {
    inline_keyboard: [
      [{ text: "Записи на сегодня", callback_data: "admin:today" }],
      [{ text: "Записи на завтра", callback_data: "admin:tomorrow" }],
      [{ text: "Все будущие записи", callback_data: "admin:future" }],
      [{ text: "Статистика за неделю", callback_data: "admin:week" }],
    ],
  });
}

async function handleAdminCallback(chatId, data) {
  if (data === "admin:menu") {
    await sendAdminMenu(chatId);
    return;
  }

  if (data === "admin:today") {
    await sendAdminAppointments(chatId, "Записи на сегодня", getDateKeyForOffset(0), getDateKeyForOffset(0));
    return;
  }

  if (data === "admin:tomorrow") {
    await sendAdminAppointments(chatId, "Записи на завтра", getDateKeyForOffset(1), getDateKeyForOffset(1));
    return;
  }

  if (data === "admin:future") {
    await sendFutureAppointments(chatId);
    return;
  }

  if (data === "admin:week") {
    await sendWeeklyStats(chatId);
    return;
  }

  if (data.startsWith("cancel:")) {
    await cancelAppointmentByAdmin(chatId, data.slice("cancel:".length));
  }
}

async function sendAdminAppointments(chatId, title, fromDate, toDate) {
  const rows = database
    .prepare(
      `
        SELECT * FROM appointments
        WHERE status != 'cancelled'
          AND appointment_date >= ?
          AND appointment_date <= ?
        ORDER BY start_at ASC
      `
    )
    .all(fromDate, toDate)
    .map(appointmentRowToObject);

  await sendAppointmentList(chatId, title, rows);
}

async function sendFutureAppointments(chatId) {
  const rows = database
    .prepare(
      `
        SELECT * FROM appointments
        WHERE status != 'cancelled'
          AND start_at >= ?
        ORDER BY start_at ASC
        LIMIT 30
      `
    )
    .all(new Date().toISOString())
    .map(appointmentRowToObject);

  await sendAppointmentList(chatId, "Все будущие записи", rows);
}

async function sendAppointmentList(chatId, title, rows) {
  if (!rows.length) {
    await sendTelegramMessage(chatId, `${title}\n\nЗаписей нет.`, adminBackKeyboard());
    return;
  }

  for (const appointment of rows) {
    await sendTelegramMessage(chatId, formatAdminAppointment(appointment), {
      inline_keyboard: [
        [{ text: "Отменить запись", callback_data: `cancel:${appointment.id}` }],
        [{ text: "Назад в админку", callback_data: "admin:menu" }],
      ],
    });
  }
}

async function sendWeeklyStats(chatId) {
  const fromDate = getDateKeyForOffset(-6);
  const toDate = getDateKeyForOffset(0);
  const rows = database
    .prepare(
      `
        SELECT * FROM appointments
        WHERE appointment_date >= ?
          AND appointment_date <= ?
        ORDER BY start_at ASC
      `
    )
    .all(fromDate, toDate)
    .map(appointmentRowToObject);

  const activeRows = rows.filter((item) => item.status !== "cancelled");
  const cancelledRows = rows.filter((item) => item.status === "cancelled");
  const totalAmount = activeRows.reduce((sum, item) => sum + Number(item.price || 0), 0);
  const cancelledAmount = cancelledRows.reduce((sum, item) => sum + Number(item.price || 0), 0);

  const lines = [
    `Статистика за неделю: ${formatDateRu(fromDate)} - ${formatDateRu(toDate)}`,
    "",
    `Всего записей: ${rows.length}`,
    `Активные/проведенные: ${activeRows.length}`,
    `Сумма работ: ${formatRub(totalAmount)}`,
    `Отмененные записи: ${cancelledRows.length}`,
    `Сумма отмененных: ${formatRub(cancelledAmount)}`,
    "",
    rows.length ? "Записи:" : "Записей за период нет.",
    ...rows.map((item) => `- ${formatDateWithWeekdayRu(item.date)}, ${item.time}: ${item.clientName || "-"}, ${item.serviceTitle || "-"}, ${formatRub(item.price)}${item.status === "cancelled" ? " (отменена)" : ""}`),
  ];

  await sendTelegramMessage(chatId, lines.join("\n").slice(0, 3900), adminBackKeyboard());
}

async function cancelAppointmentByAdmin(adminChatId, appointmentId) {
  const row = database.prepare("SELECT * FROM appointments WHERE id = ? LIMIT 1").get(appointmentId);
  if (!row) {
    await sendTelegramMessage(adminChatId, "Запись не найдена.", adminBackKeyboard());
    return;
  }

  const appointment = appointmentRowToObject(row);
  if (appointment.status === "cancelled") {
    await sendTelegramMessage(adminChatId, "Эта запись уже отменена.", adminBackKeyboard());
    return;
  }

  const cancelledAt = new Date().toISOString();
  database
    .prepare("UPDATE appointments SET status = 'cancelled', cancelled_at = ?, cancelled_by = ? WHERE id = ?")
    .run(cancelledAt, String(adminChatId), appointmentId);

  await sendTelegramMessage(adminChatId, `Запись отменена.\n\n${formatAdminAppointment({ ...appointment, status: "cancelled", cancelledAt })}`, adminBackKeyboard());

  if (appointment.telegramChatId) {
    try {
      await sendTelegramMessage(
        appointment.telegramChatId,
        [
          "Ваша запись отменена.",
          "",
          `Дата и время: ${formatDateWithWeekdayRu(appointment.date)}, ${appointment.time}`,
          `Услуги: ${appointment.serviceTitle || "-"}`,
          "Для новой записи нажмите /start.",
        ].join("\n")
      );
    } catch (error) {
      console.error("Telegram cancellation notification error:", error.message);
    }
  }
}

function formatAdminAppointment(appointment) {
  return [
    `${formatDateWithWeekdayRu(appointment.date)}, ${appointment.time}`,
    `Клиент: ${appointment.clientName || "-"}`,
    `Телефон: ${appointment.clientPhone || "-"}`,
    `Услуги: ${appointment.serviceTitle || "-"}`,
    `Длительность: ${appointment.durationMinutes || "-"} мин.`,
    `Сумма: ${formatRub(appointment.price)}`,
    `Статус: ${appointment.status || "active"}`,
  ].join("\n");
}

function adminBackKeyboard() {
  return { inline_keyboard: [[{ text: "Назад в админку", callback_data: "admin:menu" }]] };
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
        `${formatDateWithWeekdayRu(item.date)}, ${item.time} - ${item.clientName}, ${item.clientPhone}, ${item.serviceTitle}`
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

function getSelectedServices(state) {
  const ids = Array.isArray(state?.selectedServiceIds) ? state.selectedServiceIds : [];
  return ids.map((id) => getServiceById(id)).filter(Boolean);
}

function getServicesDuration(selectedServices) {
  return selectedServices.reduce((sum, service) => sum + Number(service.durationMinutes || 0), 0);
}

function getServicesPrice(selectedServices) {
  return selectedServices.reduce((sum, service) => sum + Number(service.price || 0), 0);
}

function buildServicesSummary(selectedServices) {
  return [
    `Услуги: ${selectedServices.map((service) => service.title).join(", ")}`,
    `Длительность: ${getServicesDuration(selectedServices)} мин.`,
    `Стоимость: ${formatRub(getServicesPrice(selectedServices))}`,
  ].join("\n");
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
  const weekday = value.toLocaleDateString("ru-RU", { weekday: "long" });
  const day = String(value.getDate()).padStart(2, "0");
  const month = String(value.getMonth() + 1).padStart(2, "0");
  return `${weekday} ${day}.${month}`;
}

function formatDateWithWeekdayRu(date) {
  return formatShortDateRu(date);
}

function formatRub(value) {
  return `${new Intl.NumberFormat("ru-RU").format(Number(value || 0))} ₽`;
}

function parseList(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function isTelegramAdmin(chatId) {
  return telegramAdminIds.includes(String(chatId));
}

function parseTimezoneOffsetMinutes(value) {
  const match = String(value || "+00:00").match(/^([+-])(\d{2}):(\d{2})$/);
  if (!match) return 0;
  const sign = match[1] === "-" ? -1 : 1;
  return sign * (Number(match[2]) * 60 + Number(match[3]));
}

function getDateKeyForOffset(dayOffset) {
  const offsetMinutes = parseTimezoneOffsetMinutes(bookingTimezoneOffset);
  const value = new Date(Date.now() + offsetMinutes * 60 * 1000);
  value.setUTCDate(value.getUTCDate() + dayOffset);
  return `${value.getUTCFullYear()}-${String(value.getUTCMonth() + 1).padStart(2, "0")}-${String(
    value.getUTCDate()
  ).padStart(2, "0")}`;
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

async function editTelegramMessage(chatId, messageId, text, replyMarkup) {
  await telegramApi("editMessageText", {
    chat_id: chatId,
    message_id: messageId,
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









