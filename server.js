const http = require("http");
const https = require("https");
const net = require("net");
const tls = require("tls");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");

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
const sessionTtlMs = 1000 * 60 * 60 * 24;
const sessions = new Map();

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

async function saveRequest(item) {
  const data = await loadRequests();
  data.push({
    id: crypto.randomUUID(),
    ...item,
  });
  await fsp.writeFile(requestsFilePath, JSON.stringify(data, null, 2), "utf8");
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
            resolve();
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
          resolve();
          return;
        }
        reject(new Error(`Telegram API failed via proxy: ${statusLine2}`));
      });
    });
  });
}
function sendJson(response, statusCode, body) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(body));
}









