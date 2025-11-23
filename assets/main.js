
// Small helper: toast notifications
function showToast(message, options = {}) {
  const container = document.getElementById("toast-container");
  if (!container) return;

  const toast = document.createElement("div");
  toast.className = "toast" + (options.type === "danger" ? " toast-danger" : "");
  toast.innerHTML = `
    <span>${message}</span>
    <button class="toast-close" aria-label="Close">&times;</button>
  `;

  toast.querySelector(".toast-close").addEventListener("click", () => {
    toast.remove();
  });

  container.appendChild(toast);

  setTimeout(() => {
    toast.remove();
  }, options.duration || 4200);
}

// Theme toggle (simple body data attribute)
(function themeSetup() {
  const btn = document.getElementById("btn-toggle-theme");
  if (!btn) return;

  const stored = localStorage.getItem("wa_theme") || "dark";
  document.documentElement.dataset.theme = stored;

  btn.addEventListener("click", () => {
    const current = document.documentElement.dataset.theme || "dark";
    const next = current === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    localStorage.setItem("wa_theme", next);
    showToast(`Switched to ${next} theme`, { type: "info" });
  });
})();

// Highlight active nav item
(function navHighlight() {
  const pageId = document.body.dataset.page;
  const links = document.querySelectorAll(".nav-link");
  links.forEach((link) => {
    const navId = link.getAttribute("data-nav");
    if (navId === pageId) {
      link.classList.add("active");
    }
  });
})();

const BULK_LOG_STORAGE_KEY = "wa_bulk_send_log";
const BULK_LOG_LIMIT = 300;

function readStoredBulkLogs() {
  try {
    const raw = localStorage.getItem(BULK_LOG_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed;
    return [];
  } catch (error) {
    console.warn("Could not read bulk log storage:", error);
    return [];
  }
}

function persistBulkLogs(entries = []) {
  try {
    const trimmed = entries.slice(-BULK_LOG_LIMIT);
    localStorage.setItem(BULK_LOG_STORAGE_KEY, JSON.stringify(trimmed));
  } catch (error) {
    console.warn("Could not persist bulk log:", error);
  }
}

function addBulkLogEntry(entry) {
  if (!entry) return;
  const current = readStoredBulkLogs();
  current.push({
    ...entry,
    timestamp: entry.timestamp || Date.now(),
  });
  persistBulkLogs(current);
}

function clearBulkLogStorage() {
  try {
    localStorage.removeItem(BULK_LOG_STORAGE_KEY);
  } catch (error) {
    console.warn("Could not clear bulk log:", error);
  }
}

function formatLogTimestamp(ts) {
  if (!ts) return "";
  try {
    const d = new Date(ts);
    return d.toLocaleString();
  } catch (error) {
    return "";
  }
}

// Backend helpers + session watcher
const API_BASE = window.__WA_API_BASE__ || "";
const sessionListeners = [];
let latestSessionState = null;
let sessionWatcherStarted = false;
let sessionEventSource = null;
let sessionKey = null; // per-user session key (user id)
let cachedUser = null;

function readStoredUser() {
  if (cachedUser) return cachedUser;
  try {
    const raw = localStorage.getItem("wr:user");
    cachedUser = raw ? JSON.parse(raw) : null;
    return cachedUser;
  } catch (error) {
    return null;
  }
}

function setStoredUser(user) {
  cachedUser = user || null;
  if (!user) {
    localStorage.removeItem("wr:user");
  } else {
    localStorage.setItem("wr:user", JSON.stringify(user));
  }
}

function buildApiUrl(path = "/") {
  if (/^https?:\/\//i.test(path)) {
    return path;
  }
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  if (!API_BASE) return normalizedPath;
  return `${API_BASE.replace(/\/$/, "")}${normalizedPath}`;
}

async function apiRequest(path, options = {}) {
  const url = buildApiUrl(path);
  if (!sessionKey) {
    const stored = readStoredUser();
    sessionKey = stored?.id || null;
  }
  const headers = {
    "Content-Type": "application/json",
    ...(options.headers || {}),
  };
  if (sessionKey) {
    headers["x-user-session"] = sessionKey;
  }
  const opts = {
    method: options.method || "GET",
    headers,
    ...options,
  };
  if (opts.body && typeof opts.body !== "string") {
    opts.body = JSON.stringify(opts.body);
  }
  const response = await fetch(url, opts);
  const text = await response.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch (error) {
      data = text;
    }
  }
  if (!response.ok) {
    const message =
      (data && data.message) || `Request failed (${response.status})`;
    throw new Error(message);
  }
  return data;
}

const SESSION_LABELS = {
  connected: "Connected",
  qr: "Waiting for QR",
  starting: "Starting",
  restarting: "Restarting",
  loading: "Loading session",
  authenticated: "Authenticated",
  disconnected: "Disconnected",
  auth_failure: "Auth failed",
};

function formatSessionStatus(status) {
  if (!status) return "Unknown";
  return SESSION_LABELS[status] || status;
}

