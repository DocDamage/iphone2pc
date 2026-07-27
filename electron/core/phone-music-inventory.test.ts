import http from "node:http";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { encryptTransferChunk } from "./crypto-utils.js";
import { StateStore } from "./store.js";
import {
  MAX_PHONE_MUSIC_INVENTORY_PLAIN_BYTES,
  MAX_PHONE_MUSIC_TRACKS,
  TransferService
} from "./transfer-service.js";
import type { TransferEvent } from "./types.js";

interface Harness {
  root: string;
  store: StateStore;
  service: TransferService;
  baseUrl: string;
  token: string;
  deviceId: string;
  deviceName: string;
}

const cleanup: Array<() => Promise<void>> = [];

async function availablePort(): Promise<number> {
  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No test port");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

async function createHarness(): Promise<Harness> {
  const root = await mkdtemp(path.join(os.tmpdir(), "pocketdock-phone-inventory-"));
  const mobile = path.join(root, "mobile");
  await mkdir(mobile, { recursive: true });
  await writeFile(path.join(mobile, "index.html"), "PocketDock");
  const store = new StateStore(path.join(root, "data"));
  await store.load();
  await store.updateSettings({
    destinationDirectory: path.join(root, "downloads"),
    port: await availablePort(),
    deviceName: "Inventory PC"
  });
  const service = new TransferService(store, mobile, path.join(root, "data"));
  await service.start();
  cleanup.push(async () => {
    await service.stop();
    store.close();
    await rm(root, { recursive: true, force: true });
  });

  const baseUrl = `http://127.0.0.1:${service.getConnectionInfo().port}`;
  const deviceId = "11111111-2222-4333-8444-555555555555";
  const deviceName = "Authenticated iPhone";
  const pairedResponse = await fetch(`${baseUrl}/api/pair`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      pin: service.getConnectionInfo().pin,
      deviceId,
      deviceName,
      platform: "ios"
    })
  });
  expect(pairedResponse.status).toBe(200);
  const paired = await pairedResponse.json() as { token: string; deviceId: string };
  return { root, store, service, baseUrl, token: paired.token, deviceId, deviceName };
}

function inventory(
  generationId = "generation-one",
  generatedAt = "2026-07-27T12:00:00.000Z",
  generationSequence = 1
): Record<string, unknown> {
  return {
    generationId,
    generationSequence,
    generatedAt,
    authorization: "authorized",
    complete: true,
    music: [{
      externalId: "musickit-song-1",
      title: "Owned Song",
      artist: "Pocket Artist",
      album: "Pocket Album",
      duration: 213.5,
      track: 2,
      disc: 1,
      year: 2026,
      genre: "Electronic"
    }],
    collections: [{
      externalId: "musickit-playlist-docroshi",
      name: "DocRoshi Beats",
      kind: "playlist",
      itemCount: 1,
      trackExternalIds: ["musickit-song-1"]
    }],
    files: [{
      externalId: "documents-file-1",
      name: "Original Mix.wav",
      relativePath: "Exports/Original Mix.wav",
      size: 4_096,
      modifiedAt: "2026-07-27T11:30:00.000Z",
      contentType: "audio/wav",
      isAudio: true
    }]
  };
}

function encryptedInventory(
  harness: Pick<Harness, "store" | "deviceId">,
  payload: Record<string, unknown>
): { body: ArrayBuffer; headers: Record<string, string> } {
  const plaintext = Buffer.from(JSON.stringify(payload), "utf8");
  const encrypted = encryptTransferChunk(
    harness.store.getTransferSecret(),
    `music-inventory:${harness.deviceId}`,
    0,
    plaintext
  );
  return {
    body: Uint8Array.from(encrypted.payload).buffer,
    headers: {
      "Content-Type": "application/octet-stream",
      "X-PocketDock-IV": encrypted.iv,
      "X-PocketDock-Plain-Length": plaintext.length.toString()
    }
  };
}

