// ============================================================
//  iDrivePulse v6.0 — Client Application Logic
// ============================================================

let currentTracks = [];
let selectedTrackIds = new Set();
let currentDrivePath = "/";
let currentDriveWritable = false;
let activePlayingTrackId = null;
let driveSelectedPaths = new Set();
let parentPath = null;
let mountState = { running: false, mounted: false, drive: null };
let recoveryJobsCache = [];
let lastProjectBundle = null;
let usbTraceRecording = false;

// ===== INITIALIZATION =====

function initializeApp() {
    initializeShell();
    checkStatus();
    // Poll status every 10 seconds (cached on backend — no reconnect storms)
    setInterval(checkStatus, 10000);
    setupAudioListeners();
    setupKeyboardShortcuts();
    setupDragAndDrop();
    refreshMountStatus();
    loadRecoveryJobs();
    loadHomeDashboard();
}

// ===== TOAST NOTIFICATION SYSTEM =====

function showToast(type, title, message, duration = 5000) {
    const container = document.getElementById("toastContainer");
    const icons = {
        success: "fa-circle-check",
        error: "fa-circle-xmark",
        info: "fa-circle-info",
        warning: "fa-triangle-exclamation"
    };

    const toast = document.createElement("div");
    toast.className = `toast ${type} fade-in`;
    toast.setAttribute("role", type === "error" ? "alert" : "status");
    toast.innerHTML = `
        <i class="fa-solid ${icons[type] || icons.info} toast-icon"></i>
        <div class="toast-body">
            <div class="toast-title">${escapeHtml(title)}</div>
            ${message ? `<div class="toast-message">${escapeHtml(message)}</div>` : ''}
        </div>
        <button class="toast-close" onclick="dismissToast(this.parentElement)" aria-label="Dismiss notification">
            <i class="fa-solid fa-xmark"></i>
        </button>
    `;

    container.appendChild(toast);

    if (duration > 0) {
        setTimeout(() => dismissToast(toast), duration);
    }

    return toast;
}

function dismissToast(toastEl) {
    if (!toastEl || toastEl.classList.contains("removing")) return;
    toastEl.classList.add("removing");
    setTimeout(() => toastEl.remove(), 300);
}

// ===== TAB NAVIGATION =====

function switchTab(tabId, btnElement, options = {}) {
    activateWorkspaceTab(tabId, btnElement, options);

    if (tabId === "homeTab") loadHomeDashboard();

    if (tabId === "driveTab" && currentDrivePath === "/") {
        loadDrivePath("/");
        refreshMountStatus();
    }
    if (tabId === "wifiTab") {
        loadHardwareDiagnostics();
    }
    if (tabId === "recoveryTab") {
        loadRecoveryJobs();
        loadSyncProfiles();
        loadCompanionStatus();
    }
    if (tabId === "fabricTab") loadFabricDashboard();
}

// ===== CONNECTION STATUS =====

async function checkStatus() {
    const statusDot = document.getElementById("statusDot");
    const statusText = document.getElementById("statusText");
    const statusBadge = document.getElementById("statusBadge");
    const wifiIpDisplay = document.getElementById("wifiIpDisplay");
    const exportPathInput = document.getElementById("exportPathInput");

    try {
        const res = await fetch("/api/status");
        const data = await res.json();

        if (wifiIpDisplay) {
            wifiIpDisplay.innerText = "This PC only · 127.0.0.1:8765";
        }
        if (exportPathInput && !exportPathInput.value && data.default_export_directory) {
            exportPathInput.value = data.default_export_directory;
        }

        if (data.connected) {
            statusDot.className = "status-dot connected";
            const devName = data.device_info.DeviceName || "iPhone";
            statusText.innerText = `${devName} — Connected (${data.mode})`;
            statusText.style.color = "var(--accent-teal)";
            statusBadge.classList.add("is-connected");
            document.getElementById("statusDetail").innerText = data.mode || "Trusted USB";
            fetchStorageInfo();
        } else {
            statusDot.className = "status-dot disconnected";
            const detail = data.message || "No iPhone detected.";
            statusText.innerText = detail.includes("Apple Mobile Device")
                ? "Apple USB driver unavailable"
                : "Disconnected — Plug in iPhone & unlock";
            statusText.title = detail;
            statusText.style.color = "#EF4444";
            statusBadge.classList.remove("is-connected");
            document.getElementById("statusDetail").innerText = "Unlock and trust this PC";
        }
        updateHomeConnection(data);
    } catch (e) {
        statusDot.className = "status-dot disconnected";
        statusText.innerText = "Backend Server Offline";
        statusText.style.color = "#EF4444";
    }
}

async function forceReconnect() {
    const btn = document.getElementById("btnReconnect");
    btn.disabled = true;
    btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Connecting...`;

    try {
        const res = await fetch("/api/connect", { method: "POST" });
        const data = await res.json();

        if (data.success) {
            showToast("success", "Connected!", `${data.device_info?.DeviceName || "iPhone"} detected via USB.`);
        } else {
            showToast("error", "Connection Failed", data.message);
        }
        await checkStatus();
    } catch (e) {
        showToast("error", "Connection Error", e.message);
    } finally {
        btn.disabled = false;
        btn.innerHTML = `<i class="fa-solid fa-rotate-right"></i> Reconnect`;
    }
}

async function fetchStorageInfo() {
    try {
        const res = await fetch("/api/device/storage");
        const data = await res.json();
        const bar = document.getElementById("storageGaugeBar");
        const txt = document.getElementById("storageGaugeText");
        if (bar && txt && data.total_gb > 0) {
            bar.style.width = `${data.used_percent}%`;
            bar.parentElement.setAttribute("aria-valuenow", String(Math.round(data.used_percent)));
            txt.innerText = `${data.used_gb} / ${data.total_gb} GB`;
        }
    } catch (e) {}
}