function renderSidebarUser() {
  try {
    const user = readStoredUser();
    sessionKey = user?.id || null;
    const isAdmin = user && user.email && user.email.toLowerCase() === "elmylypro@gmail.com";
    const nameEl = document.querySelector(".sidebar-user-name");
    const roleEl = document.querySelector(".sidebar-user-role");
    const footer = document.querySelector(".sidebar-footer");
    const sessionBlock = document.querySelector(".session-status");
    let quotaBlock = document.querySelector(".sidebar-quota");
    let quotaEl = document.querySelector(".sidebar-user-quota");
    const avatarEl = document.querySelector(".sidebar-user-avatar");
    if (!user || !user.name) return;
    if (nameEl) nameEl.textContent = user.name;
    if (roleEl && user.role) roleEl.textContent = user.role;
    // Ensure a prominent quota block at top of sidebar footer
    if (!quotaBlock && footer) {
      quotaBlock = document.createElement("div");
      quotaBlock.className = "sidebar-quota";
      quotaBlock.style.display = "flex";
      quotaBlock.style.alignItems = "center";
      quotaBlock.style.justifyContent = "space-between";
      quotaBlock.style.fontSize = "14px";
      quotaBlock.style.fontWeight = "700";
      quotaBlock.style.padding = "10px 12px";
      quotaBlock.style.borderRadius = "12px";
      quotaBlock.style.background = "#ecfdf3";
      quotaBlock.style.marginBottom = "10px";
      quotaBlock.style.color = "#16a34a";
      quotaBlock.innerHTML = `<span class="sidebar-user-quota">--/-- left</span>`;
      if (sessionBlock) {
        footer.insertBefore(quotaBlock, sessionBlock);
      } else {
        footer.insertBefore(quotaBlock, footer.firstChild);
      }
      quotaEl = quotaBlock.querySelector(".sidebar-user-quota");
    }
    if (!quotaEl) {
      const parent = roleEl ? roleEl.parentElement : document.querySelector(".sidebar-user-info");
      if (parent) {
        quotaEl = document.createElement("div");
        quotaEl.className = "sidebar-user-quota";
        quotaEl.style.fontSize = "12px";
        quotaEl.style.color = "#9ca3af";
        parent.appendChild(quotaEl);
      }
    }
    if (quotaEl) {
      const limit = user.quotaLimit ?? 10;
      const used = user.quotaUsed ?? 0;
      const remaining = Math.max(limit - used, 0);
      quotaEl.textContent = `Quota: ${remaining}/${limit} left`;
      if (quotaBlock) {
        quotaBlock.style.background = remaining > 0 ? "#ecfdf3" : "#fee2e2";
        quotaBlock.style.color = remaining > 0 ? "#16a34a" : "#b91c1c";
      }
    }
    if (avatarEl) {
      const initials = user.name
        .split(" ")
        .filter(Boolean)
        .slice(0, 2)
        .map((part) => part[0].toUpperCase())
        .join("");
      avatarEl.textContent = initials || "U";
    }

    // Admin nav link toggle
    const adminLink = document.querySelector('.nav-link[data-nav="admin"]');
    if (adminLink) {
      adminLink.style.display = isAdmin ? "flex" : "none";
    }
  } catch (error) {
    // ignore parsing errors
  }
}

function updateSessionUI(state = {}) {
  const labelTopbar = document.getElementById("topbar-session-label");
  const labelSidebar = document.getElementById("sidebar-session-label");
  const dotSidebar = document.getElementById("sidebar-session-dot");
  const statSession = document.getElementById("stat-session-status");
  const dashStatus = document.getElementById("dash-session-status");
  const dashClient = document.getElementById("dash-session-client");
  const dashConnectedAs = document.getElementById("dash-connected-as");
  const statusText = formatSessionStatus(state.status);
  const isOnline = state.status === "connected";

  if (labelTopbar) labelTopbar.textContent = statusText;
  if (labelSidebar) labelSidebar.textContent = statusText;
  if (dotSidebar) {
    dotSidebar.classList.toggle("online", isOnline);
  }
  if (statSession) {
    statSession.textContent = statusText;
  }
  if (dashStatus) {
    dashStatus.textContent = statusText;
  }
  if (dashClient) {
    const info = state.clientInfo;
    if (info && (info.pushname || info.phone || info.platform)) {
      const parts = [];
      if (info.pushname) parts.push(info.pushname);
      if (info.phone) parts.push(info.phone);
      if (info.platform) parts.push(info.platform);
      dashClient.textContent = parts.join(" • ") || "—";
    } else {
      dashClient.textContent = "—";
    }
  }
  if (dashConnectedAs) {
    const info = state.clientInfo;
    const rawId = info?.wid || info?.me;
    const parsedNumber = rawId ? rawId.split("@")[0] : null;
    dashConnectedAs.textContent =
      isOnline && parsedNumber ? `Connected as ${parsedNumber}` : "Connected as —";
  }
}

function notifySession(state) {
  latestSessionState = state;
  updateSessionUI(state);
  sessionListeners.forEach((listener) => {
    try {
      listener(state);
    } catch (error) {
      console.warn("Session listener failed:", error);
    }
  });
}

function subscribeToSession(listener) {
  if (typeof listener !== "function") return;
  sessionListeners.push(listener);
  if (latestSessionState) {
    listener(latestSessionState);
  }
}

async function startSessionWatcher() {
  if (sessionWatcherStarted) return;
  sessionWatcherStarted = true;

  try {
    const initial = await apiRequest("/api/session");
    if (initial) {
      notifySession(initial);
    }
  } catch (error) {
    console.warn("Unable to fetch session:", error);
  }

  const connectEventStream = () => {
    const url = buildApiUrl(`/api/session/events${sessionKey ? `?sessionKey=${encodeURIComponent(sessionKey)}` : ""}`);
    try {
      const es = new EventSource(url);
      sessionEventSource = es;
      es.onmessage = (event) => {
        try {
          const payload = JSON.parse(event.data);
          notifySession(payload);
        } catch (parseError) {
          console.warn("Invalid session payload:", parseError);
        }
      };
      es.onerror = () => {
        es.close();
        setTimeout(connectEventStream, 5000);
      };
    } catch (error) {
      console.warn("Failed to connect to session events:", error);
      setTimeout(connectEventStream, 5000);
    }
  };

  connectEventStream();
}

window.addEventListener("beforeunload", () => {
  if (sessionEventSource) {
    sessionEventSource.close();
  }
});


// Page specific logic boot
document.addEventListener("DOMContentLoaded", () => {
  initializeUserContext();
});

