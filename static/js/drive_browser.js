async function loadDrivePath(path = "/") {
    const list = document.getElementById("fileExplorerList");
    list.innerHTML = '<div class="empty-state"><i class="fa-solid fa-spinner fa-spin"></i> Reading iPhone…</div>';
    try {
        const data = await apiJson(`/api/drive/list?path=${encodeURIComponent(path)}`);
        currentDrivePath = data.current_path;
        parentPath = data.parent_path;
        currentDriveWritable = Boolean(data.writable);
        driveSelectedPaths.clear();
        renderBreadcrumb(currentDrivePath);
        document.getElementById("goUpBtn").style.display = parentPath == null ? "none" : "inline-flex";
        document.getElementById("btnCreateFolder").disabled = !currentDriveWritable;
        document.getElementById("btnUploadFiles").disabled = !currentDriveWritable;
        document.getElementById("dropZone").classList.toggle("active", currentDriveWritable);
        const mode = document.getElementById("driveModeBadge");
        if (mode) mode.innerHTML = currentDriveWritable
            ? '<i class="fa-solid fa-pen"></i> Portable Files · writable'
            : '<i class="fa-solid fa-eye"></i> Read-only browsing';
        renderDriveItems(data.items || []);
        updateBatchButton();
    } catch (error) {
        list.innerHTML = `<div class="empty-state error">${escapeHtml(error.message)}</div>`;
        showToast("error", "Could Not Browse iPhone", error.message);
    }
}

function renderDriveItems(items) {
    const list = document.getElementById("fileExplorerList");
    if (!items.length) {
        list.innerHTML = '<div class="empty-state">This folder is empty.</div>';
        return;
    }
    list.innerHTML = "";
    items.forEach(item => {
        const row = document.createElement("div");
        row.className = "explorer-file-item";
        row.innerHTML = `
            <input type="checkbox" class="drive-select" ${item.is_dir ? "disabled" : ""}>
            <i class="fa-solid ${item.is_dir ? "fa-folder" : getFileIcon(item.name)} file-icon"></i>
            <div class="file-main"><strong>${escapeHtml(item.name)}</strong><span>${escapeHtml(item.mtime || "--")}</span></div>
            <span class="file-size">${escapeHtml(item.size_str || "--")}</span>
            <div class="file-actions"></div>`;
        if (item.is_dir) {
            row.querySelector(".file-main").addEventListener("dblclick", () => loadDrivePath(item.path));
            const open = actionButton("fa-folder-open", "Open", () => loadDrivePath(item.path));
            row.querySelector(".file-actions").appendChild(open);
        } else {
            row.querySelector(".drive-select").addEventListener("change", event => toggleDriveSelection(item.path, event.target.checked));
            row.querySelector(".file-actions").appendChild(actionButton("fa-download", "Download", () => downloadFile(item.path)));
        }
        if (currentDriveWritable) row.querySelector(".file-actions").appendChild(actionButton("fa-trash", "Delete", () => deleteDriveItem(item.path)));
        list.appendChild(row);
    });
}

function actionButton(icon, title, handler) {
    const button = document.createElement("button");
    button.className = "icon-btn";
    button.title = title;
    button.innerHTML = `<i class="fa-solid ${icon}"></i>`;
    button.addEventListener("click", handler);
    return button;
}

function renderBreadcrumb(path) {
    const nav = document.getElementById("breadcrumbNav");
    nav.innerHTML = "";
    const root = document.createElement("span");
    root.className = "breadcrumb-segment";
    root.textContent = "/";
    root.addEventListener("click", () => loadDrivePath("/"));
    nav.appendChild(root);
    let built = "";
    path.split("/").filter(Boolean).forEach(part => {
        built += `/${part}`;
        const target = built;
        const separator = document.createTextNode("›");
        const node = document.createElement("span");
        node.className = "breadcrumb-segment";
        node.textContent = part;
        node.addEventListener("click", () => loadDrivePath(target));
        nav.append(separator, node);
    });
}

function goUpDirectory() {
    if (parentPath != null) loadDrivePath(parentPath);
}

function toggleDriveSelection(path, checked) {
    checked ? driveSelectedPaths.add(path) : driveSelectedPaths.delete(path);
    updateBatchButton();
}

function updateBatchButton() {
    const button = document.getElementById("btnBatchDownload");
    button.disabled = !driveSelectedPaths.size;
    button.innerHTML = `<i class="fa-solid fa-file-zipper"></i> ${driveSelectedPaths.size ? `Download (${driveSelectedPaths.size})` : "Download Selected"}`;
}

async function downloadFile(path) {
    try {
        await downloadResponse(await fetch(`/api/drive/download?path=${encodeURIComponent(path)}`), path.split("/").pop());
    } catch (error) { showToast("error", "Download Failed", error.message); }
}

async function batchDownloadSelected() {
    if (!driveSelectedPaths.size) return;
    try {
        const response = await fetch("/api/drive/download-batch", {
            method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify({paths: [...driveSelectedPaths]})
        });
        await downloadResponse(response, "iDrivePulse_Export.zip");
    } catch (error) { showToast("error", "Batch Download Failed", error.message); }
}

async function searchDriveFiles() {
    const query = document.getElementById("driveSearchInput").value.trim();
    if (!query) return;
    try {
        const data = await apiJson(`/api/drive/search?query=${encodeURIComponent(query)}&root=${encodeURIComponent(currentDrivePath)}`);
        renderDriveItems(data.results || []);
        showToast("info", "Search Complete", `${data.count || 0} result(s) found.`);
    } catch (error) { showToast("error", "Search Failed", error.message); }
}
