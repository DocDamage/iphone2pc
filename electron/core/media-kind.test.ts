import { describe, expect, it } from "vitest";
import {
  detectMediaKind,
  isPlayableMediaKind,
  playableMediaContentType
} from "./media-kind.js";

describe("media kind classifier", () => {
  it("detects playable audio, video, and GIFs from whitelisted filenames", () => {
    expect(detectMediaKind("beat.mp3", "application/octet-stream")).toBe("audio");
    expect(detectMediaKind("clip.MP4", "application/octet-stream")).toBe("video");
    expect(detectMediaKind("animation.GIF", "application/octet-stream")).toBe("gif");
    expect(detectMediaKind("animation.dat", "image/gif; charset=binary")).toBe("other");
    expect(detectMediaKind("clip.ogg", "video/ogg")).toBe("audio");
  });

  it("keeps non-playable images and documents out of the playback allowlist", () => {
    expect(detectMediaKind("photo.jpg", "image/jpeg")).toBe("image");
    expect(detectMediaKind("notes.pdf", "application/pdf")).toBe("document");
    expect(isPlayableMediaKind("image")).toBe(false);
    expect(isPlayableMediaKind("document")).toBe(false);
  });

  it("returns normalized media types without trusting malformed header input", () => {
    expect(playableMediaContentType("beat.mp3", "application/octet-stream")).toBe("audio/mpeg");
    expect(playableMediaContentType("movie.webm", "video/fake; codecs=vp9")).toBe("video/webm");
    expect(playableMediaContentType("loop.gif", "text/plain\r\nx-unsafe: yes")).toBe("image/gif");
    expect(playableMediaContentType("photo.png", "image/png")).toBeNull();
    expect(playableMediaContentType("program.exe", "video/mp4")).toBeNull();
    expect(playableMediaContentType("clip.ogg", "video/ogg")).toBe("audio/ogg");
  });
});