function initializeUserContext() {
  if (!sessionKey) {
    const user = readStoredUser();
    sessionKey = user?.id || null;
  }
  refreshCurrentUserFromServer();
  renderSidebarUser();
  startSessionWatcher();

  const pageId = document.body.dataset.page;
  if (pageId === "connect") {
    setupConnectPage();
  } else if (pageId === "upload") {
    setupUploadPage();
  } else if (pageId === "compose") {
    setupComposePage();
  } else if (pageId === "bulk") {
    setupBulkPage();
  } else if (pageId === "inbox") {
    setupInboxPage();
  } else if (pageId === "send-log") {
    setupSendLogPage();
  } else if (pageId === "credits") {
    setupCreditsPage();
  } else if (pageId === "admin") {
    setupAdminPage();
  }
}

async function fileToMediaPayload(fileInput) {
  if (!fileInput || !fileInput.files || !fileInput.files.length) return null;
  const file = fileInput.files[0];
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const base64 = reader.result.split(",")[1];
      resolve({
        data: base64,
        mimetype: file.type || "application/octet-stream",
        filename: file.name,
      });
    };
    reader.onerror = () =>
      reject(new Error("Could not read file for upload."));
    reader.readAsDataURL(file);
  });
}

// ---------- CONNECT PAGE ----------

function setupConnectPage() {
  const qrImage = document.getElementById("qr-image");
  const qrEmptyState = document.getElementById("qr-empty-state");
  const qrEmptyTitle = document.getElementById("qr-empty-title");
  const qrEmptySubtitle = document.getElementById("qr-empty-subtitle");
  const qrPlaceholder = document.getElementById("qr-placeholder");
  const btnRestart = document.getElementById("btn-generate-qr");
  const btnLogout = document.getElementById("btn-logout-session");
  const statusLabel = document.getElementById("connect-session-status");
  const expiresLabel = document.getElementById("qr-expires-label");
  const clientLabel = document.getElementById("qr-client-label");

  if (!btnRestart) return;

  let qrTimer = null;

  function setExpiryTimer(expiresAt, state) {
    if (!expiresLabel) return;
    clearInterval(qrTimer);
    if (!expiresAt) {
      expiresLabel.textContent =
        state && ["connected", "authenticated"].includes(state.status)
          ? "—"
          : "--";
      return;
    }
    const target = Number(expiresAt);
    const update = () => {
      const diff = Math.floor((target - Date.now()) / 1000);
      if (diff <= 0) {
        expiresLabel.textContent = "Expired";
        clearInterval(qrTimer);
        return;
      }
      expiresLabel.textContent = `${diff}s`;
    };
    update();
    qrTimer = setInterval(update, 1000);
  }

  function renderSession(state = {}) {
    if (statusLabel) {
      statusLabel.textContent = formatSessionStatus(state.status);
    }
    if (clientLabel) {
      const clientText =
        state.clientInfo?.pushname ||
        state.clientInfo?.wid ||
        state.clientInfo?.me ||
        "—";
      clientLabel.textContent = clientText;
    }

    if (state.qr && qrImage) {
      qrImage.hidden = false;
      qrImage.src = state.qr;
      if (qrEmptyState) qrEmptyState.hidden = true;
      if (qrPlaceholder) qrPlaceholder.classList.add("has-qr");
    } else {
      if (qrImage) qrImage.hidden = true;
      if (qrPlaceholder) qrPlaceholder.classList.remove("has-qr");
      if (qrEmptyState) {
        qrEmptyState.hidden = false;
        if (qrEmptyTitle && qrEmptySubtitle) {
          if (state.status === "connected") {
            qrEmptyTitle.textContent = "Session active";
            qrEmptySubtitle.textContent =
              "You're connected. QR hidden for safety.";
          } else if (state.status === "auth_failure") {
            qrEmptyTitle.textContent = "Authentication failed";
            qrEmptySubtitle.textContent = "Restart session to refresh the QR.";
          } else if (state.status === "loading" || state.status === "starting") {
            qrEmptyTitle.textContent = "Booting session";
            qrEmptySubtitle.textContent = "Waiting for whatsapp-web.js...";
          } else {
            qrEmptyTitle.textContent = "Awaiting QR";
            qrEmptySubtitle.textContent = "Restart to generate a new code.";
          }
        }
      }
    }

    setExpiryTimer(state.qr ? state.qrExpiresAt : null, state);
  }

  subscribeToSession(renderSession);

  btnRestart.addEventListener("click", async () => {
    btnRestart.disabled = true;
    try {
      await apiRequest("/api/session/restart", { method: "POST" });
      showToast("Restarted session. Waiting for QR...", { type: "info" });
    } catch (error) {
      showToast(error.message, { type: "danger" });
    } finally {
      btnRestart.disabled = false;
    }
  });

  if (btnLogout) {
    btnLogout.addEventListener("click", async () => {
      btnLogout.disabled = true;
      try {
        await apiRequest("/api/session/logout", { method: "POST" });
        showToast("Logged out from WhatsApp session.");
      } catch (error) {
        showToast(error.message, { type: "danger" });
      } finally {
        btnLogout.disabled = false;
      }
    });
  }
}

// ---------- UPLOAD PAGE ----------

const LIST_KEY = "wa_phone_list";
const LIST_META_KEY = "wa_phone_list_meta";

function readStoredList() {
  try {
    const numbers = JSON.parse(localStorage.getItem(LIST_KEY) || "[]");
    const meta = JSON.parse(
      localStorage.getItem(LIST_META_KEY) ||
        JSON.stringify({ name: "Untitled list", count: numbers.length })
    );
    return { numbers, meta };
  } catch (error) {
    return { numbers: [], meta: { name: "Untitled list", count: 0 } };
  }
}

function saveList(numbers, meta) {
  localStorage.setItem(LIST_KEY, JSON.stringify(numbers));
  localStorage.setItem(LIST_META_KEY, JSON.stringify(meta));
}

