import os from "node:os";
import path from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { StateStore } from "./store.js";

const temporaryDirectories: string[] = [];
const openStores: StateStore[] = [];

afterEach(async () => {
  for (const store of openStores.splice(0)) store.close();
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  );
});

describe("SQLite state store", () => {
  it("persists security state, rules, clipboard entries, and bounded settings", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pocketdock-store-"));
    temporaryDirectories.push(root);
    const first = new StateStore(root);
    openStores.push(first);
    await first.load();
    const secret = first.getTransferSecret();
    const now = new Date().toISOString();
    await first.updateSettings({
      port: 99,
      maxConcurrentUploads: 99,
      bandwidthLimitMbps: -4,
      connectionStrategy: "usb-first"
    });
    await first.upsertTrustedDevice({
      id: "device-1",
      name: "Doc’s iPhone",
      tokenHash: "a".repeat(64),
      createdAt: now,
      lastSeenAt: now,
      lastAddress: "192.168.1.9",
      revoked: false,
      permissions: {
        sendToPc: true,
        receiveFromPc: true,
        clipboard: true,
        automaticBackup: false,
        remoteAccess: false,
        browseFiles: false,
        fileProvider: false,
        fileRequests: true
      }
    });
    const rule = await first.addAutomationRule({
      name: "Music",
      enabled: true,
      matcher: "extension",
      value: "wav",
      destinationSubfolder: "Studio"
    });
    await first.addClipboardEntry({
      id: "clip-1",
      kind: "text",
      content: "Ready",
      sourceDevice: "This PC",
      createdAt: now
    });
    await first.addClipboardEntry({
      id: "clip-expired",
      kind: "url",
      content: "https://expired.invalid",
      sourceDevice: "This PC",
      createdAt: new Date(Date.now() - 120_000).toISOString(),
      expiresAt: new Date(Date.now() - 60_000).toISOString()
    });
    await first.updateClipboardEntry("clip-1", { pinned: true, expiresAt: undefined });
    first.close();
    openStores.splice(openStores.indexOf(first), 1);

    const second = new StateStore(root);
    openStores.push(second);
    await second.load();
    expect(second.getTransferSecret()).toBe(secret);
    expect(second.getSettings()).toMatchObject({
      port: 1_024,
      maxConcurrentUploads: 4,
      bandwidthLimitMbps: 0,
      connectionStrategy: "automatic"
    });
    expect(second.getTrustedDevices()[0].name).toBe("Doc’s iPhone");
    expect(second.getAutomationRules()[0]).toMatchObject({ id: rule.id, value: "wav" });
    expect(second.getClipboardEntries()).toHaveLength(1);
    expect(second.getClipboardEntries()[0]).toMatchObject({
      content: "Ready",
      pinned: true
    });
  });

  it("migrates a PocketDock 1 state file on first launch", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pocketdock-migration-"));
    temporaryDirectories.push(root);
    await writeFile(
      path.join(root, "state.json"),
      JSON.stringify({
        settings: { deviceName: "Studio PC", theme: "dark" },
        onboardingComplete: true,
        history: [
          {
            id: "old-transfer",
            fileName: "Archive.zip",
            size: 12,
            mimeType: "application/zip",
            direction: "iphone-to-pc",
            status: "completed",
            createdAt: "2026-01-01T00:00:00.000Z",
            sourceDevice: "iPhone"
          }
        ]
      })
    );
    const store = new StateStore(root);
    openStores.push(store);
    await store.load();
    expect(store.getSettings()).toMatchObject({ deviceName: "Studio PC", theme: "dark" });
    expect(store.getOnboardingComplete()).toBe(true);
    expect(store.getHistory()[0].id).toBe("old-transfer");
  });

  it("normalizes local transfer-library metadata", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pocketdock-library-"));
    temporaryDirectories.push(root);
    const store = new StateStore(root);
    openStores.push(store);
    await store.load();
    await store.upsertTransfer({
      id: "transfer-1",
      fileName: "Master.wav",
      size: 42,
      mimeType: "audio/wav",
      direction: "iphone-to-pc",
      status: "completed",
      createdAt: new Date().toISOString(),
      sourceDevice: "Studio iPhone"
    });
    const updated = await store.updateTransferMetadata("transfer-1", {
      favorite: true,
      tags: [" client ", "client", " final master "],
      note: `  Approved${"!".repeat(2_100)}  `
    });
    expect(updated.favorite).toBe(true);
    expect(updated.tags).toEqual(["client", "final master"]);
    expect(updated.note?.length).toBe(2_000);
    expect(store.getHistory()[0]).toMatchObject({
      id: "transfer-1",
      favorite: true,
      tags: ["client", "final master"]
    });
  });

  it("applies bounded metadata and tags across a transfer selection", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pocketdock-bulk-library-"));
    temporaryDirectories.push(root);
    const store = new StateStore(root);
    openStores.push(store);
    await store.load();
    for (const id of ["transfer-1", "transfer-2", "transfer-3"]) {
      await store.upsertTransfer({
        id,
        fileName: `${id}.wav`,
        size: 42,
        mimeType: "audio/wav",
        direction: "iphone-to-pc",
        status: "completed",
        createdAt: new Date().toISOString(),
        sourceDevice: "Studio iPhone",
        tags: id === "transfer-1" ? ["mix"] : []
      });
    }

    const starred = await store.updateTransfersMetadata(
      ["transfer-1", "transfer-2"],
      { favorite: true }
    );
    expect(starred).toHaveLength(2);
    expect(starred.every((record) => record.favorite)).toBe(true);

    const tagged = await store.addTagToTransfers(
      ["transfer-1", "transfer-2", "missing-transfer"],
      "  Client   Ready  "
    );
    expect(tagged).toHaveLength(2);
    expect(tagged[0].tags).toContain("Client Ready");
    expect(store.getHistory().find((record) => record.id === "transfer-3")?.favorite).toBeFalsy();
  });

  it("atomically replaces and persists the latest complete phone music manifest", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pocketdock-phone-music-"));
    temporaryDirectories.push(root);
    const first = new StateStore(root);
    openStores.push(first);
    await first.load();
    const receivedAt = "2026-07-27T12:00:00.000Z";
    await first.upsertTrustedDevice({
      id: "phone-1",
      name: "Studio iPhone",
      tokenHash: "b".repeat(64),
      createdAt: receivedAt,
      lastSeenAt: receivedAt,
      lastAddress: "127.0.0.1",
      revoked: false,
      permissions: {
        sendToPc: true,
        receiveFromPc: true,
        clipboard: true,
        automaticBackup: false,
        remoteAccess: false,
        browseFiles: false,
        fileProvider: false,
        fileRequests: true
      }
    });
    await first.replacePhoneMusicLibrary({
      deviceId: "phone-1",
      deviceName: "Studio iPhone",
      generationId: "generation-one",
      generationSequence: 1,
      generatedAt: receivedAt,
      receivedAt,
      authorization: "authorized",
      complete: true,
      stale: false,
      music: [{ externalId: "song-1", title: "First", artist: "A", album: "One" }],
      collections: [],
      files: []
    });
    await first.replacePhoneMusicLibrary({
      deviceId: "phone-1",
      deviceName: "Studio iPhone",
      generationId: "generation-two",
      generationSequence: 2,
      generatedAt: "2026-07-27T12:01:00.000Z",
      receivedAt: "2026-07-27T12:01:01.000Z",
      authorization: "authorized",
      complete: true,
      stale: false,
      music: [{ externalId: "song-2", title: "Second", artist: "B", album: "Two" }],
      collections: [],
      files: [{
        externalId: "file-1",
        name: "Original.wav",
        relativePath: "Exports/Original.wav",
        size: 42,
        modifiedAt: "2026-07-27T11:59:00.000Z",
        contentType: "audio/wav",
        isAudio: true
      }]
    });
    expect(first.getPhoneMusicLibraries(Date.parse("2026-07-27T12:01:02.000Z"))).toEqual([
      expect.objectContaining({
        generationId: "generation-two",
        stale: false,
        music: [expect.objectContaining({ externalId: "song-2" })]
      })
    ]);
    first.close();
    openStores.splice(openStores.indexOf(first), 1);

    const second = new StateStore(root);
    openStores.push(second);
    await second.load();
    expect(second.databaseSchemaVersion()).toBe(7);
    expect(second.getPhoneMusicLibraries(Date.parse("2026-07-29T12:01:02.000Z"))).toEqual([
      expect.objectContaining({
        deviceId: "phone-1",
        deviceName: "Studio iPhone",
        generationId: "generation-two",
        stale: true,
        complete: true,
        files: [expect.objectContaining({ relativePath: "Exports/Original.wav" })]
      })
    ]);

    const trustedPhone = second.getTrustedDevices().find((device) => device.id === "phone-1");
    expect(trustedPhone).toBeDefined();
    await second.revokeTrustedDevice("phone-1");
    expect(second.getPhoneMusicLibraries()).toEqual([]);

    // Re-pairing must not resurrect the private inventory cached before revoke.
    await second.upsertTrustedDevice({ ...trustedPhone!, revoked: false });
    expect(second.getPhoneMusicLibraries()).toEqual([]);
  });
});
