(() => {
  "use strict";

  const id = new URLSearchParams(location.search).get("id") || "";
  const token = new URLSearchParams(location.hash.slice(1)).get("token") || "";
  const picker = document.getElementById("request-files");
  const send = document.getElementById("request-send");
  const queue = document.getElementById("request-queue");
  const title = document.getElementById("request-title");
  const detail = document.getElementById("request-detail");
  const limits = document.getElementById("request-limits");
  const error = document.getElementById("request-error");
  const toast = document.getElementById("toast");
  let requestInfo;

  function formatBytes(bytes) {
    const units = ["B", "KB", "MB", "GB"];
    const power = Math.min(Math.floor(Math.log(Math.max(1, bytes)) / Math.log(1024)), 3);
    return `${(bytes / 1024 ** power).toFixed(power ? 1 : 0)} ${units[power]}`;
  }

  function showToast(message) {
    toast.textContent = message;
    toast.hidden = false;
    requestAnimationFrame(() => toast.classList.add("show"));
    setTimeout(() => {
      toast.classList.remove("show");
      setTimeout(() => { toast.hidden = true; }, 220);
    }, 4_500);
  }

  async function authenticatedFetch(route, options = {}) {
    const headers = new Headers(options.headers || {});
    headers.set("X-PocketDock-Request-Token", token);
    const response = await fetch(route, { ...options, headers });
    if (!response.ok) {
      let message = `File request failed (${response.status}).`;
      try { message = (await response.json()).error || message; } catch {}
      throw new Error(message);
    }
    return response;
  }

  function renderQueue() {
    const selected = [...picker.files];
    queue.innerHTML = "";
    for (const file of selected) {
      const row = document.createElement("article");
      row.className = "request-file";
      const name = document.createElement("strong");
      name.textContent = file.name;
      const size = document.createElement("span");
      size.textContent = formatBytes(file.size);
      row.append(name, size);
      queue.append(row);
    }
    const tooMany = requestInfo && selected.length > requestInfo.remainingFiles;
    const tooLarge = requestInfo && selected.some((file) => file.size > requestInfo.maxFileSize);
    error.textContent = tooMany
      ? `Choose no more than ${requestInfo.remainingFiles} files.`
      : tooLarge
        ? `Each file must be ${formatBytes(requestInfo.maxFileSize)} or smaller.`
        : "";
    send.disabled = !selected.length || tooMany || tooLarge;
  }

  async function upload() {
    const selected = [...picker.files];
    send.disabled = true;
    send.setAttribute("aria-busy", "true");
    error.textContent = "";
    try {
      for (let index = 0; index < selected.length; index += 1) {
        const file = selected[index];
        send.textContent = `Sending ${index + 1} of ${selected.length}…`;
        const response = await authenticatedFetch(`/api/file-requests/${id}/files`, {
          method: "POST",
          headers: {
            "Content-Type": file.type || "application/octet-stream",
            "X-PocketDock-File-Name": encodeURIComponent(file.name)
          },
          body: file
        });
        const result = await response.json();
        showToast(
          result.pendingApproval
            ? `${file.name} is waiting for approval`
            : `${file.name} arrived safely`
        );
      }
      picker.value = "";
      queue.innerHTML = "";
      detail.textContent = "Transfer complete. You can close this page.";
    } catch (caught) {
      error.textContent = caught.message;
    } finally {
      send.textContent = "Send to PC";
      send.removeAttribute("aria-busy");
      renderQueue();
    }
  }

  async function boot() {
    if (!id || !token) {
      title.textContent = "Request unavailable";
      error.textContent = "This file request link is incomplete.";
      return;
    }
    try {
      const response = await authenticatedFetch(`/api/file-requests/${id}`);
      requestInfo = await response.json();
      title.textContent = requestInfo.name;
      detail.textContent = requestInfo.requiresApproval
        ? "Files travel directly to the requesting PC and are held for approval."
        : "Files travel directly to the requesting PC without cloud storage.";
      limits.textContent =
        `${requestInfo.remainingFiles} files remaining · ${formatBytes(requestInfo.maxFileSize)} each`;
    } catch (caught) {
      title.textContent = "Request unavailable";
      error.textContent = caught.message;
    }
  }

  picker.addEventListener("change", renderQueue);
  send.addEventListener("click", upload);
  boot();
})();
