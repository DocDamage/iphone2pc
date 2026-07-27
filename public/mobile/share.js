(() => {
  "use strict";

  const CHUNK_SIZE = 4 * 1024 * 1024;
  const id = new URLSearchParams(location.search).get("id") || "";
  const fragment = new URLSearchParams(location.hash.slice(1));
  const token = fragment.get("token") || "";
  const rawKey = fragment.get("key") || "";
  const browserCrypto = globalThis.crypto;
  const files = document.getElementById("private-files");
  const title = document.getElementById("share-title");
  const detail = document.getElementById("share-detail");
  const error = document.getElementById("share-error");
  const toast = document.getElementById("toast");
  const deliveryPanel = document.getElementById("delivery-panel");
  const deliveryMeta = document.getElementById("delivery-meta");
  const deliveryTracks = document.getElementById("delivery-tracks");
  const deliveryNote = document.getElementById("delivery-note");
  let importedKey;

  function base64UrlBytes(value) {
    const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4);
    return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
  }

  function escapeHtml(value) {
    const element = document.createElement("span");
    element.textContent = value;
    return element.innerHTML;
  }

  function formatBytes(bytes) {
    if (!bytes) return "0 B";
    const units = ["B", "KB", "MB", "GB", "TB"];
    const power = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
    return `${(bytes / 1024 ** power).toFixed(power ? 1 : 0)} ${units[power]}`;
  }

  function showToast(message) {
    toast.textContent = message;
    toast.hidden = false;
    requestAnimationFrame(() => toast.classList.add("show"));
    clearTimeout(showToast.timer);
    showToast.timer = setTimeout(() => {
      toast.classList.remove("show");
      setTimeout(() => {
        toast.hidden = true;
      }, 220);
    }, 4_500);
  }

  async function encryptionKey() {
    if (!importedKey) {
      const raw = base64UrlBytes(rawKey);
      if (browserCrypto?.subtle) {
        try {
          importedKey = {
            mode: "webcrypto",
            value: await browserCrypto.subtle.importKey(
              "raw",
              raw,
              "AES-GCM",
              false,
              ["decrypt"]
            )
          };
        } catch {
          // iOS does not expose Web Crypto to ordinary HTTP LAN origins.
        }
      }
      if (!importedKey && globalThis.PocketDockCrypto?.decrypt) {
        importedKey = { mode: "portable", value: raw };
      }
      if (!importedKey) {
        throw new Error("PocketDock decryption could not start in this browser.");
      }
    }
    return importedKey;
  }

  async function authenticatedFetch(route, options = {}) {
    const headers = new Headers(options.headers || {});
    headers.set("X-PocketDock-Link-Token", token);
    const response = await fetch(route, { ...options, headers });
    if (!response.ok) {
      let message = `Private share failed (${response.status}).`;
      try {
        message = (await response.json()).error || message;
      } catch {}
      throw new Error(message);
    }
    return response;
  }

  async function decrypt(fileId, offset, plainLength, iv, payload) {
    const aad = new TextEncoder().encode(`${fileId}:${offset}:${plainLength}`);
    const nonce = base64UrlBytes(iv);
    const key = await encryptionKey();
    return key.mode === "webcrypto"
      ? new Uint8Array(
          await browserCrypto.subtle.decrypt(
            {
              name: "AES-GCM",
              iv: nonce,
              additionalData: aad,
              tagLength: 128
            },
            key.value,
            payload
          )
        )
      : globalThis.PocketDockCrypto.decrypt(
          key.value,
          nonce,
          aad,
          new Uint8Array(payload)
        );
  }

  async function sha256(bytes) {
    if (browserCrypto?.subtle) {
      try {
        return new Uint8Array(await browserCrypto.subtle.digest("SHA-256", bytes));
      } catch {
        // Use the bundled implementation on insecure iOS LAN origins.
      }
    }
    if (globalThis.PocketDockCrypto?.sha256) {
      return globalThis.PocketDockCrypto.sha256(new Uint8Array(bytes));
    }
    throw new Error("PocketDock integrity verification could not start in this browser.");
  }

  async function download(file, button) {
    const original = button.textContent;
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
    try {
      const parts = [];
      for (let offset = 0; offset < file.size; offset += CHUNK_SIZE) {
        const response = await authenticatedFetch(
          `${file.chunkUrl}?offset=${offset}&length=${CHUNK_SIZE}`
        );
        const plainLength = Number(response.headers.get("x-pocketdock-plain-length"));
        const plaintext = await decrypt(
          file.id,
          offset,
          plainLength,
          response.headers.get("x-pocketdock-iv"),
          await response.arrayBuffer()
        );
        parts.push(plaintext);
        button.textContent = `Decrypting ${Math.round(((offset + plaintext.length) / file.size) * 100)}%`;
      }
      const blob = new Blob(parts, { type: file.mimeType || "application/octet-stream" });
      if (file.sha256) {
        const digest = await sha256(await blob.arrayBuffer());
        const hex = [...digest].map((value) => value.toString(16).padStart(2, "0")).join("");
        if (hex !== file.sha256) throw new Error("The download integrity check failed.");
      }
      const delivery = await shareOrSave(blob, file);
      await authenticatedFetch(
        `/api/public-links/${id}/files/${file.id}/complete`,
        { method: "POST" }
      );
      showToast(
        delivery === "shared"
          ? `${file.name} verified · share sheet opened`
          : delivery === "cancelled"
            ? `${file.name} verified · sharing cancelled`
            : `${file.name} decrypted, verified, and saved`
      );
    } catch (caught) {
      showToast(caught.message);
    } finally {
      button.textContent = original;
      button.disabled = false;
      button.removeAttribute("aria-busy");
    }
  }

  async function shareOrSave(blob, file) {
    if (typeof File === "function" && navigator.share && navigator.canShare) {
      const sharedFile = new File([blob], file.name, {
        type: file.mimeType || "application/octet-stream",
        lastModified: Date.now()
      });
      if (navigator.canShare({ files: [sharedFile] })) {
        try {
          await navigator.share({
            files: [sharedFile],
            title: file.name,
            text: "Received securely with PocketDock"
          });
          return "shared";
        } catch (caught) {
          if (caught?.name === "AbortError") return "cancelled";
        }
      }
    }
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = file.name;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    return "saved";
  }

  async function sendApproval(status) {
    try {
      await authenticatedFetch(`/api/public-links/${id}/approval`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status, note: deliveryNote.value })
      });
      showToast(status === "approved" ? "Delivery approved" : "Revision request sent");
    } catch (caught) {
      showToast(caught.message);
    }
  }

  async function boot() {
    if (!id || !token || !rawKey) {
      error.textContent = "This private link is incomplete.";
      title.textContent = "Link unavailable";
      return;
    }
    try {
      const response = await authenticatedFetch(`/api/public-links/${id}`);
      const share = await response.json();
      title.textContent = share.name;
      detail.textContent =
        `${share.files.length} encrypted ${share.files.length === 1 ? "file" : "files"} · ` +
        `${share.remainingDownloads} file downloads remaining`;
      if (share.delivery) {
        deliveryPanel.hidden = false;
        deliveryMeta.innerHTML = `
          <strong>${escapeHtml(share.delivery.clientName || share.delivery.artist || "Private delivery")}</strong>
          <span>Version ${share.delivery.version || 1} · ${escapeHtml(share.delivery.licenseName || "Usage terms included")}</span>
          <p>${escapeHtml(share.delivery.notes || "")}</p>`;
        deliveryTracks.innerHTML = (share.delivery.tracks || []).map((track) => `
          <div><strong>${escapeHtml(track.name)}</strong><span>${escapeHtml(track.role)} · ${formatBytes(track.size)}</span></div>
        `).join("");
        document.getElementById("delivery-approve").addEventListener("click", () => sendApproval("approved"));
        document.getElementById("delivery-changes").addEventListener("click", () => sendApproval("changes-requested"));
      }
      files.innerHTML = share.files.length
        ? share.files.map((file) => `
          <article class="private-file">
            <div>
              <strong>${escapeHtml(file.name)}</strong>
              <span>${formatBytes(file.size)} · SHA-256 verified</span>
            </div>
            <button class="primary-button" data-file="${file.id}">Save or Share</button>
          </article>`).join("")
        : '<p class="settings-empty">No files remain in this share.</p>';
      files.querySelectorAll("[data-file]").forEach((button) => {
        const file = share.files.find((entry) => entry.id === button.dataset.file);
        button.addEventListener("click", () => download(file, button));
      });
    } catch (caught) {
      title.textContent = "Link unavailable";
      error.textContent = caught.message;
    }
  }

  boot();
})();