function setupUploadPage() {
  const form = document.getElementById("upload-form");
  const fileInput = document.getElementById("phone-file-input");
  const defaultPrefixInput = document.getElementById("default-country-code");
  const listNameInput = document.getElementById("list-name-input");
  const statsLabel = document.getElementById("upload-stats-label");
  const previewList = document.getElementById("preview-list");
  const previewCount = document.getElementById("preview-count");
  const previewInvalidCount = document.getElementById("preview-invalid-count");
  const btnClear = document.getElementById("btn-clear-list");

  if (!form || !fileInput) return;

  function parseFileContent(content, defaultPrefix) {
    const lines = content.split(/\r?\n/);
    const valid = [];
    let invalidCount = 0;

    lines.forEach((line) => {
      const raw = line.trim();
      if (!raw) return;

      let cleaned = raw.replace(/[^\d+]/g, "");

      if (!cleaned.startsWith("+") && defaultPrefix) {
        cleaned = defaultPrefix + cleaned.replace(/^0+/, "");
      }

      if (cleaned.startsWith("00")) {
        cleaned = `+${cleaned.slice(2)}`;
      }

      const digitsCount = cleaned.replace(/\D/g, "").length;
      if (digitsCount >= 8) {
        valid.push(cleaned);
      } else {
        invalidCount += 1;
      }
    });

    return { valid, invalidCount };
  }

  function renderPreview(numbers, invalidCount) {
    previewList.innerHTML = "";
    numbers.slice(0, 100).forEach((number, index) => {
      const li = document.createElement("li");
      li.className = "preview-item";
      li.innerHTML = `
        <span class="index">#${index + 1}</span>
        <span class="number">${number}</span>
      `;
      previewList.appendChild(li);
    });
    previewCount.textContent = numbers.length;
    previewInvalidCount.textContent = invalidCount;
  }

  function loadExisting() {
    const { numbers, meta } = readStoredList();
    if (numbers.length) {
      renderPreview(numbers, 0);
      statsLabel.textContent = `Loaded ${numbers.length} numbers from previous session.`;
      if (!listNameInput.value) listNameInput.value = meta.name || "";
    }
  }

  async function syncListWithBackend(numbers, meta) {
    try {
      const payload = {
        numbers,
        meta: {
          name: meta.name,
          createdAt: meta.createdAt,
          count: meta.count,
        },
      };
      const response = await apiRequest("/api/lists/import", {
        method: "POST",
        body: payload,
      });
      const nextMeta = {
        ...meta,
        serverId: response?.id,
        syncedAt: response?.meta?.savedAt,
      };
      saveList(numbers, nextMeta);
      if (statsLabel) {
        statsLabel.textContent = `Synced ${numbers.length} numbers with backend.`;
      }
      showToast(`Synced ${numbers.length} numbers with backend.`, {
        type: "info",
      });
    } catch (error) {
      if (statsLabel) {
        statsLabel.textContent = `Saved locally. Backend sync failed: ${error.message}`;
      }
      showToast(`Saved locally but backend sync failed: ${error.message}`, {
        type: "danger",
      });
    }
  }

  loadExisting();

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    if (!fileInput.files || !fileInput.files.length) {
      showToast("Please choose a .txt file first.", { type: "danger" });
      return;
    }

    const file = fileInput.files[0];
    if (!file.name.toLowerCase().endsWith(".txt")) {
      showToast("Only .txt files are allowed.", { type: "danger" });
      return;
    }

    const reader = new FileReader();
    reader.onload = function (event) {
      const content = event.target.result;
      const defaultPrefixValue = defaultPrefixInput.value.trim();
      let defaultPrefix = defaultPrefixValue;
      if (defaultPrefix) {
        const digits = defaultPrefixValue.replace(/[^\d]/g, "");
        if (!digits) {
          defaultPrefix = "";
        } else {
          defaultPrefix = defaultPrefixValue.startsWith("+")
            ? `+${digits}`
            : `+${digits}`;
        }
      }
      const parsed = parseFileContent(content, defaultPrefix);
      if (!parsed.valid.length) {
        showToast("No valid numbers found in file.", { type: "danger" });
        return;
      }
      renderPreview(parsed.valid, parsed.invalidCount);

      const listMeta = {
        name: listNameInput.value.trim() || "Uploaded list",
        createdAt: new Date().toISOString(),
        count: parsed.valid.length,
      };
      saveList(parsed.valid, listMeta);
      statsLabel.textContent = `Parsed ${parsed.valid.length} numbers, ${parsed.invalidCount} invalid. Syncing with backend...`;
      syncListWithBackend(parsed.valid, listMeta);
    };

    reader.readAsText(file);
  });

  if (btnClear) {
    btnClear.addEventListener("click", () => {
      localStorage.removeItem(LIST_KEY);
      localStorage.removeItem(LIST_META_KEY);
      previewList.innerHTML = "";
      previewCount.textContent = "0";
      previewInvalidCount.textContent = "0";
      statsLabel.textContent = "List cleared.";
      showToast("Local list cleared.");
    });
  }
}

// ---------- COMPOSE PAGE ----------

