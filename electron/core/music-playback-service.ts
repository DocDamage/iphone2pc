import crypto from "node:crypto";
import { lstat, open, realpath, type FileHandle } from "node:fs/promises";
import { Readable } from "node:stream";
import {
  playableMediaContentType,
  type PlayableMediaKind
} from "./media-kind.js";

export const MUSIC_PLAYBACK_SCHEME = "pocketdock-audio";

const MUSIC_LIBRARY_ID_PATTERN = /^[a-f0-9]{32}$/;
const TRANSFER_ID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const ACCESS_TOKEN_PATTERN = /^[a-f0-9]{64}$/;

type MusicPathResolver = (id: string) => string | null;
export interface TransferPlaybackSource {
  filePath: string;
  contentType: string;
  kind: PlayableMediaKind;
}
type TransferSourceResolver = (id: string) => TransferPlaybackSource | null;
type PlaybackScope = "music" | "transfer";

interface PlaybackSource {
  filePath: string;
  contentType: string;
}

interface PlaybackRequest {
  scope: PlaybackScope;
  id: string;
}

interface ByteRange {
  start: number;
  end: number;
}

function safeContentType(value: string): string | null {
  const contentType = value.trim().toLowerCase();
  return /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(contentType)
    ? contentType
    : null;
}

function safeTransferContentType(source: TransferPlaybackSource): string | null {
  const contentType = safeContentType(source.contentType);
  if (!contentType) return null;
  if (source.kind === "audio" && contentType.startsWith("audio/")) return contentType;
  if (source.kind === "video" && contentType.startsWith("video/")) return contentType;
  if (source.kind === "gif" && contentType === "image/gif") return contentType;
  return null;
}

function parseRange(value: string | null, size: number): ByteRange | null | "invalid" {
  if (!value) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
  if (!match || (!match[1] && !match[2]) || size <= 0) return "invalid";

  const rawStart = match[1];
  const rawEnd = match[2];
  if (!rawStart) {
    const suffixLength = Number(rawEnd);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return "invalid";
    return {
      start: Math.max(0, size - suffixLength),
      end: size - 1
    };
  }

  const start = Number(rawStart);
  if (!Number.isSafeInteger(start) || start < 0 || start >= size) return "invalid";
  const requestedEnd = rawEnd ? Number(rawEnd) : size - 1;
  if (!Number.isSafeInteger(requestedEnd) || requestedEnd < start) return "invalid";
  return { start, end: Math.min(requestedEnd, size - 1) };
}

