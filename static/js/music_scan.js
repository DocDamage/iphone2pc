// ===== MUSIC SCANNING (SSE) =====

let sseSource = null;

async function scanMusicSSE() {
    const tableBody = document.getElementById("musicTableBody");
    const btnScan = document.getElementById("btnScanMusic");
    const progressPanel = document.getElementById("scanProgress");
    const progressLabel = document.getElementById("scanProgressLabel");
    const progressStats = document.getElementById("scanProgressStats");
    const progressFill = document.getElementById("scanProgressFill");
    const progressLog = document.getElementById("scanProgressLog");

    // Decode Apple's hashed filenames first when the library database is exposed.
    await decodeMusicLibrary(true);

    // Reset state
    currentTracks = [];
    selectedTrackIds.clear();
    updateExportButtonState();
    tableBody.innerHTML = "";
    btnScan.disabled = true;
    btnScan.innerHTML = `<i class="fa-solid fa-satellite-dish fa-spin"></i> Scanning...`;

    // Show progress panel
    progressPanel.classList.add("active");
    progressFill.style.width = "30%";
    progressLog.innerHTML = "";

    // Close any prior SSE connection
    if (sseSource) { sseSource.close(); sseSource = null; }

    try {
        sseSource = new EventSource("/api/music/scan-stream");

        sseSource.addEventListener("scan_start", (e) => {
            const d = JSON.parse(e.data);
            progressLabel.innerText = `Scanning ${d.roots.length} root directories...`;
            appendScanLog(progressLog, `Starting scan of: ${d.roots.join(", ")}`);
        });

        sseSource.addEventListener("scanning_root", (e) => {
            const d = JSON.parse(e.data);
            appendScanLog(progressLog, `Entering: ${d.root}`);
        });

        sseSource.addEventListener("progress", (e) => {
            const d = JSON.parse(e.data);
            progressStats.innerText = `${d.tracks_found} tracks — ${d.dirs_scanned} dirs scanned`;
        });

        sseSource.addEventListener("warning", (e) => {
            const d = JSON.parse(e.data);
            appendScanLog(progressLog, `Warning: ${d.message}`);
        });

        sseSource.addEventListener("track_found", (e) => {
            const track = JSON.parse(e.data);
            currentTracks.push(track);
            progressStats.innerText = `${currentTracks.length} tracks found`;
            appendScanLog(progressLog, `Found: ${track.title} (${track.original_filename})`);

            // Append row to table live
            appendTrackRow(tableBody, track);
            updateExportButtonState();
        });

        sseSource.addEventListener("scan_error", (e) => {
            const d = JSON.parse(e.data);
            showToast("error", "Scan Error", d.message);
            finishScan();
        });

        sseSource.addEventListener("scan_complete", (e) => {
            const d = JSON.parse(e.data);
            progressLabel.innerText = "Scan complete!";
            progressFill.style.width = "100%";
            progressFill.style.animation = "none";
            progressStats.innerText = `${d.total_tracks} tracks found across ${d.total_dirs} directories`;

            if (d.total_tracks === 0) {
                showToast("info", "Scan Complete", "No audio files found in standard iOS media folders. Try the Portable Drive tab.");
                tableBody.innerHTML = `
                    <tr><td colspan="9" style="text-align: center; color: var(--text-muted); padding: 40px;">
                        No audio files found. Use the <strong>Portable Drive</strong> tab to browse all files.
                    </td></tr>`;
            } else {
                showToast("success", "Scan Complete", `Found ${d.total_tracks} tracks. Choose files to copy safely to this PC.`);
            }
            finishScan();
        });

        // Native EventSource error (connection issue). A normal completed stream is
        // closed explicitly by scan_complete before the browser retries it.
        sseSource.onerror = () => {
            // SSE stream ended or failed — check if we got any tracks
            if (currentTracks.length > 0) {
                showToast("info", "Scan Stream Ended", `${currentTracks.length} tracks discovered.`);
            }
            finishScan();
        };

    } catch (err) {
        showToast("error", "Scan Failed", err.message);
        finishScan();
    }
}

function finishScan() {
    if (sseSource) { sseSource.close(); sseSource = null; }
    const btnScan = document.getElementById("btnScanMusic");
    btnScan.disabled = false;
    btnScan.innerHTML = `<i class="fa-solid fa-magnifying-glass"></i> Scan iPhone`;

    // Hide progress after a delay
    setTimeout(() => {
        const panel = document.getElementById("scanProgress");
        panel.classList.remove("active");
    }, 3000);
}

function appendScanLog(logEl, text) {
    const line = document.createElement("div");
    line.textContent = `> ${text}`;
    logEl.appendChild(line);
    logEl.scrollTop = logEl.scrollHeight;
}

// Fallback: original synchronous scan
async function scanMusic() {
    const tableBody = document.getElementById("musicTableBody");
    const btnScan = document.getElementById("btnScanMusic");

    btnScan.disabled = true;
    btnScan.innerHTML = `<i class="fa-solid fa-compact-disc fa-spin"></i> Scanning...`;

    tableBody.innerHTML = `
        <tr><td colspan="9" style="text-align: center; color: var(--text-muted); padding: 50px;">
            <i class="fa-solid fa-magnifying-glass fa-bounce" style="font-size: 32px; color: var(--primary); margin-bottom: 16px;"></i><br>
            Scanning iPhone storage for audio files...<br>
            <small>This may take a minute...</small>
        </td></tr>`;

    try {
        const res = await fetch("/api/music/scan");
        const data = await res.json();
        if (!res.ok) throw new Error(data.detail || "Scanning failed.");
        currentTracks = data.tracks || [];
        renderMusicTable(currentTracks);

        if (currentTracks.length > 0) {
            showToast("success", "Scan Complete", `Found ${currentTracks.length} tracks.`);
        } else {
            showToast("info", "No Tracks Found", "Try browsing in the Portable Drive tab.");
        }
    } catch (err) {
        tableBody.innerHTML = `
            <tr><td colspan="9" style="text-align: center; color: #EF4444; padding: 40px;">
                <i class="fa-solid fa-triangle-exclamation" style="font-size: 28px; margin-bottom: 12px;"></i><br>
                <strong>Scan failed:</strong> ${escapeHtml(err.message)}<br>
                <small style="color: var(--text-muted);">Ensure iPhone is connected, unlocked, and trusted.</small>
            </td></tr>`;
        showToast("error", "Scan Failed", err.message);
    } finally {
        btnScan.disabled = false;
        btnScan.innerHTML = `<i class="fa-solid fa-magnifying-glass"></i> Scan iPhone`;
    }
}
