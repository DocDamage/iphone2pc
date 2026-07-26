function diagnosticList(items, emptyText) {
    if (!items?.length) return `<span>${escapeHtml(emptyText)}</span>`;
    return `<ul>${items.map(item => `<li>${escapeHtml(typeof item === "string" ? item : item.Name || item.DisplayName || item.FriendlyName || JSON.stringify(item))}</li>`).join("")}</ul>`;
}

async function loadHardwareDiagnostics() {
    const panel = document.getElementById("hardwareDiagnostics");
    panel.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Inspecting Windows and Apple USB services…';
    try {
        const data = await apiJson("/api/diagnostics/hardware");
        panel.innerHTML = `<div class="metric-grid">
            <div class="metric">USB / PnP<strong>${data.pnp_present ? "Present" : "Missing"}</strong></div>
            <div class="metric">Apple mux<strong>${data.mux_ready ? "Ready" : "Unavailable"}</strong></div>
            <div class="metric">AFC<strong>${data.afc_ready ? "Ready" : "Unavailable"}</strong></div>
            <div class="metric">WinFsp<strong>${data.winfsp_installed ? "Installed" : "Missing"}</strong></div>
            <div class="metric">Privileges<strong>${data.admin ? "Administrator" : "Standard user"}</strong></div>
            <div class="metric">Mount<strong>${escapeHtml(data.mount?.drive || data.mount?.state || "Not mounted")}</strong></div></div>
            <details><summary>Detected Apple services</summary>${diagnosticList(data.apple_services, "None detected")}</details>`;
    } catch (error) { panel.textContent = error.message; }
}

async function loadKernelDiagnostics() {
    const panel = document.getElementById("deepDiagnostics");
    panel.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Reading signed drivers, registry policy, and USB topology…';
    try {
        const data = await apiJson("/api/diagnostics/kernel");
        const kernel = data.kernel || data;
        panel.innerHTML = `<strong>Windows kernel / driver snapshot</strong><div class="metric-grid">
            <div class="metric">Admin<strong>${kernel.admin ? "Yes" : "No"}</strong></div>
            <div class="metric">Secure Boot<strong>${kernel.secure_boot == null ? "Unknown" : kernel.secure_boot ? "On" : "Off"}</strong></div>
            <div class="metric">USB devices<strong>${kernel.usb_topology?.length || 0}</strong></div>
            <div class="metric">Drivers<strong>${kernel.signed_drivers?.length || 0}</strong></div></div>
            <details><summary>Registry and USB snapshot</summary><pre>${escapeHtml(JSON.stringify(kernel, null, 2))}</pre></details>`;
    } catch (error) { panel.textContent = error.message; }
}

async function runCableBenchmark() {
    const panel = document.getElementById("deepDiagnostics");
    panel.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Reading a safe sample over USB…';
    try {
        const data = await apiJson("/api/diagnostics/cable-benchmark", {
            method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify({track_id: selectedTrackIds.size ? [...selectedTrackIds][0] : null})
        });
        panel.innerHTML = `<strong>Cable benchmark: ${escapeHtml(data.health || data.rating || data.quality || "complete")}</strong><div class="metric-grid">
            <div class="metric">Throughput<strong>${data.throughput_mbps || data.mib_per_second || data.throughput_mib_s || 0} MiB/s</strong></div>
            <div class="metric">Read sample<strong>${formatBytes(data.bytes_read || 0)}</strong></div>
            <div class="metric">Elapsed<strong>${data.elapsed_seconds || 0}s</strong></div>
            <div class="metric">Predictive score<strong>${data.predictive_health?.score == null ? "Building baseline" : `${data.predictive_health.score}/100`}</strong></div></div>
            <p>${escapeHtml(data.predictive_health?.recommendation || data.interpretation || "")}</p>`;
    } catch (error) { panel.textContent = error.message; }
}

async function toggleUsbTrace() {
    const endpoint = usbTraceRecording ? "/api/diagnostics/usb-trace/stop" : "/api/diagnostics/usb-trace/start";
    try {
        const data = await apiJson(endpoint, {method: "POST"});
        usbTraceRecording = !usbTraceRecording;
        const button = document.getElementById("usbTraceButton");
        button.innerHTML = usbTraceRecording ? '<i class="fa-solid fa-stop"></i> Stop USB Trace' : '<i class="fa-solid fa-record-vinyl"></i> Start USB Trace';
        showToast("info", "USB Trace", data.message || (usbTraceRecording ? "Recording started." : `Trace saved to ${data.path || "diagnostics folder"}.`));
    } catch (error) { showToast("error", "USB Trace Failed", error.message); }
}

async function loadConnectionTimeline() {
    const panel = document.getElementById("deepDiagnostics");
    try {
        const data = await apiJson("/api/diagnostics/timeline");
        panel.innerHTML = `<strong>Connection timeline</strong>${data.events.length ? data.events.map(event =>
            `<div class="queue-item"><span>${escapeHtml(event.timestamp || event.time || "")}</span><strong>${escapeHtml(event.event || event.state || "event")}</strong><span>${escapeHtml(event.detail || event.message || "")}</span></div>`
        ).join("") : "<br>No connection events recorded yet."}`;
    } catch (error) { panel.textContent = error.message; }
}
