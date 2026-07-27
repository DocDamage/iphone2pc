(() => {
  "use strict";

  const TOKEN_KEY = "pocketdock.session";
  const DEVICE_KEY = "pocketdock.device-name";
  const DEVICE_ID_KEY = "pocketdock.device-id";
  const REFRESH_KEY = "pocketdock.refresh-token";
  const TRANSFER_KEY = "pocketdock.transfer-key";
  const TAB_KEY = "pocketdock.mobile-tab";
  const CHUNK_SIZE = 4 * 1024 * 1024;
  const browserCrypto = globalThis.crypto;
  const SHA256_CONSTANTS = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
    0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
    0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
    0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
    0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
    0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
    0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
    0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
    0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
  ]);

  class Sha256 {
    constructor() {
      this.state = new Uint32Array([
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
        0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
      ]);
      this.buffer = new Uint8Array(64);
      this.bufferLength = 0;
      this.bytesHashed = 0;
      this.finished = false;
    }

    update(input) {
      if (this.finished) throw new Error("SHA-256 digest is already finalized.");
      const data = input instanceof Uint8Array ? input : new Uint8Array(input);
      this.bytesHashed += data.length;
      let position = 0;
      while (position < data.length) {
        const take = Math.min(data.length - position, 64 - this.bufferLength);
        this.buffer.set(data.subarray(position, position + take), this.bufferLength);
        this.bufferLength += take;
        position += take;
        if (this.bufferLength === 64) {
          this.processBlock(this.buffer);
          this.bufferLength = 0;
        }
      }
      return this;
    }

    processBlock(block) {
      const words = new Uint32Array(64);
      const view = new DataView(block.buffer, block.byteOffset, block.byteLength);
      for (let index = 0; index < 16; index += 1) words[index] = view.getUint32(index * 4);
      for (let index = 16; index < 64; index += 1) {
        const x = words[index - 15];
        const y = words[index - 2];
        const s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
        const s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
        words[index] = (words[index - 16] + s0 + words[index - 7] + s1) >>> 0;
      }
      let [a, b, c, d, e, f, g, h] = this.state;
      for (let index = 0; index < 64; index += 1) {
        const sum1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
        const choice = (e & f) ^ (~e & g);
        const temp1 = (h + sum1 + choice + SHA256_CONSTANTS[index] + words[index]) >>> 0;
        const sum0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
        const majority = (a & b) ^ (a & c) ^ (b & c);
        const temp2 = (sum0 + majority) >>> 0;
        h = g;
        g = f;
        f = e;
        e = (d + temp1) >>> 0;
        d = c;
        c = b;
        b = a;
        a = (temp1 + temp2) >>> 0;
      }
      this.state[0] = (this.state[0] + a) >>> 0;
      this.state[1] = (this.state[1] + b) >>> 0;
      this.state[2] = (this.state[2] + c) >>> 0;
      this.state[3] = (this.state[3] + d) >>> 0;
      this.state[4] = (this.state[4] + e) >>> 0;
      this.state[5] = (this.state[5] + f) >>> 0;
      this.state[6] = (this.state[6] + g) >>> 0;
      this.state[7] = (this.state[7] + h) >>> 0;
    }

    digestHex() {
      if (this.finished) throw new Error("SHA-256 digest is already finalized.");
      this.finished = true;
      const bitLength = BigInt(this.bytesHashed) * 8n;
      this.buffer[this.bufferLength++] = 0x80;
      if (this.bufferLength > 56) {
        this.buffer.fill(0, this.bufferLength);
        this.processBlock(this.buffer);
        this.bufferLength = 0;
      }
      this.buffer.fill(0, this.bufferLength, 56);
      const view = new DataView(this.buffer.buffer);
      view.setUint32(56, Number((bitLength >> 32n) & 0xffffffffn));
      view.setUint32(60, Number(bitLength & 0xffffffffn));
      this.processBlock(this.buffer);
      return [...this.state].map((word) => word.toString(16).padStart(8, "0")).join("");
    }
  }

  const fragmentKey = new URLSearchParams(location.hash.slice(1)).get("key") || "";
  if (fragmentKey) localStorage.setItem(TRANSFER_KEY, fragmentKey);

  const state = {
    token: localStorage.getItem(TOKEN_KEY) || "",
    transferKey: fragmentKey || localStorage.getItem(TRANSFER_KEY) || "",
    pcName: "your PC",
    queue: [],
    active: 0,
    maxConcurrent: 2,
    encryptionRequired: true,
    integrityRequired: true,
    wakeLock: null,
    importedKey: null,
    selectedTab: sessionStorage.getItem(TAB_KEY) || "send"
  };

  const elements = {
    pairView: document.getElementById("pair-view"),
    appView: document.getElementById("app-view"),
    pairForm: document.getElementById("pair-form"),
    pairCode: document.getElementById("pair-code"),
    pairError: document.getElementById("pair-error"),
    pairButton: document.querySelector("#pair-form button[type='submit']"),
    browserNote: document.getElementById("browser-note"),
    transferSecurity: document.getElementById("transfer-security"),
    networkBanner: document.getElementById("network-banner"),
    connection: document.getElementById("connection-indicator"),
    sendTab: document.getElementById("send-tab"),
    receiveTab: document.getElementById("receive-tab"),
    clipboardTab: document.getElementById("clipboard-tab"),
    sendPanel: document.getElementById("send-panel"),
    receivePanel: document.getElementById("receive-panel"),
    clipboardPanel: document.getElementById("clipboard-panel"),
    photosButton: document.getElementById("photos-button"),
    filesButton: document.getElementById("files-button"),
    folderButton: document.getElementById("folder-button"),
    photosInput: document.getElementById("photos-input"),
    filesInput: document.getElementById("files-input"),
    folderInput: document.getElementById("folder-input"),
    queueSection: document.getElementById("queue-section"),
    queueTitle: document.getElementById("queue-title"),
    queueList: document.getElementById("queue-list"),
    clearFinished: document.getElementById("clear-finished"),
    downloadList: document.getElementById("download-list"),
    refreshShares: document.getElementById("refresh-shares"),
    shareCount: document.getElementById("share-count"),
    clipboardCount: document.getElementById("clipboard-count"),
    clipboardText: document.getElementById("clipboard-text"),
    sendClipboard: document.getElementById("send-clipboard"),
    refreshClipboard: document.getElementById("refresh-clipboard"),
    clipboardList: document.getElementById("clipboard-list"),
    disconnect: document.getElementById("disconnect-button"),
    toast: document.getElementById("toast")
  };

  function formatBytes(bytes) {
    if (!bytes) return "0 B";
    const units = ["B", "KB", "MB", "GB", "TB"];
    const power = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
    return `${(bytes / 1024 ** power).toFixed(power ? 1 : 0)} ${units[power]}`;
  }

  function formatDuration(seconds) {
    if (!Number.isFinite(seconds) || seconds < 1) return "a moment";
    if (seconds < 60) return `${Math.ceil(seconds)} sec`;
    const minutes = Math.ceil(seconds / 60);
    return `${minutes} min`;
  }

  function escapeHtml(value) {
    const span = document.createElement("span");
    span.textContent = value;
    return span.innerHTML;
  }

  function fileKind(name) {
    const extension = name.split(".").pop().toLowerCase();
    if (["jpg", "jpeg", "png", "gif", "heic", "webp"].includes(extension)) return "image";
    if (["mov", "mp4", "m4v", "avi"].includes(extension)) return "video";
    if (["mp3", "wav", "m4a", "aac", "flac"].includes(extension)) return "audio";
    if (["zip", "rar", "7z", "tar", "gz"].includes(extension)) return "archive";
    return "file";
  }

  function iconSvg(kind) {
    const icons = {
      image: '<rect x="3" y="3" width="18" height="18" rx="3"></rect><circle cx="9" cy="9" r="2"></circle><path d="m21 15-5-5L5 21"></path>',
      video: '<path d="m16 13 5 3V8l-5 3"></path><rect x="3" y="5" width="13" height="14" rx="2"></rect>',
      audio: '<path d="M9 18V5l10-2v13"></path><circle cx="6" cy="18" r="3"></circle><circle cx="16" cy="16" r="3"></circle>',
      archive: '<path d="M21 8v13H3V8M1 3h22v5H1zM10 12h4"></path>',
      url: '<path d="M10 13a5 5 0 0 0 7.1.1l2-2a5 5 0 0 0-7.1-7.1l-1.1 1.1"></path><path d="M14 11a5 5 0 0 0-7.1-.1l-2 2A5 5 0 0 0 12 20l1.1-1.1"></path>',
      file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"></path><path d="M14 2v6h6"></path>'
    };
    return `<svg viewBox="0 0 24 24" aria-hidden="true">${icons[kind] || icons.file}</svg>`;
  }

  function deviceName() {
    const agent = navigator.userAgent;
    const browser = globalThis.PocketDockCrypto?.detectBrowser?.(agent) ?? {
      name: "browser",
      platform: "browser"
    };
    const detected = `${/iPad/i.test(agent) ? "iPad" : "iPhone"} via ${browser.name}`;
    let name = localStorage.getItem(DEVICE_KEY);
    if (!name || (name.endsWith("via Safari") && browser.name !== "Safari")) {
      name = detected;
      localStorage.setItem(DEVICE_KEY, name);
    }
    return name;
  }

  function configureBrowserExperience() {
    const browser = globalThis.PocketDockCrypto?.detectBrowser?.(navigator.userAgent) ?? {
      name: "browser",
      platform: "browser"
    };
    document.documentElement.dataset.browser = browser.name.toLowerCase();
    if (elements.browserNote) {
      elements.browserNote.textContent = browser.name === "Chrome"
        ? "Chrome is fully supported. Keep this tab open during large transfers."
        : `${browser.name} is supported. Keep this tab open during large transfers.`;
    }
  }

  function browserPlatform() {
    return globalThis.PocketDockCrypto?.detectBrowser?.(navigator.userAgent).platform ?? "browser";
  }

  function secureRandomBytes(length) {
    if (!browserCrypto?.getRandomValues) {
      throw new Error("This browser cannot create secure transfer identifiers.");
    }
    return browserCrypto.getRandomValues(new Uint8Array(length));
  }

  function newUuid() {
    if (typeof browserCrypto?.randomUUID === "function") return browserCrypto.randomUUID();
    const bytes = secureRandomBytes(16);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  function deviceId() {
    let id = localStorage.getItem(DEVICE_ID_KEY);
    if (!id) {
      id = newUuid();
      localStorage.setItem(DEVICE_ID_KEY, id);
    }
    return id;
  }

  function base64UrlToBytes(value) {
    const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
    return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
  }

  function bytesToBase64Url(bytes) {
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  }

  async function encryptionKey() {
    if (!state.transferKey) throw new Error("Scan PocketDock again to restore encryption.");
    if (!state.importedKey) {
      const raw = base64UrlToBytes(state.transferKey);
      if (browserCrypto?.subtle) {
        try {
          state.importedKey = {
            mode: "webcrypto",
            value: await browserCrypto.subtle.importKey(
              "raw",
              raw,
              "AES-GCM",
              false,
              ["encrypt", "decrypt"]
            )
          };
        } catch {
          // Local HTTP pages are not secure contexts on iOS. Use the bundled,
          // audited AES implementation while keeping the exact same wire format.
        }
      }
      if (!state.importedKey && globalThis.PocketDockCrypto) {
        state.importedKey = { mode: "portable", value: raw };
      }
      if (!state.importedKey) {
        throw new Error("PocketDock encryption could not start in this browser.");
      }
    }
    return state.importedKey;
  }

  async function encryptChunk(uploadId, offset, plaintext) {
    const iv = secureRandomBytes(12);
    const aad = new TextEncoder().encode(`${uploadId}:${offset}:${plaintext.length}`);
    const key = await encryptionKey();
    const payload = key.mode === "webcrypto"
      ? await browserCrypto.subtle.encrypt(
          { name: "AES-GCM", iv, additionalData: aad, tagLength: 128 },
          key.value,
          plaintext
        )
      : globalThis.PocketDockCrypto.encrypt(key.value, iv, aad, plaintext);
    return { payload, iv: bytesToBase64Url(iv) };
  }

  async function decryptChunk(shareId, offset, plainLength, iv, payload) {
    const aad = new TextEncoder().encode(`${shareId}:${offset}:${plainLength}`);
    const nonce = base64UrlToBytes(iv);
    const key = await encryptionKey();
    return key.mode === "webcrypto"
      ? new Uint8Array(
          await browserCrypto.subtle.decrypt(
            {
              name: "AES-GCM",
              iv: nonce,
              additionalData: aad,
              tagLength: 128
            },
            key.value,
            payload
          )
        )
      : globalThis.PocketDockCrypto.decrypt(
          key.value,
          nonce,
          aad,
          new Uint8Array(payload)
        );
  }

  async function api(route, options = {}) {
    const headers = new Headers(options.headers || {});
    if (state.token) headers.set("Authorization", `Bearer ${state.token}`);
    if (options.body && typeof options.body === "string") headers.set("Content-Type", "application/json");
    const response = await fetch(route, { ...options, headers });
    let data = null;
    if ((response.headers.get("content-type") || "").includes("application/json")) {
      data = await response.json();
    }
    if (!response.ok) {
      const error = new Error(data?.error || `Request failed (${response.status})`);
      error.status = response.status;
      error.data = data;
      throw error;
    }
    return data;
  }

  function saveSession(result) {
    state.token = result.token;
    state.pcName = result.pcName;
    state.encryptionRequired = result.encryptionRequired !== false;
    state.integrityRequired = result.integrityRequired !== false;
    localStorage.setItem(TOKEN_KEY, result.token);
    if (result.refreshToken) localStorage.setItem(REFRESH_KEY, result.refreshToken);
    if (result.deviceId) localStorage.setItem(DEVICE_ID_KEY, result.deviceId);
  }

  function setConnected(connected) {
    elements.connection.classList.toggle("online", connected);
    elements.connection.querySelector("em").textContent = navigator.onLine
      ? (connected ? "Encrypted" : "Pairing")
      : "Offline";
    elements.pairView.hidden = connected;
    elements.appView.hidden = !connected;
    document.body.classList.toggle("is-connected", connected);
    document.querySelectorAll(".pc-name").forEach((node) => {
      node.textContent = state.pcName;
    });
  }

  async function pair(pin) {
    elements.pairError.textContent = "";
    const label = elements.pairButton.querySelector("span");
    elements.pairButton.disabled = true;
    elements.pairButton.setAttribute("aria-busy", "true");
    label.textContent = "Connecting…";
    try {
      if (!state.transferKey) throw new Error("Scan the QR code again so PocketDock can encrypt files.");
      const result = await api("/api/pair", {
        method: "POST",
        body: JSON.stringify({
          pin: pin.replace(/\D/g, ""),
          deviceName: deviceName(),
          deviceId: deviceId(),
          platform: browserPlatform()
        })
      });
      saveSession(result);
      setConnected(true);
      history.replaceState({}, "", location.pathname);
      await Promise.all([loadShares(), loadClipboard()]);
      switchTab(state.selectedTab);
      showToast(`Encrypted connection to ${state.pcName}`);
    } catch (error) {
      setConnected(false);
      elements.pairError.textContent = error.message;
      elements.pairCode.focus();
    } finally {
      elements.pairButton.disabled = false;
      elements.pairButton.removeAttribute("aria-busy");
      label.textContent = "Connect to PC";
    }
  }

  async function reconnectTrustedDevice() {
    const refreshToken = localStorage.getItem(REFRESH_KEY);
    const savedDeviceId = localStorage.getItem(DEVICE_ID_KEY);
    if (!refreshToken || !savedDeviceId || !state.transferKey) return false;
    try {
      state.token = "";
      const result = await api("/api/reconnect", {
        method: "POST",
        body: JSON.stringify({ deviceId: savedDeviceId, refreshToken })
      });
      saveSession(result);
      setConnected(true);
      await Promise.all([loadShares(), loadClipboard()]);
      return true;
    } catch {
      return false;
    }
  }

  async function boot() {
    configureBrowserExperience();
    updateNetworkState();
    try {
      const status = await api("/api/status");
      state.pcName = status.name;
      state.maxConcurrent = Math.max(1, Math.min(4, status.maxConcurrentUploads || 2));
      state.encryptionRequired = status.encryptionRequired !== false;
      state.integrityRequired = status.integrityRequired !== false;
      elements.transferSecurity.textContent = state.encryptionRequired
        ? "AES-256 encrypted over your local Wi-Fi"
        : "Transfer encryption is disabled on this PC";
    } catch {
      elements.pairView.hidden = false;
      elements.pairError.textContent = "PocketDock on your PC is no longer reachable.";
      return;
    }
    document.querySelectorAll(".pc-name").forEach((node) => {
      node.textContent = state.pcName;
    });

    if (state.token) {
      try {
        const me = await api("/api/me");
        if (me.encryptionRequired && !state.transferKey) throw new Error("Encryption key missing.");
        state.pcName = me.pcName;
        setConnected(true);
        await Promise.all([loadShares(), loadClipboard()]);
        switchTab(state.selectedTab);
        return;
      } catch {
        state.token = "";
        localStorage.removeItem(TOKEN_KEY);
      }
    }
    if (await reconnectTrustedDevice()) {
      switchTab(state.selectedTab);
      return;
    }

    const code = new URLSearchParams(location.search).get("code") || "";
    setConnected(false);
    if (/^\d{6}$/.test(code) && state.transferKey) {
      elements.pairCode.value = `${code.slice(0, 3)} ${code.slice(3)}`;
      await pair(code);
    } else {
      elements.pairError.textContent = state.transferKey
        ? ""
        : "Scan the PocketDock QR code instead of typing this address.";
      elements.pairCode.focus();
    }
  }

  function switchTab(tab) {
    const panels = {
      send: [elements.sendTab, elements.sendPanel],
      receive: [elements.receiveTab, elements.receivePanel],
      clipboard: [elements.clipboardTab, elements.clipboardPanel]
    };
    for (const [name, [button, panel]] of Object.entries(panels)) {
      const active = name === tab;
      button.classList.toggle("active", active);
      button.setAttribute("aria-selected", String(active));
      button.tabIndex = active ? 0 : -1;
      panel.hidden = !active;
    }
    state.selectedTab = tab;
    sessionStorage.setItem(TAB_KEY, tab);
    if (tab === "receive") loadShares();
    if (tab === "clipboard") loadClipboard();
  }

  function addFiles(fileList) {
    for (const file of Array.from(fileList || [])) {
      state.queue.push({
        localId: newUuid(),
        remoteId: "",
        file,
        offset: 0,
        hashedOffset: 0,
        status: "queued",
        error: "",
        controller: null,
        startedAt: 0,
        hasher: null
      });
    }
    elements.queueSection.hidden = state.queue.length === 0;
    renderQueue();
    runQueue();
  }

  function queueStatusText(item) {
    if (item.status === "queued") return "Waiting in encrypted queue";
    if (item.status === "starting") return "Preparing encryption";
    if (item.status === "verifying") return "Verifying SHA-256";
    if (item.status === "paused") return "Paused";
    if (item.status === "uploading") {
      const seconds = item.startedAt
        ? ((Date.now() - item.startedAt) / 1000 / Math.max(1, item.offset)) *
          (item.file.size - item.offset)
        : 0;
      return `${formatBytes(item.offset)} of ${formatBytes(item.file.size)} · ${formatDuration(seconds)} left`;
    }
    if (item.status === "completed") return item.duplicate ? "Identical file already on PC" : "Verified and saved";
    if (item.status === "cancelled") return "Cancelled";
    return item.error || "Transfer failed";
  }

  function renderQueue() {
    const unfinished = state.queue.filter((item) => !["completed", "cancelled"].includes(item.status));
    elements.queueTitle.textContent = unfinished.length
      ? `Moving ${unfinished.length} ${unfinished.length === 1 ? "file" : "files"}`
      : "All verified";
    elements.queueList.innerHTML = state.queue
      .map((item) => {
        const percent = item.file.size ? Math.round((item.offset / item.file.size) * 100) : 100;
        let action = `<button class="queue-cancel" data-cancel="${item.localId}" aria-label="Cancel">×</button>`;
        if (item.status === "completed") action = '<span class="queue-check">✓</span>';
        else if (item.status === "failed") action = `<button data-retry="${item.localId}">Retry</button>`;
        else if (item.status === "paused") action = `<button data-resume="${item.localId}">Resume</button>`;
        else if (["uploading", "starting"].includes(item.status)) {
          action = `<button data-pause="${item.localId}" aria-label="Pause">Ⅱ</button>`;
        }
        return `
          <article class="queue-item ${item.status}" aria-label="${escapeHtml(item.file.name)}, ${escapeHtml(queueStatusText(item))}">
            <div class="queue-icon ${fileKind(item.file.name)}">${iconSvg(fileKind(item.file.name))}</div>
            <div class="queue-file">
              <strong>${escapeHtml(item.file.name)}</strong>
              <span>${escapeHtml(queueStatusText(item))}</span>
              <div class="queue-progress" role="progressbar" aria-label="Transfer progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${percent}"><i style="width:${percent}%"></i></div>
            </div>
            <em>${item.status === "completed" ? "SHA ✓" : `${percent}%`}</em>
            ${action}
          </article>`;
      })
      .join("");
    elements.queueList.querySelectorAll("[data-cancel]").forEach((button) => {
      button.addEventListener("click", () => cancelItem(button.dataset.cancel));
    });
    elements.queueList.querySelectorAll("[data-retry]").forEach((button) => {
      button.addEventListener("click", () => retryItem(button.dataset.retry));
    });
    elements.queueList.querySelectorAll("[data-pause]").forEach((button) => {
      button.addEventListener("click", () => pauseItem(button.dataset.pause));
    });
    elements.queueList.querySelectorAll("[data-resume]").forEach((button) => {
      button.addEventListener("click", () => resumeItem(button.dataset.resume));
    });
  }

  async function requestWakeLock() {
    try {
      if ("wakeLock" in navigator && !state.wakeLock) {
        state.wakeLock = await navigator.wakeLock.request("screen");
        state.wakeLock.addEventListener("release", () => {
          state.wakeLock = null;
        });
      }
    } catch {
      // Transfers remain recoverable if iOS declines Wake Lock.
    }
  }

  async function releaseWakeLockIfIdle() {
    if (state.active === 0 && state.wakeLock) {
      await state.wakeLock.release().catch(() => undefined);
      state.wakeLock = null;
    }
  }

  function runQueue() {
    while (state.active < state.maxConcurrent) {
      const next = state.queue.find((item) => item.status === "queued");
      if (!next) break;
      state.active += 1;
      requestWakeLock();
      uploadItem(next)
        .catch(() => undefined)
        .finally(() => {
          state.active -= 1;
          releaseWakeLockIfIdle();
          renderQueue();
          runQueue();
        });
    }
  }

  async function hashPrefix(file, length) {
    const hasher = new Sha256();
    for (let offset = 0; offset < length; offset += CHUNK_SIZE) {
      const end = Math.min(offset + CHUNK_SIZE, length);
      hasher.update(new Uint8Array(await file.slice(offset, end).arrayBuffer()));
    }
    return hasher;
  }

  async function uploadItem(item) {
    item.status = "starting";
    item.error = "";
    item.startedAt ||= Date.now();
    renderQueue();
    try {
      if (state.encryptionRequired && !state.transferKey) {
        throw new Error("Scan the PocketDock QR code again to restore encryption.");
      }
      const start = await api("/api/uploads", {
        method: "POST",
        body: JSON.stringify({
          name: item.file.name,
          size: item.file.size,
          type: item.file.type || "application/octet-stream",
          lastModified: item.file.lastModified,
          relativePath: item.file.webkitRelativePath || item.file.name,
          encrypted: state.encryptionRequired,
          protocolVersion: 2
        })
      });
      item.remoteId = start.id;
      item.offset = start.offset;
      item.hasher = await hashPrefix(item.file, item.offset);
      item.hashedOffset = item.offset;
      item.status = start.paused ? "paused" : "uploading";
      renderQueue();
      if (item.status === "paused") return;

      while (item.offset < item.file.size && item.status === "uploading") {
        const chunkOffset = item.offset;
        const end = Math.min(chunkOffset + CHUNK_SIZE, item.file.size);
        const plaintext = new Uint8Array(await item.file.slice(chunkOffset, end).arrayBuffer());
        const encrypted = state.encryptionRequired
          ? await encryptChunk(item.remoteId, chunkOffset, plaintext)
          : { payload: plaintext, iv: "" };
        let sent = false;
        let attempts = 0;
        while (!sent && attempts < 4) {
          attempts += 1;
          item.controller = new AbortController();
          try {
            const result = await api(`/api/uploads/${item.remoteId}?offset=${chunkOffset}`, {
              method: "PUT",
              body: encrypted.payload,
              signal: item.controller.signal,
              headers: {
                "Content-Type": "application/octet-stream",
                ...(state.encryptionRequired
                  ? {
                      "X-PocketDock-IV": encrypted.iv,
                      "X-PocketDock-Plain-Length": String(plaintext.length)
                    }
                  : {})
              }
            });
            if (result.offset === end && item.hashedOffset === chunkOffset) {
              item.hasher.update(plaintext);
              item.hashedOffset = end;
            } else if (result.offset !== item.hashedOffset) {
              item.hasher = await hashPrefix(item.file, result.offset);
              item.hashedOffset = result.offset;
            }
            item.offset = result.offset;
            sent = true;
            renderQueue();
          } catch (error) {
            if (["paused", "cancelled"].includes(item.status) || error.name === "AbortError") throw error;
            if ([409, 423].includes(error.status)) {
              if (error.status === 423) {
                item.status = "paused";
                return;
              }
              item.offset = error.data?.expectedOffset ?? item.offset;
              item.hasher = await hashPrefix(item.file, item.offset);
              item.hashedOffset = item.offset;
              sent = true;
            } else if ([429, 500].includes(error.status) && attempts < 4) {
              await new Promise((resolve) => setTimeout(resolve, attempts * 700));
              const status = await api(`/api/uploads/${item.remoteId}`).catch(() => null);
              if (status) {
                item.offset = status.offset;
                if (item.offset !== item.hashedOffset) {
                  item.hasher = await hashPrefix(item.file, item.offset);
                  item.hashedOffset = item.offset;
                }
              }
            } else {
              throw error;
            }
          }
        }
      }

      if (item.status === "uploading") {
        item.status = "verifying";
        renderQueue();
        const sha256 = item.hasher.digestHex();
        const result = await api(`/api/uploads/${item.remoteId}/complete`, {
          method: "POST",
          body: JSON.stringify({ sha256 })
        });
        item.offset = item.file.size;
        item.status = "completed";
        item.duplicate = Boolean(result.duplicate);
        showToast(
          result.duplicate
            ? `${item.file.name} was already on ${state.pcName}`
            : `${item.file.name} was encrypted and verified`
        );
      }
    } catch (error) {
      if (item.status === "paused" || item.status === "cancelled") return;
      item.status = "failed";
      item.error = error.message || "Transfer failed";
      if (error.status === 401) disconnect(false);
    }
    renderQueue();
  }

  async function pauseItem(localId) {
    const item = state.queue.find((entry) => entry.localId === localId);
    if (!item || !["uploading", "starting"].includes(item.status)) return;
    item.status = "paused";
    item.controller?.abort();
    if (item.remoteId) await api(`/api/uploads/${item.remoteId}/pause`, { method: "POST" }).catch(() => undefined);
    renderQueue();
  }

  async function resumeItem(localId) {
    const item = state.queue.find((entry) => entry.localId === localId);
    if (!item) return;
    if (item.remoteId) await api(`/api/uploads/${item.remoteId}/resume`, { method: "POST" }).catch(() => undefined);
    item.status = "queued";
    item.error = "";
    renderQueue();
    runQueue();
  }

  async function cancelItem(localId) {
    const item = state.queue.find((entry) => entry.localId === localId);
    if (!item || ["completed", "cancelled"].includes(item.status)) return;
    item.status = "cancelled";
    item.controller?.abort();
    if (item.remoteId) await api(`/api/uploads/${item.remoteId}`, { method: "DELETE" }).catch(() => undefined);
    renderQueue();
  }

  function retryItem(localId) {
    const item = state.queue.find((entry) => entry.localId === localId);
    if (!item) return;
    item.status = "queued";
    item.error = "";
    renderQueue();
    runQueue();
  }

  async function authenticatedFetch(route, options = {}) {
    const headers = new Headers(options.headers || {});
    headers.set("Authorization", `Bearer ${state.token}`);
    const response = await fetch(route, { ...options, headers });
    if (!response.ok) {
      let message = `Request failed (${response.status})`;
      try {
        message = (await response.json()).error || message;
      } catch {
        // Binary endpoints do not always return JSON.
      }
      throw new Error(message);
    }
    return response;
  }

  async function downloadSharedFile(file, button) {
    if (!file.encrypted && file.downloadUrl) {
      location.href = file.downloadUrl;
      return;
    }
    if (!state.transferKey) {
      showToast("Scan the PocketDock QR code again before downloading.");
      return;
    }
    const original = button.innerHTML;
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
    try {
      const parts = [];
      const hasher = new Sha256();
      for (let offset = 0; offset < file.size; offset += CHUNK_SIZE) {
        const response = await authenticatedFetch(
          `${file.chunkUrl}?offset=${offset}&length=${CHUNK_SIZE}`
        );
        const payload = await response.arrayBuffer();
        const plainLength = Number(response.headers.get("x-pocketdock-plain-length"));
        const iv = response.headers.get("x-pocketdock-iv");
        const plaintext = await decryptChunk(file.id, offset, plainLength, iv, payload);
        parts.push(plaintext);
        hasher.update(plaintext);
        const percent = Math.round(((offset + plaintext.length) / file.size) * 100);
        button.querySelector("span").textContent = `Decrypting ${percent}%`;
      }
      const sha256 = hasher.digestHex();
      if (file.sha256 && sha256 !== file.sha256) throw new Error("Download integrity check failed.");
      const blob = new Blob(parts, { type: file.mimeType || "application/octet-stream" });
      const delivery = await shareOrSaveBlob(blob, file);
      await api(`/api/shares/${file.id}/complete`, { method: "POST" });
      showToast(
        delivery === "shared"
          ? `${file.name} verified · share sheet opened`
          : delivery === "cancelled"
            ? `${file.name} verified · sharing cancelled`
            : `${file.name} decrypted, verified, and saved`
      );
    } catch (error) {
      showToast(error.message);
    } finally {
      button.innerHTML = original;
      button.disabled = false;
      button.removeAttribute("aria-busy");
    }
  }

  async function shareOrSaveBlob(blob, file) {
    if (typeof File === "function" && navigator.share && navigator.canShare) {
      const sharedFile = new File([blob], file.name, {
        type: file.mimeType || "application/octet-stream",
        lastModified: Date.now()
      });
      if (navigator.canShare({ files: [sharedFile] })) {
        try {
          await navigator.share({
            files: [sharedFile],
            title: file.name,
            text: `Received securely from ${state.pcName} with PocketDock`
          });
          return "shared";
        } catch (error) {
          if (error?.name === "AbortError") return "cancelled";
        }
      }
    }

    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = file.name;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    return "saved";
  }

  async function loadShares() {
    try {
      const shares = await api("/api/shares");
      elements.shareCount.hidden = shares.length === 0;
      elements.shareCount.textContent = String(shares.length);
      if (!shares.length) {
        elements.downloadList.innerHTML = `<div class="download-empty"><div>${iconSvg("file")}</div><strong>Nothing waiting yet</strong><p>Use “Send to iPhone” in PocketDock on your PC.</p></div>`;
        return;
      }
      elements.downloadList.innerHTML = shares
        .map(
          (file) => `
            <button class="download-item" data-download="${file.id}">
              <div class="download-icon ${fileKind(file.name)}">${iconSvg(fileKind(file.name))}</div>
              <div>
                <strong>${escapeHtml(file.name)}</strong>
                <span>${formatBytes(file.size)} · ${file.encrypted ? "AES-256 encrypted" : `from ${escapeHtml(state.pcName)}`}</span>
              </div>
              <svg class="download-arrow" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12M7 10l5 5 5-5"></path><path d="M5 21h14"></path></svg>
            </button>`
        )
        .join("");
      elements.downloadList.querySelectorAll("[data-download]").forEach((button) => {
        const file = shares.find((entry) => entry.id === button.dataset.download);
        button.addEventListener("click", () => downloadSharedFile(file, button));
      });
    } catch (error) {
      elements.downloadList.innerHTML = `<div class="download-empty"><strong>Couldn’t refresh</strong><p>${escapeHtml(error.message)}</p></div>`;
    }
  }

  async function loadClipboard() {
    try {
      const response = await authenticatedFetch("/api/clipboard");
      const payload = await response.arrayBuffer();
      const plaintext = await decryptChunk(
        `clipboard:${deviceId()}`,
        0,
        Number(response.headers.get("x-pocketdock-plain-length")),
        response.headers.get("x-pocketdock-iv"),
        payload
      );
      const entries = JSON.parse(new TextDecoder().decode(plaintext));
      elements.clipboardCount.hidden = entries.length === 0;
      elements.clipboardCount.textContent = String(entries.length);
      elements.clipboardList.innerHTML = entries.length
        ? entries
            .map(
              (entry) => `
                <article class="clipboard-entry">
                  <span>${iconSvg(entry.kind === "url" ? "url" : "file")}</span>
                  <div><strong>${escapeHtml(entry.content.replace(/\s+/g, " "))}</strong><em>${escapeHtml(entry.sourceDevice)}</em></div>
                  <button data-copy="${entry.id}" aria-label="Copy">${iconSvg("file")}</button>
                </article>`
            )
            .join("")
        : '<div class="download-empty"><strong>Clipboard is empty</strong><p>Send text from either device.</p></div>';
      elements.clipboardList.querySelectorAll("[data-copy]").forEach((button) => {
        const entry = entries.find((item) => item.id === button.dataset.copy);
        button.addEventListener("click", async () => {
          await navigator.clipboard.writeText(entry.content);
          showToast("Copied");
        });
      });
    } catch (error) {
      elements.clipboardList.innerHTML = `<div class="download-empty"><p>${escapeHtml(error.message)}</p></div>`;
    }
  }

  async function sendClipboard() {
    const content = elements.clipboardText.value.trim();
    if (!content) return;
    try {
      const plaintext = new TextEncoder().encode(
        JSON.stringify({
          kind: /^https?:\/\//i.test(content) ? "url" : "text",
          content
        })
      );
      const encrypted = await encryptChunk(`clipboard:${deviceId()}`, 0, plaintext);
      await authenticatedFetch("/api/clipboard", {
        method: "POST",
        body: encrypted.payload,
        headers: {
          "Content-Type": "application/octet-stream",
          "X-PocketDock-IV": encrypted.iv,
          "X-PocketDock-Plain-Length": String(plaintext.length)
        }
      });
      elements.clipboardText.value = "";
      await loadClipboard();
      showToast("Sent to PocketDock clipboard");
    } catch (error) {
      showToast(error.message);
    }
  }

  function disconnect(showMessage = true) {
    state.token = "";
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(REFRESH_KEY);
    setConnected(false);
    if (showMessage) showToast("Disconnected");
  }

  let toastTimer = 0;
  function showToast(message) {
    clearTimeout(toastTimer);
    elements.toast.textContent = message;
    elements.toast.hidden = false;
    requestAnimationFrame(() => elements.toast.classList.add("show"));
    toastTimer = setTimeout(() => {
      elements.toast.classList.remove("show");
      setTimeout(() => {
        elements.toast.hidden = true;
      }, 220);
    }, 4_500);
  }

  function updateNetworkState() {
    const online = navigator.onLine;
    elements.networkBanner.hidden = online;
    if (!online) {
      elements.connection.classList.remove("online");
      elements.connection.querySelector("em").textContent = "Offline";
    } else {
      elements.connection.classList.toggle("online", Boolean(state.token));
      elements.connection.querySelector("em").textContent = state.token ? "Encrypted" : "Pairing";
    }
  }

  elements.pairForm.addEventListener("submit", (event) => {
    event.preventDefault();
    pair(elements.pairCode.value);
  });
  elements.pairCode.addEventListener("input", () => {
    const digits = elements.pairCode.value.replace(/\D/g, "").slice(0, 6);
    elements.pairCode.value = digits.length > 3 ? `${digits.slice(0, 3)} ${digits.slice(3)}` : digits;
  });
  elements.sendTab.addEventListener("click", () => switchTab("send"));
  elements.receiveTab.addEventListener("click", () => switchTab("receive"));
  elements.clipboardTab.addEventListener("click", () => switchTab("clipboard"));
  [elements.sendTab, elements.receiveTab, elements.clipboardTab].forEach((tab, index, tabs) => {
    tab.addEventListener("keydown", (event) => {
      if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return;
      event.preventDefault();
      const direction = event.key === "ArrowRight" ? 1 : -1;
      const next = tabs[(index + direction + tabs.length) % tabs.length];
      next.focus();
      next.click();
    });
  });
  elements.photosButton.addEventListener("click", () => elements.photosInput.click());
  elements.filesButton.addEventListener("click", () => elements.filesInput.click());
  elements.folderButton.addEventListener("click", () => elements.folderInput.click());
  [elements.photosInput, elements.filesInput, elements.folderInput].forEach((input) => {
    input.addEventListener("change", () => {
      addFiles(input.files);
      input.value = "";
    });
  });
  elements.clearFinished.addEventListener("click", () => {
    state.queue = state.queue.filter(
      (item) => !["completed", "cancelled", "failed"].includes(item.status)
    );
    elements.queueSection.hidden = state.queue.length === 0;
    renderQueue();
  });
  elements.refreshShares.addEventListener("click", loadShares);
  elements.refreshClipboard.addEventListener("click", loadClipboard);
  elements.sendClipboard.addEventListener("click", sendClipboard);
  elements.disconnect.addEventListener("click", () => disconnect(true));
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && state.active > 0) requestWakeLock();
  });
  window.addEventListener("online", () => {
    updateNetworkState();
    if (state.token) Promise.all([loadShares(), loadClipboard()]).catch(() => undefined);
  });
  window.addEventListener("offline", updateNetworkState);

  boot();
})();
