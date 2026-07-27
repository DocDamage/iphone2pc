import path from "node:path";
import os from "node:os";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { MusicPlaybackService } from "./music-playback-service.js";

const ACCESS_TOKEN = "a".repeat(64);
const TRACK_ID = "1".repeat(32);
const TRANSFER_ID = "22222222-2222-4222-8222-222222222222";
const temporaryRoots: string[] = [];

async function fixture(extension = ".mp3", contents = "0123456789") {
  const root = await mkdtemp(path.join(os.tmpdir(), "pocketdock-playback-"));
  temporaryRoots.push(root);
  const filePath = path.join(root, `Track${extension}`);
  await writeFile(filePath, contents);
  const indexed = new Map([[TRACK_ID, filePath]]);
  const transfers = new Map<
    string,
    { filePath: string; contentType: string; kind: "audio" | "video" | "gif" }
  >();
  const service = new MusicPlaybackService(
    (id) => indexed.get(id) ?? null,
    (id) => transfers.get(id) ?? null,
    ACCESS_TOKEN
  );
  return {
    filePath,
    indexed,
    transfers,
    service,
    url: service.getMusicPlaybackUrl(TRACK_ID)
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

describe("MusicPlaybackService", () => {
  it("returns an opaque, tokenized URL only for a currently indexed item", async () => {
    const { filePath, indexed, service } = await fixture();

    const url = service.getMusicPlaybackUrl(TRACK_ID);
    expect(url).toBe(`pocketdock-audio://stream/${ACCESS_TOKEN}/music/${TRACK_ID}`);
    expect(url).not.toContain(filePath);
    expect(() => service.getMusicPlaybackUrl("../Track.mp3")).toThrow("no longer in the local library");

    indexed.delete(TRACK_ID);
    expect(() => service.getMusicPlaybackUrl(TRACK_ID)).toThrow("no longer in the local library");
  });

  it("streams full files and answers HEAD without loading a body", async () => {
    const { service, url } = await fixture(".m4a");

    const response = await service.handle(new Request(url));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("audio/mp4");
    expect(response.headers.get("accept-ranges")).toBe("bytes");
    expect(response.headers.get("content-length")).toBe("10");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).toBe("0123456789");

    const head = await service.handle(new Request(url, { method: "HEAD" }));
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe("10");
    expect(await head.text()).toBe("");
  });

  it("supports closed, open-ended, and suffix byte ranges for seeking", async () => {
    const { service, url } = await fixture();

    const closed = await service.handle(new Request(url, { headers: { Range: "bytes=2-5" } }));
    expect(closed.status).toBe(206);
    expect(closed.headers.get("content-range")).toBe("bytes 2-5/10");
    expect(closed.headers.get("content-length")).toBe("4");
    expect(await closed.text()).toBe("2345");

    const openEnded = await service.handle(new Request(url, { headers: { Range: "bytes=7-" } }));
    expect(openEnded.status).toBe(206);
    expect(openEnded.headers.get("content-range")).toBe("bytes 7-9/10");
    expect(await openEnded.text()).toBe("789");

    const suffix = await service.handle(new Request(url, { headers: { Range: "bytes=-3" } }));
    expect(suffix.status).toBe(206);
    expect(suffix.headers.get("content-range")).toBe("bytes 7-9/10");
    expect(await suffix.text()).toBe("789");
  });

  it("streams completed Gallery video and GIF sources with server-selected MIME types", async () => {
    const video = await fixture(".mp4");
    video.transfers.set(TRANSFER_ID, {
      filePath: video.filePath,
      contentType: "video/mp4",
      kind: "video"
    });
    const videoUrl = video.service.getTransferPlaybackUrl(TRANSFER_ID);
    expect(videoUrl).toBe(`pocketdock-audio://stream/${ACCESS_TOKEN}/transfer/${TRANSFER_ID}`);
    expect(videoUrl).not.toContain(video.filePath);

    const response = await video.service.handle(
      new Request(videoUrl, { headers: { Range: "bytes=3-6" } })
    );
    expect(response.status).toBe(206);
    expect(response.headers.get("content-type")).toBe("video/mp4");
    expect(response.headers.get("content-range")).toBe("bytes 3-6/10");
    expect(await response.text()).toBe("3456");

    const gif = await fixture(".gif", "GIF89a-data");
    gif.transfers.set(TRANSFER_ID, {
      filePath: gif.filePath,
      contentType: "image/gif",
      kind: "gif"
    });
    const gifResponse = await gif.service.handle(
      new Request(gif.service.getTransferPlaybackUrl(TRANSFER_ID))
    );
    expect(gifResponse.headers.get("content-type")).toBe("image/gif");
    expect(await gifResponse.text()).toBe("GIF89a-data");
  });

  it("rejects malformed or unsatisfiable ranges without returning file bytes", async () => {
    const { service, url } = await fixture();

    for (const range of ["bytes=10-", "bytes=6-2", "bytes=0-1,4-5", "items=0-1", "bytes=-0"]) {
      const response = await service.handle(new Request(url, { headers: { Range: range } }));
      expect(response.status).toBe(416);
      expect(response.headers.get("content-range")).toBe("bytes */10");
      expect(await response.text()).toBe("");
    }
  });

  it("serves an empty file without a body and rejects byte ranges against it", async () => {
    const { service, url } = await fixture(".mp3", "");
    const full = await service.handle(new Request(url));
    expect(full.status).toBe(200);
    expect(full.headers.get("content-length")).toBe("0");
    expect(await full.text()).toBe("");

    const ranged = await service.handle(new Request(url, { headers: { Range: "bytes=0-" } }));
    expect(ranged.status).toBe(416);
    expect(ranged.headers.get("content-range")).toBe("bytes */0");
  });

  it("revalidates the index and rejects forged tokens, URLs, and methods", async () => {
    const { indexed, service, url } = await fixture();
    indexed.delete(TRACK_ID);
    expect((await service.handle(new Request(url))).status).toBe(404);

    const forged = url.replace(ACCESS_TOKEN, "b".repeat(64));
    expect((await service.handle(new Request(forged))).status).toBe(404);
    expect((await service.handle(new Request(`${url}?path=C%3A%5Csecret`))).status).toBe(404);

    const post = await service.handle(new Request(url, { method: "POST" }));
    expect(post.status).toBe(405);
    expect(post.headers.get("allow")).toBe("GET, HEAD");
  });

  it("revalidates transfer eligibility and keeps music and Gallery URL scopes separate", async () => {
    const { filePath, transfers, service, url: musicUrl } = await fixture(".mp3");
    transfers.set(TRANSFER_ID, { filePath, contentType: "video/mp4", kind: "audio" });
    expect(() => service.getTransferPlaybackUrl(TRANSFER_ID)).toThrow("not available for playback");
    transfers.set(TRANSFER_ID, { filePath, contentType: "audio/mpeg", kind: "audio" });
    const transferUrl = service.getTransferPlaybackUrl(TRANSFER_ID);

    expect((await service.handle(new Request(musicUrl.replace("/music/", "/transfer/")))).status).toBe(404);
    expect((await service.handle(new Request(transferUrl.replace("/transfer/", "/music/")))).status).toBe(404);

    transfers.delete(TRANSFER_ID);
    expect(() => service.getTransferPlaybackUrl(TRANSFER_ID)).toThrow("not available for playback");
    expect((await service.handle(new Request(transferUrl))).status).toBe(404);
  });

  it("does not follow a symlink substituted for an indexed file", async () => {
    const { filePath, service, url } = await fixture();
    const secretPath = path.join(path.dirname(filePath), "Secret.txt");
    await writeFile(secretPath, "must not stream");
    await rm(filePath);
    try {
      await symlink(secretPath, filePath, "file");
    } catch {
      // Creating symlinks may require an elevated Windows policy. Other platforms
      // and enabled Windows developer environments still exercise this hardening.
      return;
    }

    const response = await service.handle(new Request(url));
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain("must not stream");
  });
});
