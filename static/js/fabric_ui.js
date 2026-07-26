let fabricBackupAssets = [];

function fabricLines(id) {
    return document.getElementById(id).value.split(/\r?\n/).map(value => value.trim()).filter(Boolean);
}

async function fabricRequest(url, options = {}) {
    const response = await fetch(url, options);
    const data = await response.json();
    if (!response.ok) throw new Error(data.detail || `Request failed (${response.status})`);
    return data;
}

function fabricBytes(value) {
    return new Intl.NumberFormat(undefined, { notation: "compact", style: "unit", unit: "byte" }).format(value || 0);
}

async function loadFabricDashboard() {
    try {
        const [status, backups] = await Promise.all([
            fabricRequest("/api/fabric/status"), fabricRequest("/api/fabric/backups")
        ]);
        const metrics = document.querySelectorAll("#fabricMetrics .fabric-metric strong");
        metrics[0].textContent = status.device_events.mode;
        metrics[1].textContent = `${status.vault.manifests} files · ${fabricBytes(status.vault.stored_bytes)}`;
        metrics[2].textContent = `${backups.count} found`;
        metrics[3].textContent = status.diagnostics.score == null
            ? "No baseline" : `${status.diagnostics.score}/100 · ${status.diagnostics.state}`;
        const select = document.getElementById("fabricBackupSelect");
        select.innerHTML = backups.backups.length
            ? backups.backups.map(item => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.device_name || item.id)} · ${escapeHtml(item.last_backup || "unknown date")}${item.encrypted ? " · locked" : ""}</option>`).join("")
            : '<option value="">No local Apple backups found</option>';
        renderFabricAI(status.intelligence.local_ai, status.hydration, status.provenance);
        renderFabricDiagnostics(status.diagnostics, status.device_events);
        renderFabricWireless(status.wireless);
        document.getElementById("fabricProvenanceResult").textContent =
            `${status.provenance.algorithm} · key protected by ${status.provenance.protected_by}`;
    } catch (error) {
        showToast("error", "Recovery Fabric", error.message);
    }
}

function renderFabricWireless(wireless) {
    const panel = document.getElementById("fabricWirelessResult");
    if (!wireless.running) {
        panel.textContent = "Off · no LAN port is open";
        return;
    }
    panel.innerHTML = `<strong>${escapeHtml(wireless.endpoint)}</strong><br>
        Certificate SHA-256<br><code>${escapeHtml(wireless.certificate_sha256 || "")}</code><br>
        <small>${wireless.paired_tokens} paired token(s) · exchange ${escapeHtml(wireless.exchange_root)}</small>`;
}

function renderFabricAI(ai, hydration, provenance) {
    const providers = ai.execution_providers.length ? ai.execution_providers.join(", ") : "signal analysis only";
    document.getElementById("fabricAIStatus").innerHTML = `
        <div class="metric-grid">
            <div class="metric"><span>Inference</span><strong>${escapeHtml(providers)}</strong></div>
            <div class="metric"><span>Demucs</span><strong>${ai.demucs ? "ready" : "optional"}</strong></div>
            <div class="metric"><span>Hydrated</span><strong>${escapeHtml(fabricBytes(hydration.stored_bytes))}</strong></div>
            <div class="metric"><span>C2PA</span><strong>${provenance.c2pa_backend ? "backend ready" : "signed JSON"}</strong></div>
        </div>`;
}

function renderFabricDiagnostics(prediction, events) {
    const panel = document.getElementById("fabricDiagnosticResult");
    panel.className = `fabric-diagnostic ${prediction.state || "unknown"}`;
    panel.innerHTML = `<strong>${escapeHtml((prediction.state || "unknown").toUpperCase())}${prediction.score == null ? "" : ` · ${prediction.score}/100`}</strong><br>
        ${escapeHtml(prediction.recommendation)}<br><small>${prediction.samples} benchmark samples · reconnect: ${escapeHtml(events.mode)}</small>`;
}

async function searchBeatDNA() {
    const query = document.getElementById("fabricSearchQuery").value;
    const panel = document.getElementById("fabricSearchResults");
    panel.textContent = "Searching locally…";
    try {
        const data = await fabricRequest(`/api/fabric/intelligence/search?query=${encodeURIComponent(query)}`);
        panel.innerHTML = data.results.length ? data.results.map(item => {
            const track = item.track;
            return `<div class="fabric-result"><div class="fabric-result-main"><div class="fabric-result-title">${escapeHtml(track.title || track.original_filename || "Untitled")}</div><div class="fabric-result-meta">${escapeHtml(track.artist || "Unknown artist")} · ${escapeHtml(item.reasons.join(", ") || "catalog match")}</div></div><span class="fabric-score">${Math.round(item.score * 100)}%</span></div>`;
        }).join("") : "No Beat DNA matches yet. Analyze tracks in Recovery Lab to deepen similarity results.";
    } catch (error) { panel.textContent = error.message; }
}

async function loadBeatGraph() {
    const panel = document.getElementById("fabricSearchResults");
    panel.textContent = "Building relationships…";
    try {
        const graph = await fabricRequest("/api/fabric/intelligence/graph");
        const kinds = graph.edges.reduce((counts, edge) => ({ ...counts, [edge.kind]: (counts[edge.kind] || 0) + 1 }), {});
        panel.innerHTML = `<div class="metric-grid"><div class="metric"><span>Tracks</span><strong>${graph.nodes.length}</strong></div><div class="metric"><span>Analyzed</span><strong>${graph.analyzed}</strong></div><div class="metric"><span>Relationships</span><strong>${graph.edges.length}</strong></div></div><pre>${escapeHtml(JSON.stringify(kinds, null, 2))}</pre>`;
    } catch (error) { panel.textContent = error.message; }
}

async function scanFabricBackup() {
    const id = document.getElementById("fabricBackupSelect").value;
    const panel = document.getElementById("fabricBackupFiles");
    if (!id) return showToast("warning", "Backup Fusion", "No local backup is available.");
    panel.textContent = "Reading the backup manifest without modifying it…";
    try {
        const data = await fabricRequest(`/api/fabric/backups/${encodeURIComponent(id)}/scan`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ include_all: document.getElementById("fabricBackupAll").checked })
        });
        fabricBackupAssets = data.assets;
        panel.innerHTML = data.assets.length ? data.assets.map(item => `<label class="fabric-result"><input type="checkbox" class="fabric-backup-file" value="${escapeHtml(item.file_id)}"><span class="fabric-result-main"><span class="fabric-result-title">${escapeHtml(item.name || item.relative_path)}</span><span class="fabric-result-meta">${escapeHtml(item.domain)} · ${escapeHtml(fabricBytes(item.size_bytes))}</span></span></label>`).join("") : "No matching files found.";
    } catch (error) { panel.textContent = error.message; }
}

async function extractFabricBackup() {
    const id = document.getElementById("fabricBackupSelect").value;
    const selected = [...document.querySelectorAll(".fabric-backup-file:checked")].map(input => input.value);
    if (!id || !selected.length) return showToast("warning", "Backup Fusion", "Select files to recover.");
    try {
        const data = await fabricRequest(`/api/fabric/backups/${encodeURIComponent(id)}/extract`, {
            method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
                file_ids: selected, output_directory: document.getElementById("fabricBackupOutput").value || undefined,
                ingest_vault: true
            })
        });
        showToast("success", "Backup files recovered", `${data.count} selected files extracted and preserved.`);
        document.getElementById("fabricBackupFiles").textContent = data.files.map(item => item.path).join("\n");
        loadFabricDashboard();
    } catch (error) { showToast("error", "Backup extraction", error.message); }
}

async function ingestFabricVault() {
    const paths = fabricLines("fabricVaultPaths");
    if (!paths.length) return showToast("warning", "Recovery vault", "Enter at least one existing file path.");
    try {
        const data = await fabricRequest("/api/fabric/vault/ingest", {
            method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ paths, source_kind: "owner_selected" })
        });
        document.getElementById("fabricVaultResults").textContent = data.manifests.map(item => `${item.display_name} · ${item.merkle_root}`).join("\n");
        showToast("success", "Files preserved", `${data.count} manifests committed.`);
        loadFabricDashboard();
    } catch (error) { showToast("error", "Recovery vault", error.message); }
}

async function loadVaultManifests() {
    const panel = document.getElementById("fabricVaultResults");
    try {
        const data = await fabricRequest("/api/fabric/vault/manifests?limit=50");
        panel.innerHTML = data.manifests.length ? data.manifests.map(item => `<div class="fabric-result"><div class="fabric-result-main"><div class="fabric-result-title">${escapeHtml(item.display_name)}</div><div class="fabric-result-meta">${escapeHtml(item.source_kind)} · ${escapeHtml(fabricBytes(item.size))}</div></div><button class="btn btn-small" onclick="verifyVaultManifest('${escapeHtml(item.id)}')">Verify</button></div>`).join("") : "The vault is empty.";
    } catch (error) { panel.textContent = error.message; }
}

async function verifyVaultManifest(id) {
    try {
        const data = await fabricRequest(`/api/fabric/vault/verify/${encodeURIComponent(id)}`);
        showToast(data.valid ? "success" : "error", "Vault verification", data.valid ? `${data.chunk_count} chunks verified.` : "Missing or damaged chunks found.");
    } catch (error) { showToast("error", "Vault verification", error.message); }
}

async function createFabricProvenance() {
    const paths = fabricLines("fabricProvenancePaths");
    if (!paths.length) return showToast("warning", "Provenance", "Enter at least one recovered file path.");
    try {
        const data = await fabricRequest("/api/fabric/provenance/create", {
            method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
                paths, output_path: document.getElementById("fabricProvenanceOutput").value || undefined,
                assertions: { creator_controlled: true, purpose: "original beat recovery" }
            })
        });
        document.getElementById("fabricProvenanceOutput").value = data.path;
        document.getElementById("fabricProvenanceResult").textContent = `Signed ${data.ingredients} ingredients · key ${data.key_id} · Merkle ${data.collection_merkle_root}`;
    } catch (error) { showToast("error", "Provenance", error.message); }
}

async function verifyFabricProvenance() {
    const path = document.getElementById("fabricProvenanceOutput").value;
    if (!path) return showToast("warning", "Provenance", "Enter a claim path to verify.");
    try {
        const data = await fabricRequest("/api/fabric/provenance/verify", {
            method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path })
        });
        showToast(data.valid ? "success" : "error", "Provenance verification", data.valid ? "Signature is valid." : "Claim verification failed.");
    } catch (error) { showToast("error", "Provenance", error.message); }
}

async function clearHydrationCache() {
    try {
        const data = await fabricRequest("/api/fabric/hydration/clear", { method: "POST" });
        showToast("success", "Hydration cache cleared", `${data.blocks_removed} cached blocks removed.`);
        loadFabricDashboard();
    } catch (error) { showToast("error", "Hydration cache", error.message); }
}

async function controlDeviceEvents(action) {
    try {
        const data = await fabricRequest(`/api/fabric/device-events/${action}`, { method: "POST" });
        showToast("success", "Device event engine", `${data.mode}`);
        loadFabricDashboard();
    } catch (error) { showToast("error", "Device event engine", error.message); }
}

async function controlFabricWireless(action) {
    try {
        const data = await fabricRequest(`/api/fabric/wireless/${action}`, { method: "POST" });
        renderFabricWireless(data);
        if (action === "start") {
            document.getElementById("fabricWirelessResult").innerHTML += `<br><strong>Pairing code: ${escapeHtml(data.code)}</strong><br><small>Expires in five minutes. Enter the endpoint, code, and certificate hash in the iPhone app.</small>`;
            showToast("success", "Secure companion exchange", "Pairing is open for five minutes.");
        } else showToast("success", "Secure companion exchange", "The LAN endpoint is closed.");
    } catch (error) { showToast("error", "Secure companion exchange", error.message); }
}
