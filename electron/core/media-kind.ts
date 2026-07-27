import type { MediaPreview } from "./types.js";

export type PlayableMediaKind = "audio" | "video" | "gif";

const AUDIO_CONTENT_TYPES: Readonly<Record<string, string>> = {
  aac: "audio/aac",
  aif: "audio/aiff",
  aiff: "audio/aiff",
  alac: "audio/mp4",
  amr: "audio/amr",
  ape: "audio/ape",
  flac: "audio/flac",
  m4a: "audio/mp4",
  m4b: "audio/mp4",
  mp2: "audio/mpeg",
  mp3: "audio/mpeg",
  mpc: "audio/x-musepack",
  oga: "audio/ogg",
  ogg: "audio/ogg",
  opus: "audio/ogg",
  wav: "audio/wav",
  wave: "audio/wav",
  weba: "audio/webm",
  wma: "audio/x-ms-wma",
  wv: "audio/wavpack"
};

const VIDEO_CONTENT_TYPES: Readonly<Record<string, string>> = {
  "3g2": "video/3gpp2",
  "3gp": "video/3gpp",
  avi: "video/x-msvideo",
  m4v: "video/x-m4v",
  mkv: "video/x-matroska",
  mov: "video/quicktime",
  mp4: "video/mp4",
  mpeg: "video/mpeg",
  mpg: "video/mpeg",
  ogv: "video/ogg",
  webm: "video/webm",
  wmv: "video/x-ms-wmv"
};

const IMAGE_EXTENSIONS = new Set([
  "avif",
  "bmp",
  "heic",
  "heif",
  "jpeg",
  "jpg",
  "png",
  "tif",
  "tiff",
  "webp"
]);
const DOCUMENT_EXTENSIONS = new Set(["doc", "docx", "md", "pdf", "rtf", "txt"]);

function extensionOf(fileName: string): string {
  const normalized = fileName.replace(/\\/g, "/");
  const baseName = normalized.slice(normalized.lastIndexOf("/") + 1);
  const dot = baseName.lastIndexOf(".");
  return dot > 0 && dot < baseName.length - 1 ? baseName.slice(dot + 1).toLowerCase() : "";
}

/** Pure classifier shared by the renderer and backend; MIME is accepted but untrusted. */
export function detectMediaKind(fileName: string, _mimeType: string): MediaPreview["kind"] {
  const extension = extensionOf(fileName);
  // A whitelisted filename extension is always required before privileged playback.
  if (extension === "gif") return "gif";
  if (VIDEO_CONTENT_TYPES[extension]) return "video";
  if (AUDIO_CONTENT_TYPES[extension]) return "audio";
  if (IMAGE_EXTENSIONS.has(extension)) return "image";
  if (DOCUMENT_EXTENSIONS.has(extension)) return "document";
  return "other";
}

/** Returns a safe HTTP Content-Type only when the file is playable media. */
export function playableMediaContentType(fileName: string, _mimeType: string): string | null {
  const kind = detectMediaKind(fileName, "");
  const extension = extensionOf(fileName);
  if (kind === "gif") return "image/gif";
  if (kind === "audio") {
    return AUDIO_CONTENT_TYPES[extension] ?? null;
  }
  if (kind === "video") {
    return VIDEO_CONTENT_TYPES[extension] ?? null;
  }
  return null;
}

export function isPlayableMediaKind(kind: MediaPreview["kind"]): kind is PlayableMediaKind {
  return kind === "audio" || kind === "video" || kind === "gif";
}
