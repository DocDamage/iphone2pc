async function loadHomeDashboard() {
    const safe = promise => promise.catch(() => null);
    const [status, library, jobs, fabric, timeline] = await Promise.all([
        safe(apiJson("/api/status")), safe(apiJson("/api/library/tracks")), safe(apiJson("/api/recovery/jobs")),
        safe(apiJson("/api/fabric/status")), safe(apiJson("/api/diagnostics/timeline?limit=6"))
    ]);
    if (status) updateHomeConnection(status);
    setText("homeTrackCount", library?.count ?? "—");
    const recoveryJobs = jobs?.jobs || [];
    setText("homeQueueCount", recoveryJobs.length);
    const active = recoveryJobs.filter(job => ["queued", "running", "paused"].includes(job.status)).length;
    setText("homeQueueDetail", active ? `${active} active or paused` : "no active transfers");
    const badge = document.getElementById("queueNavBadge");
    if (badge) { badge.hidden = active === 0; badge.textContent = active; }
    const prediction = fabric?.diagnostics;
    setText("homeCableScore", prediction?.score == null ? "No baseline" : `${prediction.score}/100`);
    setText("homeCableDetail", prediction?.recommendation || "run a cable baseline");
    setText("homeVaultCount", fabric?.vault?.manifests ?? "—");
    renderHomeActivity(timeline?.events || []);
}

function setText(id, value) {
    const element = document.getElementById(id);
    if (element) element.textContent = value;
}

function updateHomeConnection(status) {
    const connected = Boolean(status.connected);
    const name = status.device_info?.DeviceName || "iPhone";
    const title = connected ? `${name} is connected. Let’s get your files back.` : "Connect your iPhone to begin safely.";
    const copy = connected
        ? "Scan what iOS exposes, choose only the files you want, and recover verified copies to this PC."
        : "Unlock the phone, connect a data-capable USB cable, and tap Trust when iOS asks.";
    setText("homeHeroTitle", title);
    setText("homeHeroCopy", copy);
    const eyebrow = document.getElementById("homeEyebrow");
    if (eyebrow) eyebrow.innerHTML = connected
        ? '<i class="fa-solid fa-circle-check"></i> READY FOR RECOVERY'
        : '<i class="fa-solid fa-link-slash"></i> IPHONE NOT CONNECTED';
    document.getElementById("homePrimaryAction").innerHTML = connected
        ? '<i class="fa-solid fa-wand-magic-sparkles"></i> Start guided recovery'
        : '<i class="fa-solid fa-plug"></i> Reconnect iPhone';
    const connectCard = document.getElementById("journeyConnect");
    connectCard?.classList.toggle("complete", connected);
    connectCard?.classList.toggle("active", !connected);
    connectCard?.querySelector(".journey-state")?.replaceChildren(connected ? "Connected" : "Reconnect");
    document.getElementById("journeyScan")?.classList.toggle("active", connected);
    setText("journeyProgress", connected ? "Step 2 of 3" : "Step 1 of 3");
    document.getElementById("heroDevicePulse")?.classList.toggle("offline", !connected);
}

function renderHomeActivity(events) {
    const panel = document.getElementById("homeActivity");
    if (!panel) return;
    if (!events.length) {
        panel.innerHTML = '<div class="empty-state">Device events will appear here as you connect and recover.</div>';
        return;
    }
    panel.innerHTML = events.map(event => {
        const stamp = event.occurred_at || event.timestamp || event.time;
        const time = stamp ? new Date(stamp).toLocaleString([], {month: "short", day: "numeric", hour: "numeric", minute: "2-digit"}) : "Recent";
        const state = String(event.state || event.event || "Device event").replaceAll("_", " ");
        return `<div class="activity-item"><span class="activity-dot"></span><span class="activity-time">${escapeHtml(time)}</span><span class="activity-copy"><strong>${escapeHtml(state)}</strong>${event.detail ? ` · ${escapeHtml(event.detail)}` : ""}</span></div>`;
    }).join("");
}

async function startGuidedRecovery() {
    try {
        const status = await apiJson("/api/status");
        if (!status.connected) {
            showToast("warning", "Connect your iPhone", "Unlock it, tap Trust, then use Reconnect.");
            return forceReconnect();
        }
        navigateTo("musicTab", {focus: true});
        setTimeout(() => document.getElementById("btnScanMusic")?.focus(), 250);
    } catch (error) { showToast("error", "Could not check the iPhone", error.message); }
}

function startHomeScan() {
    navigateTo("musicTab", {focus: true});
    setTimeout(() => scanMusicSSE(), 220);
}

function openPortableFiles() {
    navigateTo("driveTab", {focus: true});
    setTimeout(() => loadDrivePath("/Downloads/iDrivePulse Portable Files"), 220);
}
