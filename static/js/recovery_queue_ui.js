async function loadRecoveryJobs() {
    const panel = document.getElementById("recoveryJobs");
    if (!panel) return;
    try {
        const data = await apiJson("/api/recovery/jobs");
        recoveryJobsCache = data.jobs || [];
        if (!recoveryJobsCache.length) {
            panel.textContent = "No recovery jobs yet. Select tracks in Music & Beats and click Queue Selected.";
            return;
        }
        panel.innerHTML = "";
        recoveryJobsCache.forEach(job => panel.appendChild(renderRecoveryJob(job)));
    } catch (error) { panel.textContent = error.message; }
}

function renderRecoveryJob(job) {
    const card = document.createElement("div");
    const complete = job.items.filter(item => item.status === "complete").length;
    const failed = job.items.filter(item => ["failed", "interrupted"].includes(item.status)).length;
    card.className = `queue-job ${job.status.startsWith("completed") ? "complete" : failed ? "failed" : ""}`;
    card.innerHTML = `<strong>${escapeHtml(job.status.replaceAll("_", " "))}</strong> · ${complete}/${job.items.length} complete · ${job.progress}%<br>
        <span>${escapeHtml(job.output_dir)}${job.backup_dir ? ` ↔ ${escapeHtml(job.backup_dir)}` : ""}</span><div class="queue-items"></div><div class="queue-actions"></div>`;
    const items = card.querySelector(".queue-items");
    job.items.forEach((item, index) => {
        const row = document.createElement("div");
        row.className = "queue-item";
        row.innerHTML = `<span>${escapeHtml(item.title)} · ${escapeHtml(item.status)}</span>`;
        row.append(actionButton("fa-arrow-up", "Move up", () => moveQueueItem(job.id, item.track_id, -1)),
            actionButton("fa-arrow-down", "Move down", () => moveQueueItem(job.id, item.track_id, 1)));
        row.children[1].disabled = index === 0;
        row.children[2].disabled = index === job.items.length - 1;
        items.appendChild(row);
    });
    const actions = card.querySelector(".queue-actions");
    actions.append(textButton(job.status === "paused" ? "Resume" : "Pause", () => recoveryAction(job.id, job.status === "paused" ? "resume" : "pause")),
        textButton("Retry failures", () => recoveryAction(job.id, "retry")), textButton("Encrypt Vault", () => createVault(job.id)));
    if (job.report) actions.appendChild(textButton("Open Report Folder", () => openFolderPath(job.output_dir)));
    return card;
}

function textButton(label, handler) {
    const button = document.createElement("button");
    button.className = "btn btn-secondary btn-sm";
    button.textContent = label;
    button.addEventListener("click", handler);
    return button;
}

async function recoveryAction(jobId, action) {
    try {
        await apiJson(`/api/recovery/jobs/${jobId}/${action}`, {method: "POST"});
        await loadRecoveryJobs();
    } catch (error) { showToast("error", "Queue Action Failed", error.message); }
}

async function moveQueueItem(jobId, trackId, direction) {
    const job = recoveryJobsCache.find(item => item.id === jobId);
    if (!job) return;
    const order = job.items.map(item => item.track_id);
    const index = order.indexOf(trackId);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= order.length) return;
    [order[index], order[target]] = [order[target], order[index]];
    try {
        await apiJson(`/api/recovery/jobs/${jobId}/reorder`, {
            method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify({track_ids: order})
        });
        await loadRecoveryJobs();
    } catch (error) { showToast("error", "Could Not Reorder", error.message); }
}

async function createVault(jobId) {
    const passphrase = document.getElementById("vaultPassphraseInput").value;
    const vaultPath = document.getElementById("vaultPathInput").value.trim();
    if (passphrase.length < 12) return showToast("warning", "Longer Passphrase Needed", "Use at least 12 characters.");
    try {
        const data = await apiJson("/api/vault/create", {
            method: "POST", headers: {"Content-Type": "application/json"},
            body: JSON.stringify({job_id: jobId, passphrase, vault_path: vaultPath || null})
        });
        showToast("success", "Encrypted Vault Created", data.path, 8000);
    } catch (error) { showToast("error", "Vault Creation Failed", error.message); }
}

async function openFolderPath(path) {
    try {
        await apiJson("/api/open-folder", {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify({path})});
    } catch (error) { showToast("error", "Could Not Open Folder", error.message); }
}
