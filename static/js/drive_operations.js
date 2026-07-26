async function setupPortableFolder() {
    try {
        const data = await apiJson("/api/drive/portable/setup", {method: "POST"});
        showToast("success", "Portable Files Ready", data.message);
        await loadDrivePath(data.path);
    } catch (error) { showToast("error", "Setup Failed", error.message); }
}

async function promptCreateFolder() {
    if (!currentDriveWritable) return;
    const name = prompt("New folder name:");
    if (!name?.trim()) return;
    const path = `${currentDrivePath.replace(/\/$/, "")}/${name.trim()}`;
    try {
        await apiJson("/api/drive/mkdir", {
            method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify({path})
        });
        await loadDrivePath(currentDrivePath);
    } catch (error) { showToast("error", "Folder Creation Failed", error.message); }
}

async function uploadFiles(files) {
    if (!currentDriveWritable || !files?.length) return;
    let completed = 0;
    for (const file of files) {
        const body = new FormData();
        body.append("destination_path", currentDrivePath);
        body.append("file", file);
        try {
            await apiJson("/api/drive/upload", {method: "POST", body});
            completed += 1;
        } catch (error) { showToast("error", `Upload Failed: ${file.name}`, error.message); }
    }
    if (completed) showToast("success", "Upload Complete", `${completed} file(s) copied to Portable Files.`);
    await loadDrivePath(currentDrivePath);
}

async function handleUpload(input) {
    await uploadFiles([...input.files]);
    input.value = "";
}

async function deleteDriveItem(path) {
    if (!currentDriveWritable || !confirm(`Delete ${path.split("/").pop()} from Portable Files?`)) return;
    try {
        await apiJson(`/api/drive/delete?path=${encodeURIComponent(path)}`, {method: "DELETE"});
        await loadDrivePath(currentDrivePath);
    } catch (error) { showToast("error", "Delete Failed", error.message); }
}

function setupDragAndDrop() {
    const zone = document.getElementById("dropZone");
    ["dragenter", "dragover"].forEach(type => zone.addEventListener(type, event => {
        event.preventDefault();
        if (currentDriveWritable) zone.classList.add("dragging");
    }));
    ["dragleave", "drop"].forEach(type => zone.addEventListener(type, event => {
        event.preventDefault();
        zone.classList.remove("dragging");
    }));
    zone.addEventListener("drop", event => uploadFiles([...event.dataTransfer.files]));
}

async function refreshMountStatus() {
    const button = document.getElementById("btnMountDrive");
    try {
        mountState = await apiJson("/api/mount/status");
        button.innerHTML = mountState.mounted
            ? `<i class="fa-brands fa-windows"></i> Unmount ${escapeHtml(mountState.drive || "Drive")}`
            : '<i class="fa-brands fa-windows"></i> Mount Drive';
        button.classList.toggle("btn-success", Boolean(mountState.mounted));
    } catch (error) {
        button.title = error.message;
    }
}

async function toggleDriveMount() {
    const endpoint = mountState.mounted ? "/api/mount/stop" : "/api/mount/start";
    const options = mountState.mounted ? {method: "POST"} : {
        method: "POST", headers: {"Content-Type": "application/json"},
        body: JSON.stringify({drive: document.getElementById("mountDriveSelect").value})
    };
    try {
        const data = await apiJson(endpoint, options);
        showToast("success", mountState.mounted ? "Drive Unmounted" : "Drive Mounted", data.message || "Mount state updated.");
    } catch (error) { showToast("error", "Mount Operation Failed", error.message); }
    await refreshMountStatus();
}
