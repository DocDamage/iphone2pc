function escapeHtml(value) {
    const node = document.createElement("div");
    node.textContent = value == null ? "" : String(value);
    return node.innerHTML;
}

function escapeAttr(value) {
    return escapeHtml(value).replaceAll("`", "&#96;");
}

function formatBytes(bytes) {
    const value = Number(bytes) || 0;
    if (!value) return "0 B";
    const units = ["B", "KB", "MB", "GB", "TB"];
    const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
    return `${(value / (1024 ** index)).toFixed(index ? 2 : 0)} ${units[index]}`;
}

function getFileIcon(filename) {
    const extension = String(filename || "").split(".").pop().toLowerCase();
    if (["mp3", "wav", "m4a", "aac", "flac", "aif", "aiff", "caf"].includes(extension)) return "fa-file-audio";
    if (["jpg", "jpeg", "png", "gif", "heic", "webp"].includes(extension)) return "fa-file-image";
    if (["mov", "mp4", "m4v", "avi"].includes(extension)) return "fa-file-video";
    if (["zip", "rar", "7z", "gz"].includes(extension)) return "fa-file-zipper";
    return "fa-file";
}

async function apiJson(url, options = {}) {
    const response = await fetch(url, options);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.detail || data.message || `Request failed (${response.status}).`);
    return data;
}

async function downloadResponse(response, fallbackName) {
    if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.detail || `Download failed (${response.status}).`);
    }
    const disposition = response.headers.get("content-disposition") || "";
    const match = disposition.match(/filename\*?=(?:UTF-8''|\")?([^\";]+)/i);
    const filename = match ? decodeURIComponent(match[1].replaceAll('"', "")) : fallbackName;
    const link = document.createElement("a");
    link.href = URL.createObjectURL(await response.blob());
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}