function setupComposePage() {
  const form = document.getElementById("single-send-form");
  const phoneInput = document.getElementById("single-phone-input");
  const tagInput = document.getElementById("single-tag-input");
  const messageInput = document.getElementById("single-message-input");
  const mediaFileInput = document.getElementById("single-media-file");
  const btnTestUser = document.getElementById("btn-load-test-user");

  if (!form) return;

  if (btnTestUser) {
    btnTestUser.addEventListener("click", () => {
      phoneInput.value = "+212612345678";
      tagInput.value = "VIP customer";
      messageInput.value =
        "Salam {{name}} 👋 Just a quick follow‑up to confirm your order #{{order_id}}. Reply here if you have any question.";
    });
  }

  const submitBtn = form.querySelector('button[type="submit"]');

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const phone = phoneInput.value.trim();
    const tag = tagInput.value.trim();
    const message = messageInput.value.trim();
    let media = null;

    if (!phone || !message) {
      showToast("Please provide both phone and message.", { type: "danger" });
      return;
    }

    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.dataset.originalText = submitBtn.textContent;
      submitBtn.textContent = "Sending...";
    }

    try {
      media = await fileToMediaPayload(mediaFileInput);
      const resp = await apiRequest("/api/messages/send", {
        method: "POST",
        body: { phone, message, tag, media },
      });
      if (resp?.quota) {
        updateStoredUserQuota(resp.quota);
      }
      showToast(`Message sent to ${phone}.`);
      form.reset();
    } catch (error) {
      showToast(`Send failed: ${error.message}`, { type: "danger" });
    } finally {
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.textContent = submitBtn.dataset.originalText || "📤 Send message";
      }
    }
  });
}

// ---------- BULK PAGE ----------

function setupBulkPage() {
  const form = document.getElementById("bulk-form");
  const titleInput = document.getElementById("bulk-campaign-title");
  const fromInput = document.getElementById("bulk-from-name");
  const speedSelect = document.getElementById("bulk-speed-select");
  const messageInput = document.getElementById("bulk-message-input");
  const mediaFileInput = document.getElementById("bulk-media-file");
  const logBody = document.getElementById("bulk-log-body");
  const listNameLabel = document.getElementById("bulk-list-name");
  const recipientCountLabel = document.getElementById("bulk-recipient-count");
  const btnDryRun = document.getElementById("btn-bulk-dry-run");
  const sendLogNavLink = document.querySelector('.nav-link[data-nav="send-log"]');

  if (!form) return;

  if (sendLogNavLink) {
    sendLogNavLink.addEventListener("click", (e) => {
      e.preventDefault();
      window.open("send-log.html", "_blank", "noopener");
    });
  }

  let numbers = [];
  let meta = { name: "Untitled list", count: 0 };

  function loadList() {
    const stored = readStoredList();
    numbers = stored.numbers;
    meta = stored.meta;
    listNameLabel.textContent = meta.name || "Untitled list";
    recipientCountLabel.textContent = numbers.length.toString();
  }

  function renderPendingPreview(limit = 20) {
    if (!logBody) return;
    logBody.innerHTML = "";
    if (!numbers.length) {
      logBody.innerHTML =
        '<tr><td colspan="4" style="text-align:center;">No recipients loaded.</td></tr>';
      return;
    }
    numbers.slice(0, limit).forEach((phone, index) => {
      const row = document.createElement("tr");
      row.dataset.phone = phone;
      row.innerHTML = `
        <td>${index + 1}</td>
        <td class="phone-cell">${phone}</td>
        <td><span class="status-pill pending">Pending</span></td>
        <td>Ready</td>
      `;
      logBody.appendChild(row);
    });
  }

  function ensureRow(phone, index) {
    if (!logBody) return null;
    let row = logBody.querySelector(`tr[data-phone="${phone}"]`);
    if (row) return row;
    row = document.createElement("tr");
    row.dataset.phone = phone;
    row.innerHTML = `
      <td>${index + 1}</td>
      <td class="phone-cell">${phone}</td>
      <td><span class="status-pill pending">Pending</span></td>
      <td>Pending</td>
    `;
    logBody.appendChild(row);
    return row;
  }

  function updateLogRow(phone, status, info, index = 0) {
    if (!logBody) return;
    const row = ensureRow(phone, index);
    if (!row) return;
    const statusCell = row.querySelector(".status-pill");
    const infoCell = row.querySelector("td:last-child");
    if (statusCell) {
      statusCell.classList.remove("pending", "success", "danger");
      if (status === "sent") {
        statusCell.classList.add("success");
        statusCell.textContent = "Sent";
      } else if (status === "failed") {
        statusCell.classList.add("danger");
        statusCell.textContent = "Failed";
      } else {
        statusCell.classList.add("pending");
        statusCell.textContent = "Pending";
      }
    }
    if (infoCell) {
      infoCell.textContent = info || (status === "sent" ? "OK" : "Pending");
    }
  }

  loadList();
  renderPendingPreview(100);

  if (btnDryRun) {
    btnDryRun.addEventListener("click", () => {
      if (!numbers.length) {
        showToast("No phone list found. Upload a list first.", {
          type: "danger",
        });
        return;
      }
      renderPendingPreview();
      const campaignTitle =
        titleInput.value.trim() || "Untitled campaign";
      const listName = meta.name || "Untitled list";
      numbers.slice(0, 20).forEach((phone, idx) =>
        addBulkLogEntry({
          phone,
          status: "pending",
          info: "Dry run preview",
          campaign: campaignTitle,
          listName,
          index: idx + 1,
        })
      );
      showToast("Dry run saved to Send Log for the first 20 recipients.");
    });
  }

  const submitBtn = form.querySelector('button[type="submit"]');

  function delayMs(speed) {
    if (speed === "slow") return 5000;
    if (speed === "fast") return 350;
    return 2000;
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!numbers.length) {
      showToast("No phone list found. Upload a list first.", { type: "danger" });
      return;
    }

    const title = titleInput.value.trim();
    const fromName = fromInput.value.trim();
    const message = messageInput.value.trim();
    const speed = speedSelect.value;
    const media = await fileToMediaPayload(mediaFileInput);

    if (!title || !message) {
      showToast("Please fill campaign title and message template.", {
        type: "danger",
      });
      return;
    }

    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.dataset.originalText = submitBtn.textContent;
      submitBtn.textContent = "Sending...";
    }

    const listName = meta.name || "Untitled list";
    const campaignTitle = title || "Untitled campaign";
    let sent = 0;
    let failed = 0;
    const delay = delayMs(speed);
    let quotaExceeded = false;

    numbers.forEach((phone, idx) => ensureRow(phone, idx));

    for (let i = 0; i < numbers.length; i++) {
      if (quotaExceeded) break;
      const phone = numbers[i];
      updateLogRow(phone, "pending", "Sending...", i);
      try {
        const resp = await apiRequest("/api/messages/send", {
          method: "POST",
          body: {
            phone,
            message,
            fromName,
            tag: title,
            media,
          },
        });
        if (resp?.quota) {
          updateStoredUserQuota(resp.quota);
        }
        sent += 1;
        updateLogRow(phone, "sent", media ? "Sent with media" : "Sent", i);
        addBulkLogEntry({
          phone,
          status: "sent",
          info: media ? "Sent with media" : "Sent",
          campaign: campaignTitle,
          listName,
          index: i + 1,
        });
      } catch (error) {
        failed += 1;
        updateLogRow(phone, "failed", error.message, i);
        if (/quota/i.test(error.message || "")) {
          quotaExceeded = true;
        }
        addBulkLogEntry({
          phone,
          status: "failed",
          info: error.message,
          campaign: campaignTitle,
          listName,
          index: i + 1,
        });
      }
      if (quotaExceeded) {
        updateLogRow(phone, "failed", "Quota reached. Stopping.", i);
        break;
      }
      if (delay > 0) {
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }

    if (quotaExceeded) {
      showToast(
        `Bulk send stopped. Sent: ${sent}, Failed: ${failed}. Quota reached.`,
        { type: "danger" }
      );
    } else {
      showToast(`Bulk send finished. Sent: ${sent}, Failed: ${failed}.`);
    }

    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.textContent = submitBtn.dataset.originalText || "🚀 Launch campaign";
    }
  });
}

