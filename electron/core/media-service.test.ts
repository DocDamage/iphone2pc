import { describe, expect, it } from "vitest";
import { MediaService } from "./media-service.js";
import type { TransferRecord } from "./types.js";

function record(patch: Partial<TransferRecord> = {}): TransferRecord {
  return {
    id: "22222222-2222-4222-8222-222222222222",
    fileName: "beat.mp3",
    size: 10,
    mimeType: "application/octet-stream",
    direction: "iphone-to-pc",
    status: "completed",
    createdAt: "2026-07-27T00:00:00.000Z",
    completedAt: "2026-07-27T00:00:01.000Z",
    sourceDevice: "iPhone",
    savedPath: "C:\\PocketDock\\beat.mp3",
    ...patch
  };
}

describe("MediaService playback authorization", () => {
  const service = new MediaService();

  it("allows only completed audio, video, and GIF records with saved paths", () => {
    expect(service.playbackSource(record())).toEqual({
      filePath: "C:\\PocketDock\\beat.mp3",
      contentType: "audio/mpeg",
      kind: "audio"
    });
    expect(
      service.playbackSource(record({ fileName: "clip.mp4", savedPath: "C:\\PocketDock\\clip.mp4" }))
    ).toEqual({ filePath: "C:\\PocketDock\\clip.mp4", contentType: "video/mp4", kind: "video" });
    expect(
      service.playbackSource(record({ fileName: "loop.gif", savedPath: "C:\\PocketDock\\loop.gif" }))
    ).toEqual({ filePath: "C:\\PocketDock\\loop.gif", contentType: "image/gif", kind: "gif" });

    expect(service.playbackSource(record({ status: "active" }))).toBeNull();
    expect(service.playbackSource(record({ savedPath: undefined }))).toBeNull();
    expect(service.playbackSource(record({ fileName: "photo.jpg", mimeType: "image/jpeg" }))).toBeNull();
  });

  it("does not authorize an executable based on a forged upload MIME type", () => {
    expect(
      service.playbackSource(
        record({
          fileName: "payload.exe",
          savedPath: "C:\\PocketDock\\payload.exe",
          mimeType: "video/mp4"
        })
      )
    ).toBeNull();
  });
});
