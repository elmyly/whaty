  const path = require("path");
const fs = require("fs");
const express = require("express");
const cors = require("cors");
const qrcode = require("qrcode");
const { EventEmitter } = require("events");
const { randomUUID } = require("crypto");
const { Client, LocalAuth, MessageMedia } = require("whatsapp-web.js");
const crypto = require("crypto");

const PORT = process.env.PORT || 3000;
const STATIC_DIR = __dirname;
const DATA_DIR = path.join(__dirname, "data");
const LISTS_FILE = path.join(DATA_DIR, "lists.json");
const USERS_FILE = path.join(DATA_DIR, "users.json");
const SESSIONS_DIR = path.join(__dirname, ".wa-session");
const MAX_LIST_SIZE = Number(process.env.MAX_LIST_SIZE || 10000);
const FREE_QUOTA = Number(process.env.FREE_QUOTA || 10);
const ADMIN_EMAIL = "elmylypro@gmail.com";

const SPEED_DELAYS = {
  slow: 5000,
  normal: 2000,
  fast: 350,
};

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

const sessionStates = new Map(); // key => state
const sessionEmitters = new Map(); // key => emitter
const inboxEmitter = new EventEmitter();
const inboxMessages = [];
let chatsCache = [];
const whatsappClients = new Map(); // key => client

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function readLists() {
  try {
    ensureDataDir();
    if (!fs.existsSync(LISTS_FILE)) {
      return [];
    }
    const content = fs.readFileSync(LISTS_FILE, "utf8");
    return JSON.parse(content);
  } catch (error) {
    console.warn("Could not read list store:", error.message);
    return [];
  }
}

function writeLists(lists) {
  ensureDataDir();
  fs.writeFileSync(LISTS_FILE, JSON.stringify(lists, null, 2));
}

function storeList(numbers, meta = {}) {
  const lists = readLists();
  const id = randomUUID();
  const entry = {
    id,
    numbers,
    meta: {
      ...meta,
      count: numbers.length,
      savedAt: new Date().toISOString(),
    },
  };
  lists.unshift(entry);
  const trimmed = lists.slice(0, Number(process.env.MAX_STORED_LISTS || 8));
  writeLists(trimmed);
  return entry;
}

function getListById(id) {
  if (!id) return null;
  const lists = readLists();
  return lists.find((item) => item.id === id) || null;
}

function getSessionState(key) {
  if (!sessionStates.has(key)) {
    sessionStates.set(key, {
      status: "starting",
      qr: null,
      qrExpiresAt: null,
      clientInfo: null,
      lastError: null,
      updatedAt: new Date().toISOString(),
    });
  }
  return sessionStates.get(key);
}

function updateSession(key, partial) {
  const current = getSessionState(key);
  const next = {
    ...current,
    ...partial,
    updatedAt: new Date().toISOString(),
  };
  sessionStates.set(key, next);
  const emitter = sessionEmitters.get(key);
  if (emitter) {
    emitter.emit("session:update", { ...next });
  }
}

function extractClientInfo(info) {
  if (!info) return null;
  return {
    pushname: info.pushname,
    wid: info.wid?._serialized,
    me: info.me?._serialized,
    platform: info.platform,
    phone: info.phone?.device_model,
  };
}

async function encodeQr(qr) {
  try {
    return await qrcode.toDataURL(qr, { width: 320, margin: 1 });
  } catch (error) {
    console.warn("Could not encode QR:", error.message);
    return null;
  }
}

function addInboxMessage(entry) {
  inboxMessages.unshift(entry);
  const max = Number(process.env.MAX_INBOX_MESSAGES || 60);
  if (inboxMessages.length > max) {
    inboxMessages.length = max;
  }
  inboxEmitter.emit("inbox:new", entry);
}

async function getLastMessageSafe(chat) {
  if (chat.lastMessage) return chat.lastMessage;
  try {
    const msgs = await chat.fetchMessages({ limit: 1 });
    return msgs && msgs[0] ? msgs[0] : null;
  } catch (error) {
    return null;
  }
}

function safeTimestamp(ts) {
  const date =
    typeof ts === "number"
      ? new Date(ts * 1000)
      : ts
      ? new Date(ts)
      : new Date();
  return isNaN(date.getTime()) ? new Date() : date;
}