// ---------- SEND LOG PAGE ----------

function setupSendLogPage() {
  const logBody = document.getElementById("send-log-body");
  const btnRefresh = document.getElementById("btn-refresh-log");
  const btnClear = document.getElementById("btn-clear-log");

  if (!logBody) return;

  function renderLog() {
    const entries = readStoredBulkLogs().slice().reverse();
    logBody.innerHTML = "";

    if (!entries.length) {
      logBody.innerHTML =
        '<tr><td colspan="4" style="text-align:center;">No log entries yet.</td></tr>';
      return;
    }

    entries.forEach((entry, index) => {
      const status = entry.status || "pending";
      const statusClass =
        status === "sent" ? "success" : status === "failed" ? "danger" : "pending";
      const infoParts = [];
      if (entry.info) infoParts.push(entry.info);
      if (entry.campaign) infoParts.push(`Campaign: ${entry.campaign}`);
      if (entry.listName) infoParts.push(`List: ${entry.listName}`);
      const timeText = formatLogTimestamp(entry.timestamp);
      if (timeText) infoParts.push(timeText);
      const infoText = infoParts.join(" • ") || "—";

      const row = document.createElement("tr");
      row.innerHTML = `
        <td>${entries.length - index}</td>
        <td class="phone-cell">${entry.phone || "—"}</td>
        <td><span class="status-pill ${statusClass}">${status === "sent" ? "Sent" : status === "failed" ? "Failed" : "Pending"}</span></td>
        <td>${infoText}</td>
      `;
      logBody.appendChild(row);
    });
  }

  renderLog();

  if (btnRefresh) {
    btnRefresh.addEventListener("click", () => {
      renderLog();
      showToast("Log refreshed.");
    });
  }

  if (btnClear) {
    btnClear.addEventListener("click", () => {
      clearBulkLogStorage();
      renderLog();
      showToast("Send log cleared.");
    });
  }
}

// ---------- INBOX PAGE ----------

