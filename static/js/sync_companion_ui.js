async function createSyncProfile(enabled) {
    const localRoot = document.getElementById("syncLocalPathInput").value.trim();
    if (!localRoot) return showToast("warning", "PC Folder Needed", "Enter the folder to synchronize.");
    try {
        const profile = await apiJson("/api/sync/profiles", {
            method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify({local_root: localRoot, enabled})
        });
        if (!enabled) await runSyncProfile(profile.id);
        else showToast("success", "Auto-Sync Enabled", "Portable Files will be checked while this app is running.");
        await loadSyncProfiles();
    } catch (error) { showToast("error", "Sync Setup Failed", error.message); }
}

async function loadSyncProfiles() {
    const panel = document.getElementById("syncResults");
    if (!panel) return;
    try {
        const [profileData, conflictData] = await Promise.all([apiJson("/api/sync/profiles"), apiJson("/api/sync/conflicts")]);
        panel.innerHTML = "";
        if (!profileData.profiles.length) panel.textContent = "No sync profiles yet.";
        profileData.profiles.forEach(profile => {
            const row = document.createElement("div");
            row.className = "queue-job";
            row.innerHTML = `<strong>${escapeHtml(profile.local_root)}</strong><br><span>${profile.enabled ? "Auto-sync enabled" : "Manual"} · ${escapeHtml(profile.last_status || "never run")}</span><div class="queue-actions"></div>`;
            row.querySelector(".queue-actions").append(textButton("Sync now", () => runSyncProfile(profile.id)),
                textButton(profile.enabled ? "Disable auto" : "Enable auto", () => setSyncEnabled(profile.id, !profile.enabled)));
            panel.appendChild(row);
        });
        conflictData.conflicts.forEach(conflict => panel.appendChild(renderSyncConflict(conflict)));
    } catch (error) { panel.textContent = error.message; }
}

function renderSyncConflict(conflict) {
    const row = document.createElement("div");
    row.className = "queue-job failed";
    row.innerHTML = `<strong>Conflict: ${escapeHtml(conflict.relative_path)}</strong><div class="queue-actions"></div>`;
    row.querySelector(".queue-actions").append(textButton("Use PC", () => resolveSync(conflict.id, "pc")),
        textButton("Use iPhone", () => resolveSync(conflict.id, "phone")),
        textButton("Keep both", () => resolveSync(conflict.id, "keep_both")));
    return row;
}

async function runSyncProfile(profileId) {
    try {
        const data = await apiJson(`/api/sync/profiles/${profileId}/run`, {method: "POST"});
        showToast("success", "Sync Complete", `${data.uploaded || 0} uploaded · ${data.downloaded || 0} downloaded · ${data.conflicts || 0} conflicts.`);
        await loadSyncProfiles();
    } catch (error) { showToast("error", "Sync Failed", error.message); }
}

async function setSyncEnabled(profileId, enabled) {
    try {
        await apiJson(`/api/sync/profiles/${profileId}/enable`, {
            method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify({enabled})
        });
        await loadSyncProfiles();
    } catch (error) { showToast("error", "Sync Update Failed", error.message); }
}

async function resolveSync(conflictId, choice) {
    try {
        await apiJson(`/api/sync/conflicts/${conflictId}/resolve`, {
            method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify({choice})
        });
        await loadSyncProfiles();
    } catch (error) { showToast("error", "Conflict Resolution Failed", error.message); }
}

async function loadCompanionStatus() {
    const panel = document.getElementById("companionResults");
    if (!panel) return;
    try {
        const data = await apiJson("/api/companion/status");
        panel.innerHTML = data.available
            ? `<strong>Companion connected</strong><br>${escapeHtml(data.name || data.bundle_id || "iDrivePulse Companion")} · writable Documents vault ready.`
            : `<strong>Companion not installed or not exposed.</strong><br>${escapeHtml(data.message || "Build the included iOS companion in Xcode, then reconnect the phone.")}`;
    } catch (error) { panel.textContent = error.message; }
}