function summarizeMessage(msg) {
  if (!msg) return null;
  if (msg.body) return msg.body;
  if (msg.type === "sticker") return "[Sticker]";
  if (msg.type === "audio") return "[Audio]";
  if (msg.type === "ptt") return "[Voice note]";
  return `[${msg.type || "message"}]`;
}

function readUsers() {
  try {
    ensureDataDir();
    if (!fs.existsSync(USERS_FILE)) {
      return [];
    }
    const content = fs.readFileSync(USERS_FILE, "utf8");
    return JSON.parse(content);
  } catch (error) {
    console.warn("Could not read users store:", error.message);
    return [];
  }
}

function writeUsers(users) {
  ensureDataDir();
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}

function getUserAndIndexById(id) {
  const users = readUsers();
  const index = users.findIndex((u) => u.id === id);
  return { users, index, user: index >= 0 ? users[index] : null };
}

function getQuotaInfo(user) {
  const limit = Number(user?.quotaLimit || FREE_QUOTA);
  const used = Number(user?.quotaUsed || 0);
  return { limit, used, remaining: Math.max(limit - used, 0) };
}

function requireUserById(id) {
  const { users, index, user } = getUserAndIndexById(id);
  if (!user) {
    const err = new Error("User not found for session.");
    err.code = "USER_NOT_FOUND";
    throw err;
  }
  return { users, index, user };
}

function requireAdmin(key) {
  const { user } = requireUserById(key);
  if (normalizeEmail(user.email) !== normalizeEmail(ADMIN_EMAIL)) {
    const err = new Error("Admin privileges required.");
    err.code = "FORBIDDEN";
    throw err;
  }
  return user;
}

function ensureQuota(user, needed = 1) {
  const { remaining, limit, used } = getQuotaInfo(user);
  if (remaining < needed) {
    const err = new Error(`No quota remaining. Free limit is ${limit} messages (used ${used}).`);
    err.code = "QUOTA_EXCEEDED";
    err.limit = limit;
    err.used = used;
    err.remaining = remaining;
    throw err;
  }
}

function consumeQuota(userId, count) {
  const { users, index, user } = requireUserById(userId);
  ensureQuota(user, count);
  const updated = {
    ...user,
    quotaLimit: user.quotaLimit || FREE_QUOTA,
    quotaUsed: Number(user.quotaUsed || 0) + count,
  };
  users[index] = updated;
  writeUsers(users);
  return getQuotaInfo(updated);
}

function normalizeEmail(email = "") {
  return email.trim().toLowerCase();
}

function hashPassword(raw = "") {
  return crypto.createHash("sha256").update(raw).digest("hex");
}

function ensureDefaultUser() {
  const users = readUsers();
  const email = "elmylypro@gmail.com";
  const existing = users.find((u) => normalizeEmail(u.email) === normalizeEmail(email));
  if (existing) return;
  const newUser = {
    id: randomUUID(),
    name: "Youssef El myly",
    email: normalizeEmail(email),
    role: "admin",
    passwordHash: hashPassword("faty@hyaty"),
    createdAt: new Date().toISOString(),
    quotaLimit: FREE_QUOTA,
    quotaUsed: 0,
  };
  users.push(newUser);
  writeUsers(users);
}

ensureDefaultUser();

async function serializeMessage(message) {
  const base = {
    id: message.id?._serialized || message.id,
    body: message.body,
    from: message.from,
    to: message.to,
    fromMe: message.fromMe,
    timestamp: safeTimestamp(message.timestamp).toISOString(),
    type: message.type,
  };

  if (
    (message.type === "sticker" || message.type === "audio" || message.type === "ptt") &&
    message.hasMedia
  ) {
    try {
      const media = await message.downloadMedia();
      if (media) {
        base.media = {
          data: media.data,
          mimetype: media.mimetype,
          filename: media.filename || `${message.type}.bin`,
        };
      }
    } catch (error) {
      base.mediaError = error.message;
    }
  }

  return base;
}