function setupInboxPage() {
  const listEl = document.getElementById("inbox-list");
  const threadEl = document.getElementById("inbox-thread");
  const countChip = document.getElementById("inbox-count-chip");
  const activeRecipient = document.getElementById("inbox-active-recipient");
  const replyForm = document.getElementById("inbox-reply-form");
  const replyChatId = document.getElementById("reply-chat-id");
  const replyMessage = document.getElementById("reply-message");
  const replyMediaFile = document.getElementById("reply-media-file");
  const replyStatus = document.getElementById("reply-status-label");

  if (!listEl || !threadEl || !replyForm) return;

  let chats = [];
  let currentChat = null;
  let inboxEventSource = null;

  function ensureInboxSkeletonStyles() {
    if (document.getElementById("inbox-skeleton-styles")) return;
    const style = document.createElement("style");
    style.id = "inbox-skeleton-styles";
    style.textContent = `
      @keyframes inbox-shimmer {
        0% { background-position: -200px 0; }
        100% { background-position: 200px 0; }
      }
      .inbox-skel {
        background: linear-gradient(90deg, #eceff1 0px, #f5f5f5 40px, #eceff1 80px);
        background-size: 200px 100%;
        animation: inbox-shimmer 1.2s ease-in-out infinite;
        border-radius: 12px;
      }
      .inbox-skel.list {
        height: 62px;
        margin-bottom: 10px;
      }
      .inbox-skel.thread {
        height: 56px;
        margin-bottom: 12px;
      }
    `;
    document.head.appendChild(style);
  }

  function showListLoadingPlaceholders() {
    ensureInboxSkeletonStyles();
    listEl.innerHTML = "";
    for (let i = 0; i < 6; i += 1) {
      const div = document.createElement("div");
      div.className = "inbox-skel list";
      listEl.appendChild(div);
    }
  }

  function showThreadLoadingPlaceholders() {
    ensureInboxSkeletonStyles();
    threadEl.innerHTML = "";
    for (let i = 0; i < 4; i += 1) {
      const div = document.createElement("div");
      div.className = "inbox-skel thread";
      threadEl.appendChild(div);
    }
  }

  function updateCount() {
    if (countChip) {
      countChip.textContent = `${chats.length} conversations`;
    }
  }

  function renderThread(messages = []) {
    threadEl.innerHTML = "";
    if (!messages.length) {
      threadEl.innerHTML =
        '<div class="inbox-empty">No messages yet. Select a chat.</div>';
      return;
    }
    messages.forEach((msg) => {
      const bubble = document.createElement("div");
      bubble.className = `inbox-bubble ${msg.fromMe ? "me" : "them"}`;
      let timeLabel = "";
      if (msg.timestamp) {
        const d = new Date(msg.timestamp);
        if (!isNaN(d.getTime())) {
          timeLabel = d.toLocaleTimeString();
        }
      }
      let contentHtml = msg.body || "(no text)";
      if (msg.media && msg.media.data && msg.media.mimetype) {
        const src = `data:${msg.media.mimetype};base64,${msg.media.data}`;
        if (msg.type === "sticker") {
          contentHtml = `<div class="inbox-media"><img src="${src}" alt="sticker" /></div>`;
        } else if (msg.type === "audio" || msg.type === "ptt") {
          contentHtml = `<audio controls src="${src}"></audio>`;
        }
      }
      bubble.innerHTML = `
        <div class="inbox-bubble-body">${contentHtml}</div>
        <div class="inbox-bubble-meta">${timeLabel}</div>
      `;
      threadEl.appendChild(bubble);
    });
    threadEl.scrollTop = threadEl.scrollHeight;
  }

  function selectChat(chat) {
    currentChat = chat;
    if (replyChatId) replyChatId.value = chat.id;
    if (activeRecipient) {
      activeRecipient.textContent = chat.name || chat.id;
    }
    listEl.querySelectorAll(".inbox-item").forEach((item) => {
      item.classList.toggle("active", item.dataset.chatId === chat.id);
    });
    loadMessages(chat.id);
  }

  async function renderChats() {
    listEl.innerHTML = "";
    chats.forEach((chat) => {
      const div = document.createElement("div");
      div.className = "inbox-item";
      div.dataset.chatId = chat.id;
      div.innerHTML = `
        <div class="inbox-meta">
          <span>${chat.name || chat.id}</span>
          ${chat.unreadCount ? `<span class="chip">🔔 ${chat.unreadCount} new</span>` : ""}
        </div>
        <div class="inbox-body">${chat.lastMessage || ""}</div>
      `;
      div.addEventListener("click", () => selectChat(chat));
      listEl.appendChild(div);
    });
    updateCount();
    if (chats.length && !currentChat) {
      selectChat(chats[0]);
    }
  }

  async function loadChats() {
    try {
      showListLoadingPlaceholders();
      const data = await apiRequest("/api/chats");
      if (data && Array.isArray(data.chats)) {
        chats = data.chats;
        renderChats();
      }
    } catch (error) {
      showToast(`Failed to load chats: ${error.message}`, { type: "danger" });
      listEl.innerHTML =
        '<div class="inbox-empty">Connect session to load conversations.</div>';
    }
  }

  async function loadMessages(chatId) {
    try {
      showThreadLoadingPlaceholders();
      const data = await apiRequest(`/api/chats/${encodeURIComponent(chatId)}/messages?limit=40`);
      renderThread(data?.messages || []);
    } catch (error) {
      showToast(`Failed to load messages: ${error.message}`, { type: "danger" });
      renderThread([]);
    }
  }

  function startInboxEvents() {
    const url = buildApiUrl(
      `/api/inbox/events${sessionKey ? `?sessionKey=${encodeURIComponent(sessionKey)}` : ""}`
    );
    try {
      inboxEventSource = new EventSource(url);
      inboxEventSource.onmessage = async (event) => {
        try {
          const payload = JSON.parse(event.data);
          const chatId = payload.chatId || payload.from;
          const existing = chats.find((c) => c.id === chatId);
          if (existing) {
            existing.lastMessage = payload.body;
            existing.unreadCount = (existing.unreadCount || 0) + 1;
          } else {
            chats.unshift({
              id: chatId,
              name: payload.from,
              unreadCount: 1,
              lastMessage: payload.body,
            });
          }
          renderChats();
          if (currentChat && currentChat.id === chatId) {
            loadMessages(chatId);
          }
        } catch (err) {
          console.warn("Invalid inbox payload", err);
        }
      };
      inboxEventSource.onerror = () => {
        inboxEventSource.close();
        setTimeout(startInboxEvents, 5000);
      };
    } catch (error) {
      console.warn("Inbox events connection failed", error);
    }
  }

  replyForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!replyChatId.value || !replyMessage.value.trim()) {
      showToast("Select a conversation and type a message.", { type: "danger" });
      return;
    }
    const btn = replyForm.querySelector('button[type="submit"]');
    if (btn) {
      btn.disabled = true;
      btn.dataset.originalText = btn.textContent;
      btn.textContent = "Sending...";
    }
    try {
      const media = await fileToMediaPayload(replyMediaFile);
      const resp = await apiRequest("/api/messages/reply", {
        method: "POST",
        body: {
          chatId: replyChatId.value,
          message: replyMessage.value.trim(),
          media,
        },
      });
      if (resp?.quota) {
        updateStoredUserQuota(resp.quota);
      }
      replyMessage.value = "";
      if (replyMediaFile) replyMediaFile.value = "";
      if (replyStatus) replyStatus.textContent = "Sent ✓";
      showToast("Reply sent.");
      loadMessages(replyChatId.value);
    } catch (error) {
      if (replyStatus) replyStatus.textContent = error.message;
      showToast(`Reply failed: ${error.message}`, { type: "danger" });
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = btn.dataset.originalText || "📩 Send reply";
      }
    }
  });

  window.addEventListener("beforeunload", () => {
    if (inboxEventSource) inboxEventSource.close();
  });

  loadChats();
  startInboxEvents();
}
function updateStoredUserQuota(quota) {
  if (!quota) return;
  try {
    const user = readStoredUser();
    if (!user) return;
    user.quotaLimit = quota.limit ?? user.quotaLimit;
    user.quotaUsed = quota.used ?? user.quotaUsed;
    setStoredUser(user);
    renderSidebarUser();
  } catch (error) {
    // ignore
  }
}

