async function decodeMusicLibrary(silent = false) {
    const button = document.getElementById("btnDecodeLibrary");
    if (button) { button.disabled = true; button.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Decoding…'; }
    try {
        const data = await apiJson("/api/library/decode", {method: "POST"});
        if (!silent) showToast("success", "Library Decoded", `${data.decoded_count} records decoded from Apple's media database.`);
        const panel = document.getElementById("intelligenceResults");
        if (panel) panel.textContent = `${data.decoded_count} decoded records · ${data.active_scan_matches} active scan matches · ${data.playlist_count} playlists`;
        return data;
    } catch (error) {
        if (!silent) showToast("warning", "Library Decode Unavailable", error.message);
        return null;
    } finally {
        if (button) { button.disabled = false; button.innerHTML = '<i class="fa-solid fa-wand-magic-sparkles"></i> Decode Library'; }
    }
}

async function loadCatalogFilters(silent = false) {
    const query = document.getElementById("musicSearchInput").value.trim();
    const extension = document.getElementById("formatFilterSelect").value;
    const mystery = document.getElementById("mysteryOnlyCheckbox").checked;
    const params = new URLSearchParams();
    if (query) params.set("search", query);
    if (extension !== "all") params.set("extension", extension);
    if (mystery) params.set("mystery_only", "true");
    try {
        const data = await apiJson(`/api/library/tracks?${params}`);
        currentTracks = data.tracks || [];
        renderMusicTable(currentTracks);
        if (!silent) showToast("info", "Catalog Loaded", `${data.count} matching track(s).`);
    } catch (error) { if (!silent) showToast("error", "Catalog Query Failed", error.message); }
}

async function analyzeSelected() {
    if (!selectedTrackIds.size) return showToast("warning", "Choose Beats", "Select one or more tracks to analyze locally.");
    const panel = document.getElementById("intelligenceResults");
    panel.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Analyzing recovered audio locally…';
    try {
        const data = await apiJson("/api/analysis/tracks", {
            method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify({track_ids: [...selectedTrackIds]})
        });
        panel.innerHTML = (data.results || []).map(result => {
            const analysis = result.analysis;
            const waveform = (analysis.waveform || []).filter((_, index) => index % 8 === 0)
                .map(value => `<i style="height:${Math.max(2, value * 30)}px"></i>`).join("");
            return `<div class="queue-job complete"><strong>${escapeHtml(result.title)}</strong><div class="metric-grid">
                <div class="metric">BPM<strong>${analysis.bpm || "—"}</strong></div><div class="metric">Key<strong>${escapeHtml(analysis.key || "—")}</strong></div>
                <div class="metric">Loudness<strong>${analysis.loudness} dBFS</strong></div><div class="metric">Audio<strong>${analysis.sample_rate} Hz · ${analysis.channels}ch</strong></div>
                </div><div class="mini-waveform">${waveform}</div></div>`;
        }).join("") || "No tracks could be analyzed.";
        showToast(data.failed_count ? "warning" : "success", "Analysis Complete", `${data.analyzed_count} analyzed · ${data.failed_count} failed.`);
    } catch (error) { panel.textContent = error.message; }
}

async function loadVersionGroups() {
    const panel = document.getElementById("intelligenceResults");
    panel.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Comparing fingerprints…';
    try {
        const data = await apiJson("/api/library/version-groups");
        panel.innerHTML = data.groups.length ? data.groups.map((group, index) =>
            `<div class="queue-job"><strong>Version group ${index + 1}</strong> · ${escapeHtml(group.kind)}<br>${group.tracks.map(track => escapeHtml(track.title)).join(" ↔ ")}</div>`
        ).join("") : "No exact or acoustic versions found among analyzed tracks.";
    } catch (error) { panel.textContent = error.message; }
}

async function previewProjectBundle() {
    if (selectedTrackIds.size !== 1) return showToast("warning", "Choose One Beat", "Select exactly one beat to search for stems and project files.");
    const trackId = [...selectedTrackIds][0];
    const panel = document.getElementById("intelligenceResults");
    panel.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Searching the source folder…';
    try {
        lastProjectBundle = await apiJson(`/api/projects/bundle/${encodeURIComponent(trackId)}`);
        const entries = lastProjectBundle.candidates.map(item => `${item.is_dir ? "📁" : "📄"} ${escapeHtml(item.name)}`).join("<br>");
        panel.innerHTML = `<strong>${lastProjectBundle.count} related item(s)</strong><br>${entries}<div class="queue-actions"><button id="recoverBundleButton" class="btn btn-primary btn-sm">Recover This Bundle</button></div>`;
        document.getElementById("recoverBundleButton").addEventListener("click", recoverLastProjectBundle);
    } catch (error) { panel.textContent = error.message; }
}

async function recoverLastProjectBundle() {
    if (!lastProjectBundle) return;
    try {
        const data = await apiJson(`/api/projects/bundle/${encodeURIComponent(lastProjectBundle.track.id)}/recover`, {
            method: "POST", headers: {"Content-Type": "application/json"},
            body: JSON.stringify({paths: lastProjectBundle.candidates.map(item => item.path), output_dir: document.getElementById("exportPathInput").value.trim()})
        });
        showToast("success", "Project Bundle Recovered", `${data.count} verified file(s) saved to ${data.output_directory}.`, 8000);
    } catch (error) { showToast("error", "Bundle Recovery Failed", error.message); }
}