function mapChat(chat, lastMessage = null) {
  const lm = lastMessage || chat.lastMessage;
  const lastTimestamp = lm ? safeTimestamp(lm.timestamp).toISOString() : undefined;
  const name =
    chat.name ||
    chat.formattedTitle ||
    chat.pushname ||
    chat.contact?.pushname ||
    chat.contact?.name ||
    chat.id?.user;
  return {
    id: chat.id?._serialized || chat.id,
    name,
    isGroup: chat.isGroup,
    unreadCount: chat.unreadCount || 0,
    timestamp: lastTimestamp,
    lastMessage: summarizeMessage(lm),
  };
}

function buildClient() {
  throw new Error("Deprecated: use buildClientForKey(key) instead.");
}

function ensureSessionDir(key) {
  const dir = path.join(SESSIONS_DIR, key);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function ensureClientForKey(key) {
  let client = whatsappClients.get(key);
  if (!client) {
    client = buildClientForKey(key);
    whatsappClients.set(key, client);
  }
  return client;
}

function buildClientForKey(key) {
  const dataPath = ensureSessionDir(key);
  const client = new Client({
    authStrategy: new LocalAuth({
        dataPath,
    }),
    puppeteer: {
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    },
  });

  client.on("qr", async (qr) => {
    const qrData = await encodeQr(qr);
    updateSession(key, {
      status: "qr",
      qr: qrData,
      qrExpiresAt: Date.now() + 60 * 1000,
      lastError: null,
    });
  });

  client.on("loading_screen", (percent, message) => {
    updateSession(key, {
      status: "loading",
      lastError: null,
      meta: { percent, message },
    });
  });

  client.on("authenticated", () => {
    updateSession(key, {
      status: "authenticated",
      qr: null,
      qrExpiresAt: null,
      lastError: null,
    });
  });

  client.on("ready", () => {
    updateSession(key, {
      status: "connected",
      qr: null,
      qrExpiresAt: null,
      clientInfo: extractClientInfo(client.info),
      lastError: null,
    });
  });

  client.on("auth_failure", (message) => {
    updateSession(key, {
      status: "auth_failure",
      qr: null,
      qrExpiresAt: null,
      lastError: message,
    });
  });

  client.on("message", (message) => {
    const entry = {
      id: message.id?._serialized || randomUUID(),
      chatId: message.from,
      from: message.from,
      to: message.to,
      body: summarizeMessage(message),
      type: message.type,
      fromMe: message.fromMe,
      timestamp: message.timestamp
        ? new Date(message.timestamp * 1000).toISOString()
        : new Date().toISOString(),
      sessionKey: key,
    };
    addInboxMessage(entry);
  });

  client.on("message_ack", async (message) => {
    try {
      const chat = await message.getChat();
      if (chat) {
        const mapped = mapChat(chat);
        const existingIndex = chatsCache.findIndex((c) => c.id === mapped.id);
        if (existingIndex >= 0) {
          chatsCache[existingIndex] = mapped;
        } else {
          chatsCache.push(mapped);
        }
      }
    } catch (error) {
      // ignore
    }
  });

  client.on("disconnected", (reason) => {
    updateSession(key, {
      status: "disconnected",
      qr: null,
      qrExpiresAt: null,
      clientInfo: null,
      lastError: reason,
    });
    setTimeout(() => {
      const current = whatsappClients.get(key);
      if (current === client) client.initialize();
    }, 5000);
  });

  client.initialize();
  return client;
}

async function restartWhatsAppClient(key) {
  updateSession(key, {
    status: "restarting",
    qr: null,
    qrExpiresAt: null,
  });

  const existing = whatsappClients.get(key);
  if (existing) {
    try {
      await existing.destroy();
    } catch (error) {
      console.warn(`Failed to destroy WhatsApp client for ${key}:`, error.message);
    }
  }

  const client = buildClientForKey(key);
  whatsappClients.set(key, client);
  return client;
}

function requireReadyClient() {
  throw new Error("Deprecated: use requireReadyClientFor(key).");
}

function getClientForKey(key) {
  return whatsappClients.get(key) || null;
}

function requireReadyClientFor(key) {
  const client = getClientForKey(key);
  if (!client) {
    const err = new Error("WhatsApp client not initialised yet.");
    err.code = "SESSION_NOT_READY";
    throw err;
  }
  const state = getSessionState(key);
  if (state.status !== "connected") {
    const err = new Error("WhatsApp session is not connected.");
    err.code = "SESSION_NOT_READY";
    throw err;
  }
  return client;
}

function parsePhone(input) {
  if (!input) throw new Error("Phone number is required.");
  let digits = input.replace(/[^\d]/g, "");
  if (digits.startsWith("00")) {
    digits = digits.slice(2);
  }
  if (digits.startsWith("0") && digits.length > 8) {
    // Remove leading zero for local formats (expects country code)
    digits = digits.replace(/^0+/, "");
  }
  if (digits.length < 8) {
    throw new Error(
      "Phone number must include the international country code (example: +2126...)."
    );
  }
  return { digits, e164: `+${digits}` };
}

async function resolveChatId(input) {
  throw new Error("Deprecated: use resolveChatIdFor(key, input).");
}

async function resolveChatIdFor(key, input) {
  const whatsappClient = requireReadyClientFor(key);
  const { digits, e164 } = parsePhone(input);
  const numberInfo = await whatsappClient.getNumberId(digits);
  if (!numberInfo) {
    const err = new Error(`Number ${e164} is not registered on WhatsApp.`);
    err.code = "NOT_WHATSAPP_USER";
    throw err;
  }
  return { chatId: numberInfo._serialized, e164 };
}

async function buildMedia({ mediaUrl, media }) {
  if (media && media.data && media.mimetype) {
    return new MessageMedia(media.mimetype, media.data, media.filename || "file");
  }
  if (!mediaUrl) return null;
  try {
    const fetched = await MessageMedia.fromUrl(mediaUrl);
    return fetched;
  } catch (error) {
    const err = new Error(`Failed to fetch media: ${error.message}`);
    err.code = "MEDIA_FETCH_FAILED";
    throw err;
  }
}

async function sendSingleMessageFor(key, { phone, message, tag, fromName, mediaUrl, media }) {
  const { user } = requireUserById(key);
  ensureQuota(user, 1);
  const whatsappClient = requireReadyClientFor(key);
  const { chatId, e164 } = await resolveChatIdFor(key, phone);
  const parts = [];
  if (tag) {
    parts.push(`[${tag}]`);
  }
  parts.push(message);
  if (fromName) {
    parts.push(`\n\n- ${fromName}`);
  }
  const finalMessage = parts.join(" ");
  const mediaPayload = await buildMedia({ mediaUrl, media });
  if (mediaPayload) {
    await whatsappClient.sendMessage(chatId, mediaPayload, {
      caption: finalMessage,
    });
  } else {
    await whatsappClient.sendMessage(chatId, finalMessage);
  }
  const quota = consumeQuota(key, 1);
  return { phone: e164, chatId, message: finalMessage, media: !!mediaPayload, quota };
}

async function sendReplyFor(key, { chatId, phone, message, mediaUrl, media }) {
  const { user } = requireUserById(key);
  ensureQuota(user, 1);
  const whatsappClient = requireReadyClientFor(key);
  let targetChatId = chatId;
  if (!targetChatId && phone) {
    const resolved = await resolveChatIdFor(key, phone);
    targetChatId = resolved.chatId;
  }
  if (!targetChatId) {
    throw new Error("chatId or phone is required to send a reply.");
  }
  const mediaPayload = await buildMedia({ mediaUrl, media });
  if (mediaPayload) {
    await whatsappClient.sendMessage(targetChatId, mediaPayload, {
      caption: message,
    });
  } else {
    await whatsappClient.sendMessage(targetChatId, message);
  }
  const quota = consumeQuota(key, 1);
  return { chatId: targetChatId, media: !!mediaPayload, quota };
}

async function sendBulkMessagesFor(key, { numbers, message, fromName, speed = "normal", tag, mediaUrl }) {
  const { user } = requireUserById(key);
  const quotaSnapshot = getQuotaInfo(user);
  if (quotaSnapshot.remaining < numbers.length) {
    const err = new Error(
      `No quota remaining. Free limit is ${quotaSnapshot.limit} messages (used ${quotaSnapshot.used}).`
    );
    err.code = "QUOTA_EXCEEDED";
    err.limit = quotaSnapshot.limit;
    err.used = quotaSnapshot.used;
    err.remaining = quotaSnapshot.remaining;
    throw err;
  }
  requireReadyClientFor(key);
  const delay = SPEED_DELAYS[speed] || SPEED_DELAYS.normal;
  const report = [];
  let lastQuota = quotaSnapshot;

  for (const phone of numbers) {
    const entry = { phone };
    try {
      const result = await sendSingleMessageFor(key, {
        phone,
        message,
        fromName,
        tag,
        mediaUrl,
      });
      entry.status = "sent";
      entry.message = result.message;
      entry.chatId = result.chatId;
      entry.media = result.media || false;
      if (result.quota) {
        lastQuota = result.quota;
      }
    } catch (error) {
      entry.status = "failed";
      entry.error = error.message;
    }
    report.push(entry);
    if (delay > 0) {
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  const { user: refreshedUser } = requireUserById(key);
  return { report, quota: getQuotaInfo(refreshedUser) };
}

function getSessionKey(req) {
  const headerKey = (req.headers["x-user-session"] || "").toString().trim();
  const queryKey = (req.query.sessionKey || "").toString().trim();
  const key = headerKey || queryKey;
  if (!key) {
    const err = new Error("Missing session key (x-user-session or ?sessionKey=).");
    err.code = "SESSION_KEY_MISSING";
    throw err;
  }
  return key;
}

app.get("/api/health", (req, res) => {
  res.json({ status: "ok" });
});

app.get("/api/session", (req, res) => {
  try {
    const key = getSessionKey(req);
    ensureClientForKey(key);
    res.json(getSessionState(key));
  } catch (error) {
    const status = error.code === "SESSION_KEY_MISSING" ? 400 : 500;
    res.status(status).json({ message: error.message });
  }
});

app.get("/api/session/qr", (req, res) => {
  try {
    const key = getSessionKey(req);
    ensureClientForKey(key);
    const state = getSessionState(key);
    if (state.qr) {
      return res.json({
        qr: state.qr,
        expiresAt: state.qrExpiresAt,
      });
    }
    return res.status(404).json({
      message: "No QR code available. Session might already be authenticated.",
    });
  } catch (error) {
    const status = error.code === "SESSION_KEY_MISSING" ? 400 : 500;
    res.status(status).json({ message: error.message });
  }
});

app.get("/api/session/events", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  let key;
  try {
    key = getSessionKey(req);
    ensureClientForKey(key);
  } catch (error) {
    res.write(`data: ${JSON.stringify({ message: error.message })}\n\n`);
    return res.end();
  }

  const state = getSessionState(key);
  res.write(`data: ${JSON.stringify(state)}\n\n`);

  let emitter = sessionEmitters.get(key);
  if (!emitter) {
    emitter = new EventEmitter();
    sessionEmitters.set(key, emitter);
  }

  const listener = (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`);
  emitter.on("session:update", listener);

  req.on("close", () => {
    emitter.off("session:update", listener);
  });
});

app.get("/api/inbox", (req, res) => {
  try {
    const key = getSessionKey(req);
    const limit = Number(req.query.limit || 50);
    const filtered = inboxMessages.filter((m) => m.sessionKey === key).slice(0, limit);
    res.json({ messages: filtered });
  } catch (error) {
    const status = error.code === "SESSION_KEY_MISSING" ? 400 : 500;
    res.status(status).json({ message: error.message });
  }
});

app.get("/api/chats", async (req, res) => {
  try {
    const key = getSessionKey(req);
    const client = requireReadyClientFor(key);
    const chats = await client.getChats();
    const mapped = [];
    for (const chat of chats) {
      const lastMessage = await getLastMessageSafe(chat);
      mapped.push(mapChat(chat, lastMessage));
    }
    chatsCache = mapped;
    res.json({ chats: mapped });
  } catch (error) {
    const status = error.code === "SESSION_NOT_READY" ? 409 : 500;
    res.status(status).json({ message: error.message });
  }
});

app.get("/api/chats/:id/messages", async (req, res) => {
  try {
    const key = getSessionKey(req);
    const client = requireReadyClientFor(key);
    const limit = Number(req.query.limit || 40);
    const chat = await client.getChatById(req.params.id);
    if (!chat) {
      return res.status(404).json({ message: "Chat not found" });
    }
    const messages = await chat.fetchMessages({ limit });
    const mapped = [];
    for (const m of messages) {
      mapped.push(await serializeMessage(m));
    }
    res.json({ messages: mapped, chat: mapChat(chat, mapped[0]) });
  } catch (error) {
    const status = error.code === "SESSION_NOT_READY" ? 409 : 500;
    res.status(status).json({ message: error.message });
  }
});

app.get("/api/inbox/events", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  let key;
  try {
    key = getSessionKey(req);
  } catch (error) {
    res.write(`data: ${JSON.stringify({ message: error.message })}\n\n`);
    return res.end();
  }

  const listener = (entry) => {
    if (entry.sessionKey === key) {
      res.write(`data: ${JSON.stringify(entry)}\n\n`);
    }
  };

  inboxEmitter.on("inbox:new", listener);
  req.on("close", () => {
    inboxEmitter.off("inbox:new", listener);
  });
});

app.post("/api/session/restart", async (req, res) => {
  try {
    const key = getSessionKey(req);
    await restartWhatsAppClient(key);
    res.json({ ok: true, status: getSessionState(key).status });
  } catch (error) {
    const status = error.code === "SESSION_KEY_MISSING" ? 400 : 500;
    res.status(status).json({ message: error.message });
  }
});

app.post("/api/session/logout", async (req, res) => {
  let key;
  try {
    key = getSessionKey(req);
  } catch (error) {
    return res.status(400).json({ message: error.message });
  }

  const client = whatsappClients.get(key);
  if (!client) {
    return res.status(200).json({ ok: true, message: "No active client." });
  }

  try {
    await client.logout();
  } catch (error) {
    console.warn(`Logout failed for ${key}:`, error.message);
  }

  try {
    await restartWhatsAppClient(key);
  } catch (error) {
    console.warn(`Restart after logout failed for ${key}:`, error.message);
  }

  res.json({ ok: true });
});

app.post("/api/messages/send", async (req, res) => {
  const { phone, message, tag, fromName, mediaUrl, media } = req.body || {};
  if (!phone || !message) {
    return res
      .status(400)
      .json({ message: "Phone and message are required fields." });
  }

  try {
    const key = getSessionKey(req);
    const result = await sendSingleMessageFor(key, {
      phone,
      message,
      tag,
      fromName,
      mediaUrl,
      media,
    });
    res.json({
      ok: true,
      result,
      quota: result.quota || getQuotaInfo(requireUserById(key).user),
    });
  } catch (error) {
    const status =
      error.code === "SESSION_NOT_READY"
        ? 409
        : error.code === "QUOTA_EXCEEDED"
        ? 403
        : error.code === "USER_NOT_FOUND"
        ? 401
        : 500;
    res.status(status).json({
      message: error.message,
      quota:
        error.code === "QUOTA_EXCEEDED" ? getQuotaInfo(requireUserById(getSessionKey(req)).user) : undefined,
    });
  }
});

app.post("/api/messages/reply", async (req, res) => {
  const { chatId, phone, message, mediaUrl, media } = req.body || {};
  if ((!chatId && !phone) || !message) {
    return res
      .status(400)
      .json({ message: "chatId or phone and message are required." });
  }
  try {
    const key = getSessionKey(req);
    const result = await sendReplyFor(key, { chatId, phone, message, mediaUrl, media });
    res.json({ ok: true, result, quota: result.quota || getQuotaInfo(requireUserById(key).user) });
  } catch (error) {
    const status =
      error.code === "SESSION_NOT_READY"
        ? 409
        : error.code === "QUOTA_EXCEEDED"
        ? 403
        : error.code === "USER_NOT_FOUND"
        ? 401
        : 500;
    res.status(status).json({
      message: error.message,
      quota:
        error.code === "QUOTA_EXCEEDED" ? getQuotaInfo(requireUserById(getSessionKey(req)).user) : undefined,
    });
  }
});

app.post("/api/messages/bulk", async (req, res) => {
  const { message, fromName, speed, tag, listId, numbers, mediaUrl, media } =
    req.body || {};
  if (!message) {
    return res.status(400).json({ message: "Message template is required." });
  }

  let recipients = Array.isArray(numbers) ? numbers : [];
  if (listId) {
    const stored = getListById(listId);
    if (!stored) {
      return res.status(404).json({ message: "List not found." });
    }
    recipients = stored.numbers;
  }

  if (!recipients.length) {
    return res
      .status(400)
      .json({ message: "At least one recipient is required." });
  }

  try {
    const key = getSessionKey(req);
    const { report, quota } = await sendBulkMessagesFor(key, {
      numbers: recipients,
      message,
      fromName,
      speed,
      tag,
      mediaUrl,
      media,
    });
    const success = report.filter((entry) => entry.status === "sent").length;
    res.json({
      ok: true,
      total: recipients.length,
      success,
      failed: report.length - success,
      report,
      quota,
    });
  } catch (error) {
    const status =
      error.code === "SESSION_NOT_READY"
        ? 409
        : error.code === "QUOTA_EXCEEDED"
        ? 403
        : error.code === "USER_NOT_FOUND"
        ? 401
        : 500;
    res.status(status).json({
      message: error.message,
      quota:
        error.code === "QUOTA_EXCEEDED" ? getQuotaInfo(requireUserById(getSessionKey(req)).user) : undefined,
    });
  }
});

app.post("/api/lists/import", (req, res) => {
  const { numbers, meta } = req.body || {}; 
  if (!Array.isArray(numbers) || !numbers.length) {
    return res.status(400).json({ message: "numbers array is required." });
  }
  if (numbers.length > MAX_LIST_SIZE) {
    return res.status(400).json({
      message: `List too large. Max supported size is ${MAX_LIST_SIZE}.`,
    });
  }

  const sanitizedNumbers = numbers
    .map((number) => (typeof number === "string" ? number.trim() : ""))
    .filter(Boolean);

  const entry = storeList(sanitizedNumbers, meta);
  res.json({ ok: true, id: entry.id, meta: entry.meta });
});

app.get("/api/lists/:id", (req, res) => {
  const list = getListById(req.params.id);
  if (!list) {
    return res.status(404).json({ message: "List not found." });
  }
  res.json(list);
});

app.post("/api/credits/buy", (req, res) => {
  const { pack } = req.body || {};
  let increment = 0;
  if (pack === "small") increment = 50;
  else if (pack === "medium") increment = 200;
  else if (pack === "large") increment = 1000;
  else {
    return res.status(400).json({ message: "Invalid credit pack." });
  }

  try {
    const key = getSessionKey(req);
    const { users, index, user } = requireUserById(key);
    const currentLimit = Number(user.quotaLimit || FREE_QUOTA);
    const updated = {
      ...user,
      quotaLimit: currentLimit + increment,
    };
    users[index] = updated;
    writeUsers(users);
    res.json({ ok: true, quota: getQuotaInfo(updated) });
  } catch (error) {
    const status =
      error.code === "SESSION_KEY_MISSING"
        ? 400
        : error.code === "USER_NOT_FOUND"
        ? 401
        : 500;
    res.status(status).json({ message: error.message });
  }
});

app.get("/api/admin/users", (req, res) => {
  try {
    const key = getSessionKey(req);
    requireAdmin(key);
    const users = readUsers().map((u) => ({
      id: u.id,
      name: u.name,
      email: u.email,
      role: u.role,
      quotaLimit: Number(u.quotaLimit || FREE_QUOTA),
      quotaUsed: Number(u.quotaUsed || 0),
    }));
    res.json({ ok: true, users });
  } catch (error) {
    const status =
      error.code === "SESSION_KEY_MISSING"
        ? 400
        : error.code === "USER_NOT_FOUND"
        ? 401
        : error.code === "FORBIDDEN"
        ? 403
        : 500;
    res.status(status).json({ message: error.message });
  }
});

app.post("/api/admin/users/quota", (req, res) => {
  const { userId, addCredits, quotaLimit, quotaUsed } = req.body || {};
  if (!userId) {
    return res.status(400).json({ message: "userId is required." });
  }
  try {
    const key = getSessionKey(req);
    requireAdmin(key);
    const { users, index, user } = requireUserById(userId);
    const next = { ...user };
    const parsedLimit =
      typeof quotaLimit === "number" ? quotaLimit : quotaLimit !== undefined ? Number(quotaLimit) : undefined;
    const parsedUsed =
      typeof quotaUsed === "number" ? quotaUsed : quotaUsed !== undefined ? Number(quotaUsed) : undefined;
    const parsedAdd =
      typeof addCredits === "number" ? addCredits : addCredits !== undefined ? Number(addCredits) : undefined;
    if (!isNaN(parsedLimit)) {
      next.quotaLimit = parsedLimit;
    }
    if (!isNaN(parsedUsed)) {
      next.quotaUsed = parsedUsed;
    }
    if (!isNaN(parsedAdd)) {
      next.quotaLimit = Number(next.quotaLimit || 0) + parsedAdd;
    }
    users[index] = next;
    writeUsers(users);
    res.json({ ok: true, quota: getQuotaInfo(next) });
  } catch (error) {
    const status =
      error.code === "SESSION_KEY_MISSING"
        ? 400
        : error.code === "USER_NOT_FOUND"
        ? 404
        : error.code === "FORBIDDEN"
        ? 403
        : 500;
    res.status(status).json({ message: error.message });
  }
});

app.delete("/api/admin/users/:id", (req, res) => {
  const userId = req.params.id;
  try {
    const key = getSessionKey(req);
    requireAdmin(key);
    const { users, index, user } = requireUserById(userId);
    if (!user) {
      return res.status(404).json({ message: "User not found." });
    }
    users.splice(index, 1);
    writeUsers(users);
    res.json({ ok: true });
  } catch (error) {
    const status =
      error.code === "SESSION_KEY_MISSING"
        ? 400
        : error.code === "USER_NOT_FOUND"
        ? 404
        : error.code === "FORBIDDEN"
        ? 403
        : 500;
    res.status(status).json({ message: error.message });
  }
});

app.post("/api/auth/login", (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ message: "Email and password are required." });
  }
  const users = readUsers();
  const normalized = normalizeEmail(email);
  const user = users.find((u) => normalizeEmail(u.email) === normalized);
  if (!user || user.passwordHash !== hashPassword(password)) {
    return res.status(401).json({ message: "Invalid credentials." });
  }
  const quota = getQuotaInfo(user);
  res.json({
    ok: true,
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      quotaLimit: quota.limit,
      quotaUsed: quota.used,
    },
  });
});

app.get("/api/auth/me", (req, res) => {
  try {
    const key = getSessionKey(req);
    const { user } = requireUserById(key);
    const quota = getQuotaInfo(user);
    res.json({
      ok: true,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        quotaLimit: quota.limit,
        quotaUsed: quota.used,
      },
    });
  } catch (error) {
    const status =
      error.code === "SESSION_KEY_MISSING"
        ? 400
        : error.code === "USER_NOT_FOUND"
        ? 401
        : 500;
    res.status(status).json({ message: error.message });
  }
});

app.post("/api/auth/signup", (req, res) => {
  const { name, email, password } = req.body || {};
  if (!name || !email || !password) {
    return res
      .status(400)
      .json({ message: "Name, email, and password are required." });
  }
  if (password.length < 8) {
    return res.status(400).json({ message: "Password must be at least 8 characters." });
  }

  const normalizedEmail = normalizeEmail(email);
  const users = readUsers();
  const existing = users.find((u) => normalizeEmail(u.email) === normalizedEmail);
  if (existing) {
    return res.status(409).json({ message: "An account with this email already exists." });
  }

  const user = {
    id: randomUUID(),
    name: name.trim(),
    email: normalizedEmail,
    role: "user",
    passwordHash: hashPassword(password),
    createdAt: new Date().toISOString(),
    quotaLimit: FREE_QUOTA,
    quotaUsed: 0,
  };

  users.push(user);
  writeUsers(users);

  res.json({
    ok: true,
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      quotaLimit: FREE_QUOTA,
      quotaUsed: 0,
    },
  });
});

// Serve main HTML pages directly so npm start opens the UI and all links work
const PAGE_ROUTES = [
  "index",
  "dashboard",
  "bulk",
  "compose",
  "connect",
  "upload",
  "send-log",
  "inbox",
  "credits",
  "admin",
];
PAGE_ROUTES.forEach((page) => {
  const routePath = page === "index" ? "/" : `/${page}`;
  const filePath = path.join(STATIC_DIR, `${page}.html`);
  app.get(routePath, (req, res) => res.sendFile(filePath));
});

app.use(express.static(STATIC_DIR));

app.listen(PORT, () => {
  console.log(`WhatsApp marketing dashboard running at http://localhost:${PORT}`);
});