async function refreshCurrentUserFromServer() {
  try {
    const resp = await apiRequest("/api/auth/me");
    if (resp?.user) {
      setStoredUser(resp.user);
      renderSidebarUser();
    }
  } catch (error) {
    // If the user no longer exists or session is invalid, sign out.
    setStoredUser(null);
    sessionKey = null;
    window.location.replace("signin.html");
  }
}

// ---------- CREDITS PAGE ----------

function setupCreditsPage() {
  // Packs are informational only; purchases go through admin contact.
}

// ---------- ADMIN PAGE ----------

function setupAdminPage() {
  const tableBody = document.getElementById("admin-users-body");
  const searchInput = document.getElementById("admin-search");
  if (!tableBody) return;

  let cachedUsers = [];

  function applyFilter() {
    const term = (searchInput?.value || "").toLowerCase().trim();
    if (!term) return cachedUsers;
    return cachedUsers.filter(
      (u) =>
        (u.name && u.name.toLowerCase().includes(term)) ||
        (u.email && u.email.toLowerCase().includes(term))
    );
  }

  function renderUsers(users = []) {
    tableBody.innerHTML = "";
    if (!users.length) {
      tableBody.innerHTML = '<tr><td colspan="6" style="text-align:center;">No users found.</td></tr>';
      return;
    }
    users.forEach((u) => {
      const limit = Number(u.quotaLimit || 0);
      const used = Number(u.quotaUsed || 0);
      const remaining = Math.max(limit - used, 0);
      const initials = (u.name || u.email || "U")
        .split(" ")
        .filter(Boolean)
        .slice(0, 2)
        .map((p) => p[0].toUpperCase())
        .join("");
      const roleBadge =
        (u.role || "").toLowerCase() === "admin"
          ? '<span class="admin-role-badge admin">👑 Admin</span>'
          : '<span class="admin-role-badge">👤 User</span>';
      const tr = document.createElement("tr");
      tr.dataset.userId = u.id;
      tr.innerHTML = `
        <td>
          <div class="admin-user-cell">
            <div class="admin-user-avatar">${initials || "🙂"}</div>
            <div class="admin-user-meta">
              <div class="admin-user-name">${u.name || "—"}</div>
              <div class="admin-user-email">✉️ ${u.email}</div>
            </div>
          </div>
        </td>
        <td>${roleBadge}</td>
        <td><input type="number" min="0" class="admin-quota-limit input" value="${limit}" /></td>
        <td><input type="number" min="0" class="admin-quota-used input" value="${used}" /></td>
        <td class="admin-quota-remaining">${remaining}</td>
        <td>
          <div style="display:flex; gap:6px; flex-wrap: wrap;">
            <button class="btn btn-primary btn-xs admin-save">Save</button>
            <button class="btn btn-ghost btn-xs admin-delete" style="color:#b91c1c; border-color:#fecdd3;">Delete</button>
          </div>
        </td>
      `;
      tableBody.appendChild(tr);
    });
  }

  async function refresh() {
    tableBody.innerHTML = '<tr><td colspan="6" style="text-align:center;">Loading...</td></tr>';
    try {
      const suffix = sessionKey ? `?sessionKey=${encodeURIComponent(sessionKey)}` : "";
      const resp = await apiRequest(`/api/admin/users${suffix}`);
      cachedUsers = resp.users || [];
      renderUsers(applyFilter());
    } catch (error) {
      tableBody.innerHTML = `<tr><td colspan="6" style="text-align:center; color:#b91c1c;">${error.message}</td></tr>`;
    }
  }

  tableBody.addEventListener("click", async (e) => {
    const target = e.target;
    const row = target.closest("tr[data-user-id]");
    if (!row) return;
    const userId = row.dataset.userId;
    const limitInput = row.querySelector(".admin-quota-limit");
    const usedInput = row.querySelector(".admin-quota-used");

    if (target.classList.contains("admin-save")) {
      const limit = Number(limitInput.value || 0);
      const used = Number(usedInput.value || 0);
      try {
        const suffix = sessionKey ? `?sessionKey=${encodeURIComponent(sessionKey)}` : "";
        await apiRequest(`/api/admin/users/quota${suffix}`, {
          method: "POST",
          body: { userId, quotaLimit: limit, quotaUsed: used },
        });
        showToast("Saved quota.");
        refresh();
      } catch (error) {
        showToast(error.message, { type: "danger" });
      }
    }

    if (target.classList.contains("admin-delete")) {
      if (!confirm("Delete this user? This action cannot be undone.")) return;
      try {
        const suffix = sessionKey ? `?sessionKey=${encodeURIComponent(sessionKey)}` : "";
        await apiRequest(`/api/admin/users/${encodeURIComponent(userId)}${suffix}`, {
          method: "DELETE",
        });
        showToast("User deleted.");
        if (userId === sessionKey) {
          setStoredUser(null);
          sessionKey = null;
          showToast("Your account was removed. Signing out.", { type: "danger" });
          setTimeout(() => {
            window.location.replace("signin.html");
          }, 200);
        } else {
          refresh();
        }
      } catch (error) {
        showToast(error.message, { type: "danger" });
      }
    }
  });

  if (searchInput) {
    searchInput.addEventListener("input", () => renderUsers(applyFilter()));
  }

  refresh();
}