function commonHeaders(contentTypeValue?: string): Headers {
  const headers = new Headers({
    "Accept-Ranges": "bytes",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  if (contentTypeValue) headers.set("Content-Type", contentTypeValue);
  return headers;
}

function emptyResponse(status: number, headers?: HeadersInit): Response {
  return new Response(null, { status, headers });
}

async function closeQuietly(handle: FileHandle | null): Promise<void> {
  if (!handle) return;
  try {
    await handle.close();
  } catch {
    // The stream may already have closed the descriptor after a client disconnect.
  }
}

/**
 * Streams only files still authorized by the current library index or completed
 * Gallery history. Filesystem paths never cross the IPC boundary; the renderer
 * receives only opaque IDs embedded in scope-bound, session-scoped URLs.
 */
export class MusicPlaybackService {
  private readonly accessToken: string;

  constructor(
    private readonly resolveMusicPath: MusicPathResolver,
    private readonly resolveTransferSource: TransferSourceResolver = () => null,
    accessToken = crypto.randomBytes(32).toString("hex")
  ) {
    if (!ACCESS_TOKEN_PATTERN.test(accessToken)) {
      throw new Error("The music playback access token is invalid.");
    }
    this.accessToken = accessToken;
  }

  getMusicPlaybackUrl(id: string): string {
    if (
      !MUSIC_LIBRARY_ID_PATTERN.test(id) ||
      !this.resolveSource({ scope: "music", id })
    ) {
      throw new Error("This music file is no longer in the local library.");
    }
    return this.buildUrl("music", id);
  }

  getTransferPlaybackUrl(id: string): string {
    if (
      !TRANSFER_ID_PATTERN.test(id) ||
      !this.resolveSource({ scope: "transfer", id })
    ) {
      throw new Error("This Gallery file is not available for playback.");
    }
    return this.buildUrl("transfer", id);
  }

  async handle(request: Request): Promise<Response> {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return emptyResponse(405, { Allow: "GET, HEAD", "Cache-Control": "no-store" });
    }

    const parsed = this.parseRequest(request.url);
    const source = parsed ? this.resolveSource(parsed) : null;
    if (!source) return emptyResponse(404, { "Cache-Control": "no-store" });

    let handle: FileHandle | null = null;
    try {
      // Inspect the final path without following a link, then verify that the opened
      // descriptor is the same file. This permits legitimate junctions in parent
      // folders while blocking final-component substitution and its common race.
      const pathInfo = await lstat(source.filePath);
      if (!pathInfo.isFile() || pathInfo.isSymbolicLink()) {
        return emptyResponse(404, { "Cache-Control": "no-store" });
      }
      const canonicalPath = await realpath(source.filePath);
      const canonicalInfo = await lstat(canonicalPath);
      if (
        !canonicalInfo.isFile() ||
        canonicalInfo.isSymbolicLink() ||
        canonicalInfo.dev !== pathInfo.dev ||
        canonicalInfo.ino !== pathInfo.ino
      ) {
        return emptyResponse(404, { "Cache-Control": "no-store" });
      }

      handle = await open(canonicalPath, "r");
      const fileInfo = await handle.stat();
      if (
        !fileInfo.isFile() ||
        fileInfo.dev !== canonicalInfo.dev ||
        fileInfo.ino !== canonicalInfo.ino
      ) {
        await closeQuietly(handle);
        handle = null;
        return emptyResponse(404, { "Cache-Control": "no-store" });
      }

      const size = fileInfo.size;
      const range = parseRange(request.headers.get("range"), size);
      const headers = commonHeaders(source.contentType);
      if (range === "invalid") {
        headers.set("Content-Range", `bytes */${size}`);
        headers.set("Content-Length", "0");
        await closeQuietly(handle);
        handle = null;
        return emptyResponse(416, headers);
      }

      const start = range?.start ?? 0;
      const end = range?.end ?? Math.max(0, size - 1);
      const length = range ? end - start + 1 : size;
      headers.set("Content-Length", String(length));
      if (range) headers.set("Content-Range", `bytes ${start}-${end}/${size}`);

      if (request.method === "HEAD" || size === 0) {
        await closeQuietly(handle);
        handle = null;
        return emptyResponse(range ? 206 : 200, headers);
      }

      const nodeStream = handle.createReadStream({
        start,
        end,
        autoClose: true
      });
      handle = null;
      const body = Readable.toWeb(nodeStream) as ReadableStream<Uint8Array>;
      return new Response(body, { status: range ? 206 : 200, headers });
    } catch {
      await closeQuietly(handle);
      return emptyResponse(404, { "Cache-Control": "no-store" });
    }
  }

  private buildUrl(scope: PlaybackScope, id: string): string {
    return `${MUSIC_PLAYBACK_SCHEME}://stream/${this.accessToken}/${scope}/${id}`;
  }

  private resolveSource(request: PlaybackRequest): PlaybackSource | null {
    if (request.scope === "music") {
      const filePath = this.resolveMusicPath(request.id);
      const contentType = filePath ? playableMediaContentType(filePath, "") : null;
      return filePath && contentType ? { filePath, contentType } : null;
    }
    const source = this.resolveTransferSource(request.id);
    if (!source) return null;
    const contentType = safeTransferContentType(source);
    return contentType ? { filePath: source.filePath, contentType } : null;
  }

  private parseRequest(value: string): PlaybackRequest | null {
    try {
      const url = new URL(value);
      if (
        url.protocol !== `${MUSIC_PLAYBACK_SCHEME}:` ||
        url.hostname !== "stream" ||
        url.port ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      ) {
        return null;
      }
      const parts = url.pathname.split("/");
      if (parts.length !== 4 || parts[1] !== this.accessToken) return null;
      const scope = parts[2];
      const id = parts[3] ?? "";
      if (scope === "music" && MUSIC_LIBRARY_ID_PATTERN.test(id)) return { scope, id };
      if (scope === "transfer" && TRANSFER_ID_PATTERN.test(id)) return { scope, id };
      return null;
    } catch {
      return null;
    }
  }
}
