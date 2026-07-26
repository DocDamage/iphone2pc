function appendTrackRow(tableBody, track) {
    const row = document.createElement("tr");
    row.id = `row_${track.id}`;
    row.className = "fade-in";
    row.innerHTML = `
        <td><input type="checkbox" class="track-select-cb" data-id="${escapeAttr(track.id)}"></td>
        <td><button class="track-play-btn" type="button"><i class="fa-solid fa-play"></i></button></td>
        <td style="font-weight:600">${escapeHtml(track.title || track.original_filename)}</td>
        <td style="color:var(--text-secondary)">${track.metadata_pending ? '<span class="metadata-pending">Read after copy</span>' : escapeHtml(track.artist || "Unknown")}</td>
        <td style="color:var(--text-muted)">${escapeHtml(track.album || "")}</td>
        <td>${escapeHtml(track.duration_str || "--")}</td>
        <td>${track.bitrate ? `${track.bitrate} kbps` : "--"}</td>
        <td>${track.filesize == null ? formatBytes(track.size_bytes) : `${track.filesize} MB`}</td>
        <td class="path-cell" title="${escapeAttr(track.iphone_path)}">${escapeHtml(track.iphone_path)}</td>`;
    row.querySelector(".track-select-cb").addEventListener("change", event => toggleTrackSelect(track.id, event.target.checked));
    row.querySelector(".track-play-btn").addEventListener("click", () => playTrack(track));
    tableBody.appendChild(row);
}

function renderMusicTable(tracks) {
    const body = document.getElementById("musicTableBody");
    selectedTrackIds.clear();
    if (!tracks?.length) {
        body.innerHTML = '<tr><td colspan="9" class="empty-state">No music files found. Try Portable Drive Explorer.</td></tr>';
    } else {
        body.innerHTML = "";
        tracks.forEach(track => appendTrackRow(body, track));
    }
    updateExportButtonState();
}

function filterMusicList() {
    const query = document.getElementById("musicSearchInput").value.toLowerCase().trim();
    const format = document.getElementById("formatFilterSelect").value.toLowerCase();
    const filtered = currentTracks.filter(track => {
        const haystack = [track.title, track.artist, track.album, track.clean_filename, track.original_filename].join(" ").toLowerCase();
        const filename = track.clean_filename || track.original_filename || "";
        return (!query || haystack.includes(query)) && (format === "all" || filename.toLowerCase().endsWith(format));
    });
    renderMusicTable(filtered);
}

function toggleTrackSelect(trackId, checked) {
    checked ? selectedTrackIds.add(trackId) : selectedTrackIds.delete(trackId);
    updateExportButtonState();
}

function toggleSelectAll(master) {
    document.querySelectorAll(".track-select-cb").forEach(checkbox => {
        checkbox.checked = master.checked;
        toggleTrackSelect(checkbox.dataset.id, master.checked);
    });
}

function updateExportButtonState() {
    const selected = document.getElementById("btnExportSelected");
    const all = document.getElementById("btnExportAll");
    const analyze = document.getElementById("btnAnalyzeSelected");
    if (selected) {
        selected.disabled = !selectedTrackIds.size;
        selected.innerHTML = `<i class="fa-solid fa-file-export"></i> ${selectedTrackIds.size ? `Queue (${selectedTrackIds.size})` : "Queue Selected"}`;
    }
    if (all) {
        all.disabled = !currentTracks.length;
        all.innerHTML = `<i class="fa-solid fa-download"></i> ${currentTracks.length ? `Queue All (${currentTracks.length})` : "Queue All to PC"}`;
    }
    if (analyze) analyze.disabled = !selectedTrackIds.size;
    const bar = document.getElementById("selectionActionBar");
    if (bar) bar.hidden = selectedTrackIds.size === 0;
    const summary = document.getElementById("selectedTrackSummary");
    if (summary) summary.textContent = `${selectedTrackIds.size} track${selectedTrackIds.size === 1 ? "" : "s"} selected`;
}

async function exportAll() {
    selectedTrackIds = new Set(currentTracks.map(track => track.id));
    document.querySelectorAll(".track-select-cb").forEach(checkbox => { checkbox.checked = true; });
    updateExportButtonState();
    await exportSelected();
}

async function exportSelected() {
    if (!selectedTrackIds.size) return;
    const outputDir = document.getElementById("exportPathInput").value.trim();
    if (!outputDir) {
        showToast("warning", "Choose a Save Folder", "Enter the PC folder where recovered audio should be stored.");
        return;
    }
    const trackIds = [...selectedTrackIds];
    const button = document.getElementById("btnExportSelected");
    button.disabled = true;
    button.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Queueing...';
    try {
        const preflight = await apiJson("/api/music/preflight", {
            method: "POST", headers: {"Content-Type": "application/json"},
            body: JSON.stringify({track_ids: trackIds, output_dir: outputDir})
        });
        if (!preflight.can_export) throw new Error(`Not enough free space. ${preflight.free_size} is available.`);
        const backup = document.getElementById("backupPathInput").value.trim();
        const job = await apiJson("/api/recovery/jobs", {
            method: "POST", headers: {"Content-Type": "application/json"},
            body: JSON.stringify({track_ids: trackIds, output_dir: outputDir, backup_dir: backup || null,
                structure: document.getElementById("exportStructureSelect").value})
        });
        showToast("success", "Recovery Queued", `${job.job.items.length} selected file(s) added to the verified recovery queue.`, 7000);
        await loadRecoveryJobs();
    } catch (error) {
        showToast("error", "Could Not Queue Recovery", error.message, 7000);
    } finally {
        updateExportButtonState();
    }
}

async function openPcFolder() {
    const path = document.getElementById("exportPathInput").value.trim();
    if (!path) return showToast("warning", "Folder Needed", "Enter a PC folder first.");
    try {
        await apiJson("/api/open-folder", {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify({path})});
    } catch (error) { showToast("error", "Could Not Open Folder", error.message); }
}