async function publish(
  harness: Harness,
  payload: Record<string, unknown>,
  authenticated = true
): Promise<Response> {
  const encrypted = encryptedInventory(harness, payload);
  return fetch(`${harness.baseUrl}/api/music/inventory`, {
    method: "PUT",
    headers: {
      ...encrypted.headers,
      ...(authenticated ? { Authorization: `Bearer ${harness.token}` } : {})
    },
    body: encrypted.body
  });
}

afterEach(async () => {
  for (const action of cleanup.splice(0).reverse()) await action();
});

describe("native iPhone music inventory", () => {
  it("requires an authenticated, permitted session and authenticated encryption", async () => {
    const harness = await createHarness();
    expect((await publish(harness, inventory(), false)).status).toBe(401);

    const trusted = harness.store
      .getTrustedDevices()
      .find((device) => device.id === harness.deviceId)!;
    await harness.service.updateTrustedDevicePermissions(harness.deviceId, {
      ...trusted.permissions,
      sendToPc: false
    });
    expect((await publish(harness, inventory())).status).toBe(403);

    await harness.service.updateTrustedDevicePermissions(harness.deviceId, {
      ...trusted.permissions,
      sendToPc: true
    });
    const encrypted = encryptedInventory(harness, inventory());
    const tampered = new Uint8Array(encrypted.body);
    tampered[tampered.length - 1] ^= 1;
    const tamperedResponse = await fetch(`${harness.baseUrl}/api/music/inventory`, {
      method: "PUT",
      headers: {
        ...encrypted.headers,
        Authorization: `Bearer ${harness.token}`
      },
      body: tampered.buffer
    });
    expect(tamperedResponse.status).toBe(400);
    expect(harness.store.getPhoneMusicLibraries()).toEqual([]);
  });

  it("strictly validates caps and never trusts payload device identity or phone paths", async () => {
    const harness = await createHarness();
    const maliciousIdentity = {
      ...inventory(),
      deviceId: "attacker-device",
      deviceName: "Spoofed iPhone"
    };
    expect((await publish(harness, maliciousIdentity)).status).toBe(400);
    expect(harness.store.getPhoneMusicLibraries()).toEqual([]);

    const incomplete = { ...inventory(), complete: false };
    expect((await publish(harness, incomplete)).status).toBe(400);

    const unsafePath = inventory();
    unsafePath.files = [{
      externalId: "unsafe-file",
      name: "secret.mp3",
      relativePath: "/private/var/mobile/secret.mp3",
      size: 12,
      modifiedAt: "2026-07-27T11:30:00.000Z",
      isAudio: true
    }];
    expect((await publish(harness, unsafePath)).status).toBe(400);

    const overCount = inventory();
    overCount.music = Array.from({ length: MAX_PHONE_MUSIC_TRACKS + 1 }, (_, index) => ({
      externalId: `song-${index}`,
      title: "T",
      artist: "",
      album: ""
    }));
    expect((await publish(harness, overCount)).status).toBe(400);

    const duplicateCollections = inventory();
    const firstCollection = (duplicateCollections.collections as Array<Record<string, unknown>>)[0]!;
    duplicateCollections.collections = [firstCollection, { ...firstCollection }];
    expect((await publish(harness, duplicateCollections)).status).toBe(400);

    const repeatedPlaylistEntry = inventory("generation-repeated-playlist-entry");
    const repeatedCollection = (
      repeatedPlaylistEntry.collections as Array<Record<string, unknown>>
    )[0]!;
    repeatedCollection.itemCount = 2;
    repeatedCollection.trackExternalIds = ["musickit-song-1", "musickit-song-1"];
    expect((await publish(harness, repeatedPlaylistEntry)).status).toBe(201);
    expect(
      harness.store.getPhoneMusicLibraries()[0]?.collections[0]?.trackExternalIds
    ).toEqual(["musickit-song-1", "musickit-song-1"]);

    const validEncrypted = encryptedInventory(harness, inventory());
    const oversizedHeaderResponse = await fetch(`${harness.baseUrl}/api/music/inventory`, {
      method: "PUT",
      headers: {
        ...validEncrypted.headers,
        Authorization: `Bearer ${harness.token}`,
        "X-PocketDock-Plain-Length": (MAX_PHONE_MUSIC_INVENTORY_PLAIN_BYTES + 1).toString()
      },
      body: validEncrypted.body
    });
    expect(oversizedHeaderResponse.status).toBe(413);
  });

  it("accepts the previous inventory shape and normalizes missing collections", async () => {
    const harness = await createHarness();
    const previousShape = inventory("generation-before-playlists");
    delete previousShape.collections;

    const response = await publish(harness, previousShape);
    expect(response.status).toBe(201);
    expect(harness.store.getPhoneMusicLibraries()[0]?.collections).toEqual([]);
  });

  it("derives identity from the session, emits after commit, and replaces the device manifest", async () => {
    const harness = await createHarness();
    const events: TransferEvent[] = [];
    harness.service.setEventHandler((event) => events.push(event));

    const first = await publish(harness, inventory("generation-one"));
    expect(first.status).toBe(201);
    expect(await first.json()).toMatchObject({
      saved: true,
      generationId: "generation-one",
      musicCount: 1,
      collectionCount: 1,
      fileCount: 1
    });
    expect(harness.store.getPhoneMusicLibraries()).toEqual([
      expect.objectContaining({
        deviceId: harness.deviceId,
        deviceName: harness.deviceName,
        generationId: "generation-one",
        complete: true,
        collections: [expect.objectContaining({ name: "DocRoshi Beats" })],
        stale: false
      })
    ]);
    expect(events.at(-1)).toMatchObject({
      type: "music-updated",
      payload: {
        source: "iphone",
        deviceId: harness.deviceId,
        generationId: "generation-one"
      }
    });

    const replacement = inventory("generation-two", "2026-07-27T12:01:00.000Z", 2);
    replacement.music = [];
    replacement.collections = [];
    replacement.files = [];
    const second = await publish(harness, replacement);
    expect(second.status).toBe(201);
    expect(harness.store.getPhoneMusicLibraries()).toEqual([
      expect.objectContaining({
        generationId: "generation-two",
        music: [],
        collections: [],
        files: []
      })
    ]);
    expect(events.filter((event) => event.type === "music-updated")).toHaveLength(2);

    const duplicate = await publish(
      harness,
      inventory("generation-two", "2026-07-27T12:02:00.000Z", 3)
    );
    expect(duplicate.status).toBe(200);
    expect(await duplicate.json()).toMatchObject({
      saved: false,
      reason: "duplicate",
      generationId: "generation-two"
    });
    const stale = await publish(
      harness,
      inventory("generation-old", "2026-07-27T12:03:00.000Z", 1)
    );
    expect(stale.status).toBe(200);
    expect(await stale.json()).toMatchObject({
      saved: false,
      reason: "stale",
      generationId: "generation-two"
    });
    expect(harness.store.getPhoneMusicLibraries()[0]).toMatchObject({
      generationId: "generation-two",
      music: [],
      collections: [],
      files: []
    });
    expect(events.filter((event) => event.type === "music-updated")).toHaveLength(2);
  });

  it("orders different generations by a persisted sequence instead of the wall clock", async () => {
    const harness = await createHarness();
    expect((await publish(
      harness,
      inventory("generation-sequence-10", "2026-07-27T12:00:00.000Z", 10)
    )).status).toBe(201);

    // Same timestamp and a clock rollback are both valid when the logical clock advances.
    expect((await publish(
      harness,
      inventory("generation-sequence-11", "2026-07-27T12:00:00.000Z", 11)
    )).status).toBe(201);
    expect((await publish(
      harness,
      inventory("generation-sequence-12", "2026-07-26T12:00:00.000Z", 12)
    )).status).toBe(201);

    const lateOlderRequest = await publish(
      harness,
      inventory("generation-sequence-11-late", "2026-07-27T13:00:00.000Z", 11)
    );
    expect(lateOlderRequest.status).toBe(200);
    expect(await lateOlderRequest.json()).toMatchObject({
      saved: false,
      reason: "stale",
      generationId: "generation-sequence-12"
    });
  });
});
