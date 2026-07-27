import http from "node:http";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { StateStore } from "./store.js";
import { TransferService } from "./transfer-service.js";
import { decryptTransferChunk, encryptTransferChunk } from "./crypto-utils.js";

const cleanup: Array<() => Promise<void>> = [];

async function availablePort(): Promise<number> {
  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No test port");
  const port = address.port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

afterEach(async () => {
  for (const action of cleanup.splice(0).reverse()) await action();
});

describe("TransferService integration", () => {
  it("pairs, resumes a chunked upload, and commits the completed file", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pocketdock-service-"));
    const data = path.join(root, "data");
    const downloads = path.join(root, "downloads");
    const mobile = path.join(root, "mobile");
    await mkdir(mobile, { recursive: true });
    await writeFile(path.join(mobile, "index.html"), "<!doctype html><title>PocketDock</title>");

    const store = new StateStore(data);
    await store.load();
    await store.updateSettings({
      destinationDirectory: downloads,
      port: await availablePort(),
      deviceName: "Test PC"
    });
    const service = new TransferService(store, mobile, data);
    await service.start();
    cleanup.push(async () => rm(root, { recursive: true, force: true }));
    cleanup.push(async () => store.close());
    cleanup.push(async () => service.stop());

    const connection = service.getConnectionInfo();
    if (connection.url) {
      expect(connection.url).toContain(`code=${connection.pin}`);
      expect(connection.url).toContain(`#key=${store.getTransferSecret()}`);
    } else {
      expect(connection.addresses).toEqual([]);
    }
    const baseUrl = `http://127.0.0.1:${connection.port}`;
    const pairResponse = await fetch(`${baseUrl}/api/pair`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pin: connection.pin, deviceName: "Test iPhone" })
    });
    expect(pairResponse.status).toBe(200);
    const paired = await pairResponse.json() as { token: string };
    const authorization = { Authorization: `Bearer ${paired.token}` };

    const bytes = Buffer.from("PocketDock handles chunk boundaries safely.");
    const startResponse = await fetch(`${baseUrl}/api/uploads`, {
      method: "POST",
      headers: { ...authorization, "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "../unsafe:beat?.wav",
        size: bytes.length,
        type: "audio/wav",
        lastModified: 123,
        relativePath: "../../Sessions/unsafe:beat?.wav",
        encrypted: true,
        protocolVersion: 2
      })
    });
    expect(startResponse.status).toBe(201);
    const started = await startResponse.json() as { id: string };

    const firstChunk = bytes.subarray(0, 13);
    const firstEncrypted = encryptTransferChunk(
      store.getTransferSecret(),
      started.id,
      0,
      firstChunk
    );
    const firstResponse = await fetch(
      `${baseUrl}/api/uploads/${started.id}?offset=0`,
      {
        method: "PUT",
        headers: {
          ...authorization,
          "X-PocketDock-IV": firstEncrypted.iv,
          "X-PocketDock-Plain-Length": firstChunk.length.toString()
        },
        body: Uint8Array.from(firstEncrypted.payload).buffer
      }
    );
    expect(firstResponse.status).toBe(200);
    expect((await firstResponse.json() as { offset: number }).offset).toBe(firstChunk.length);

    const resumeResponse = await fetch(`${baseUrl}/api/uploads`, {
      method: "POST",
      headers: { ...authorization, "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "../unsafe:beat?.wav",
        size: bytes.length,
        type: "audio/wav",
        lastModified: 123,
        relativePath: "../../Sessions/unsafe:beat?.wav",
        encrypted: true,
        protocolVersion: 2
      })
    });
    const resumed = await resumeResponse.json() as { id: string; offset: number; resumed: boolean };
    expect(resumed).toMatchObject({ id: started.id, offset: firstChunk.length, resumed: true });

    const finalPlaintext = bytes.subarray(firstChunk.length);
    const finalEncrypted = encryptTransferChunk(
      store.getTransferSecret(),
      started.id,
      firstChunk.length,
      finalPlaintext
    );
    const finalResponse = await fetch(
      `${baseUrl}/api/uploads/${started.id}?offset=${firstChunk.length}`,
      {
        method: "PUT",
        headers: {
          ...authorization,
          "X-PocketDock-IV": finalEncrypted.iv,
          "X-PocketDock-Plain-Length": finalPlaintext.length.toString()
        },
        body: Uint8Array.from(finalEncrypted.payload).buffer
      }
    );
    expect(finalResponse.status).toBe(200);

    const mismatchResponse = await fetch(
      `${baseUrl}/api/uploads/${started.id}/complete`,
      {
        method: "POST",
        headers: { ...authorization, "Content-Type": "application/json" },
        body: JSON.stringify({ sha256: "0".repeat(64) })
      }
    );
    expect(mismatchResponse.status).toBe(422);

    const completeResponse = await fetch(
      `${baseUrl}/api/uploads/${started.id}/complete`,
      {
        method: "POST",
        headers: { ...authorization, "Content-Type": "application/json" },
        body: JSON.stringify({
          sha256: crypto.createHash("sha256").update(bytes).digest("hex")
        })
      }
    );
    expect(completeResponse.status).toBe(200);

    const savedPath = await realpath(path.join(downloads, "Sessions", "unsafe_beat_.wav"));
    expect(await readFile(savedPath, "utf8")).toBe(bytes.toString());
    expect(store.getHistory()[0]).toMatchObject({
      fileName: "unsafe_beat_.wav",
      status: "completed",
      sourceDevice: "Test iPhone",
      savedPath
    });
  });

  it("rejects a concurrent chunk write for the same upload", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pocketdock-concurrent-chunk-"));
    const data = path.join(root, "data");
    const mobile = path.join(root, "mobile");
    await mkdir(mobile, { recursive: true });
    await writeFile(path.join(mobile, "index.html"), "PocketDock");

    const store = new StateStore(data);
    await store.load();
    await store.updateSettings({
      destinationDirectory: path.join(root, "downloads"),
      port: await availablePort(),
      encryptTransfers: false,
      maxConcurrentUploads: 2
    });
    const service = new TransferService(store, mobile, data);
    await service.start();
    cleanup.push(async () => rm(root, { recursive: true, force: true }));
    cleanup.push(async () => store.close());
    cleanup.push(async () => service.stop());

    const baseUrl = `http://127.0.0.1:${service.getConnectionInfo().port}`;
    const pairResponse = await fetch(`${baseUrl}/api/pair`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pin: service.getConnectionInfo().pin,
        deviceName: "Concurrent iPhone"
      })
    });
    const paired = await pairResponse.json() as { token: string };
    const authorization = `Bearer ${paired.token}`;
    const startResponse = await fetch(`${baseUrl}/api/uploads`, {
      method: "POST",
      headers: {
        Authorization: authorization,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        name: "race.txt",
        size: 2,
        type: "text/plain",
        lastModified: 123,
        relativePath: "race.txt",
        encrypted: false,
        protocolVersion: 2
      })
    });
    expect(startResponse.status).toBe(201);
    const started = await startResponse.json() as { id: string };

    type HeldResponse = {
      status: number;
      headers: http.IncomingHttpHeaders;
      body: string;
    };
    const beginHeldPut = (firstByte: string) => {
      let request!: http.ClientRequest;
      const response = new Promise<HeldResponse>((resolve, reject) => {
        request = http.request(
          `${baseUrl}/api/uploads/${started.id}?offset=0`,
          {
            method: "PUT",
            headers: {
              Authorization: authorization,
              "Content-Length": "2"
            }
          },
          (incoming) => {
            const chunks: Buffer[] = [];
            incoming.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
            incoming.on("end", () => resolve({
              status: incoming.statusCode ?? 0,
              headers: incoming.headers,
              body: Buffer.concat(chunks).toString("utf8")
            }));
          }
        );
        request.on("error", reject);
        request.write(firstByte);
      });
      return { request, response };
    };

    // Both requests stay open after one byte. Whichever reaches the route first
    // owns the upload; the other must be rejected without waiting for its body.
    const first = beginHeldPut("a");
    const second = beginHeldPut("b");
    let timeout: NodeJS.Timeout | undefined;
    const outcome = await Promise.race([
      first.response.then((response) => ({ slot: "first" as const, response })),
      second.response.then((response) => ({ slot: "second" as const, response })),
      new Promise<{ slot: "timeout"; response: null }>((resolve) => {
        timeout = setTimeout(() => resolve({ slot: "timeout", response: null }), 2_000);
      })
    ]);
    if (timeout) clearTimeout(timeout);

    if (outcome.slot === "timeout") {
      first.request.end("x");
      second.request.end("y");
      await Promise.allSettled([first.response, second.response]);
      throw new Error("Neither concurrent upload request was rejected.");
    }

    const blocked = outcome.slot === "first" ? first : second;
    const active = outcome.slot === "first" ? second : first;
    expect(outcome.response.status).toBe(409);
    expect(outcome.response.headers["retry-after"]).toBe("1");
    expect(JSON.parse(outcome.response.body)).toMatchObject({ code: "CHUNK_IN_PROGRESS" });
    blocked.request.destroy();

    active.request.end("z");
    const activeResponse = await active.response;
    expect(activeResponse.status).toBe(200);
    expect(JSON.parse(activeResponse.body)).toMatchObject({ offset: 2 });
  });

  it("requires authentication for transfer endpoints", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pocketdock-auth-"));
    const data = path.join(root, "data");
    const downloads = path.join(root, "downloads");
    const mobile = path.join(root, "mobile");
    await mkdir(mobile, { recursive: true });
    await writeFile(path.join(mobile, "index.html"), "PocketDock");
    const store = new StateStore(data);
    await store.load();
    await store.updateSettings({ destinationDirectory: downloads, port: await availablePort() });
    const service = new TransferService(store, mobile, data);
    await service.start();
    cleanup.push(async () => rm(root, { recursive: true, force: true }));
    cleanup.push(async () => store.close());
    cleanup.push(async () => service.stop());

    const response = await fetch(`http://127.0.0.1:${service.getConnectionInfo().port}/api/shares`);
    expect(response.status).toBe(401);
  });

  it("reconnects a trusted iPhone and rejects it after revocation", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pocketdock-trusted-"));
    const data = path.join(root, "data");
    const downloads = path.join(root, "downloads");
    const mobile = path.join(root, "mobile");
    await mkdir(mobile, { recursive: true });
    await writeFile(path.join(mobile, "index.html"), "PocketDock");
    const store = new StateStore(data);
    await store.load();
    await store.updateSettings({ destinationDirectory: downloads, port: await availablePort() });
    const service = new TransferService(store, mobile, data);
    await service.start();
    cleanup.push(async () => rm(root, { recursive: true, force: true }));
    cleanup.push(async () => store.close());
    cleanup.push(async () => service.stop());

    const baseUrl = `http://127.0.0.1:${service.getConnectionInfo().port}`;
    const deviceId = "A18A9E84-99A5-4DD8-A534-C75A629C9601";
    const oldPin = service.getConnectionInfo().pin;
    const pairResponse = await fetch(`${baseUrl}/api/pair`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pin: oldPin,
        deviceName: "Trusted iPhone",
        deviceId
      })
    });
    const paired = await pairResponse.json() as {
      deviceId: string;
      refreshToken: string;
    };
    expect(paired.deviceId).toBe(deviceId.toLowerCase());

    const reconnect = () =>
      fetch(`${baseUrl}/api/reconnect`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          deviceId,
          refreshToken: paired.refreshToken
        })
      });
    expect((await reconnect()).status).toBe(200);
    await service.revokeTrustedDevice(paired.deviceId);
    expect((await reconnect()).status).toBe(401);
    expect(service.getConnectionInfo().pin).not.toBe(oldPin);
    const oldPinPair = await fetch(`${baseUrl}/api/pair`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pin: oldPin,
        deviceName: "Revoked iPhone",
        deviceId
      })
    });
    expect(oldPinPair.status).toBe(401);
    expect(store.getTrustedDevices().find((device) => device.id === paired.deviceId)?.revoked).toBe(
      true
    );
  });

  it("enforces remote permission independently for each trusted device", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pocketdock-remote-permission-"));
    const data = path.join(root, "data");
    const mobile = path.join(root, "mobile");
    await mkdir(mobile, { recursive: true });
    await writeFile(path.join(mobile, "index.html"), "PocketDock");
    const store = new StateStore(data);
    await store.load();
    await store.updateSettings({
      destinationDirectory: path.join(root, "downloads"),
      port: await availablePort()
    });
    const service = new TransferService(store, mobile, data);
    await service.start();
    cleanup.push(async () => rm(root, { recursive: true, force: true }));
    cleanup.push(async () => store.close());
    cleanup.push(async () => service.stop());

    const baseUrl = `http://127.0.0.1:${service.getConnectionInfo().port}`;
    const deviceId = crypto.randomUUID();
    const pair = await fetch(`${baseUrl}/api/pair`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pin: service.getConnectionInfo().pin,
        deviceName: "Remote iPhone",
        deviceId
      })
    });
    const paired = await pair.json() as { token: string; deviceId: string };
    const headers = {
      Authorization: `Bearer ${paired.token}`,
      "X-PocketDock-Remote": "1"
    };
    expect((await fetch(`${baseUrl}/api/me`, { headers })).status).toBe(403);
    const trusted = store.getTrustedDevices().find((entry) => entry.id === paired.deviceId)!;
    await service.updateTrustedDevicePermissions(paired.deviceId, {
      ...trusted.permissions,
      remoteAccess: true
    });
    expect((await fetch(`${baseUrl}/api/me`, { headers })).status).toBe(200);
  });

  it("serves authenticated, encrypted, expiring private links", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pocketdock-private-link-"));
    const data = path.join(root, "data");
    const mobile = path.join(root, "mobile");
    await mkdir(mobile, { recursive: true });
    await writeFile(path.join(mobile, "index.html"), "PocketDock");
    const store = new StateStore(data);
    await store.load();
    await store.updateSettings({
      destinationDirectory: path.join(root, "downloads"),
      port: await availablePort()
    });
    const service = new TransferService(store, mobile, data);
    await service.start();
    cleanup.push(async () => rm(root, { recursive: true, force: true }));
    cleanup.push(async () => store.close());
    cleanup.push(async () => service.stop());

    const sharedPath = path.join(root, "mix.wav");
    const plaintext = Buffer.from("final mix");
    await writeFile(sharedPath, plaintext);
    await service.registerSharedFiles([sharedPath]);
    const shared = store.getSharedFiles()[0];
    const link = await service.createPrivateShareLink("Client mix", [shared.id], 2, 1);
    const secret = Buffer.from(store.getTransferSecret(), "base64url");
    const token = crypto
      .createHmac("sha256", secret)
      .update(`private-link-token:${link.id}`)
      .digest("base64url");
    const key = crypto
      .createHmac("sha256", secret)
      .update(`private-link-key:${link.id}`)
      .digest()
      .subarray(0, 32)
      .toString("base64url");
    const baseUrl = `http://127.0.0.1:${service.getConnectionInfo().port}`;
    const manifest = await fetch(`${baseUrl}/api/public-links/${link.id}`, {
      headers: { "X-PocketDock-Link-Token": token }
    });
    expect(manifest.status).toBe(200);
    const chunk = await fetch(
      `${baseUrl}/api/public-links/${link.id}/files/${shared.id}/chunk?offset=0&length=1024`,
      { headers: { "X-PocketDock-Link-Token": token } }
    );
    const decrypted = decryptTransferChunk(
      key,
      shared.id,
      0,
      Number(chunk.headers.get("x-pocketdock-plain-length")),
      chunk.headers.get("x-pocketdock-iv")!,
      Buffer.from(await chunk.arrayBuffer())
    );
    expect(decrypted).toEqual(plaintext);
    await fetch(`${baseUrl}/api/public-links/${link.id}/files/${shared.id}/complete`, {
      method: "POST",
      headers: { "X-PocketDock-Link-Token": token }
    });
    expect(
      (await fetch(`${baseUrl}/api/public-links/${link.id}`, {
        headers: { "X-PocketDock-Link-Token": token }
      })).status
    ).toBe(401);
  });

  it("retires time-limited watch-folder shares", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pocketdock-expiring-share-"));
    const data = path.join(root, "data");
    const mobile = path.join(root, "mobile");
    await mkdir(mobile, { recursive: true });
    await writeFile(path.join(mobile, "index.html"), "PocketDock");
    const store = new StateStore(data);
    await store.load();
    const service = new TransferService(store, mobile, data);
    cleanup.push(async () => rm(root, { recursive: true, force: true }));
    cleanup.push(async () => store.close());

    const sharedPath = path.join(root, "delivery.zip");
    await writeFile(sharedPath, "delivery");
    await service.registerSharedFiles([sharedPath], 60, "watch");
    const shared = service.getSharedFiles()[0];
    expect(shared).toMatchObject({ source: "watch" });
    expect(new Date(shared.expiresAt!).getTime()).toBeGreaterThan(Date.now());

    await store.setSharedFiles([
      { ...shared, expiresAt: new Date(Date.now() - 1_000).toISOString() }
    ]);
    expect(service.getSharedFiles()).toEqual([]);
    await expect(
      service.createPrivateShareLink("Expired", [shared.id], 1, 1)
    ).rejects.toThrow("Choose at least one shared file");
  });

  it("refreshes integrity metadata when a shared file changes", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pocketdock-share-integrity-"));
    const data = path.join(root, "data");
    const mobile = path.join(root, "mobile");
    await mkdir(mobile, { recursive: true });
    await writeFile(path.join(mobile, "index.html"), "PocketDock");
    const store = new StateStore(data);
    await store.load();
    const service = new TransferService(store, mobile, data);
    cleanup.push(async () => rm(root, { recursive: true, force: true }));
    cleanup.push(async () => store.close());

    const sharedPath = path.join(root, "master.wav");
    await writeFile(sharedPath, "version one");
    await service.registerSharedFiles([sharedPath]);
    const first = service.getSharedFiles()[0];

    await writeFile(sharedPath, "version two is different");
    await service.registerSharedFiles([sharedPath], 60);
    const refreshed = service.getSharedFiles()[0];

    expect(refreshed.id).toBe(first.id);
    expect(refreshed.sha256).not.toBe(first.sha256);
    expect(refreshed.size).not.toBe(first.size);
    expect(refreshed.expiresAt).toBeTruthy();
  });

  it("keeps a verified upload when a same-size duplicate candidate changed on disk", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pocketdock-stale-duplicate-"));
    const data = path.join(root, "data");
    const downloads = path.join(root, "downloads");
    const mobile = path.join(root, "mobile");
    await mkdir(mobile, { recursive: true });
    await writeFile(path.join(mobile, "index.html"), "PocketDock");
    const store = new StateStore(data);
    await store.load();
    await store.updateSettings({
      destinationDirectory: downloads,
      port: await availablePort(),
      encryptTransfers: false,
      conflictPolicy: "rename",
      duplicatePolicy: "skip-identical"
    });
    const service = new TransferService(store, mobile, data);
    await service.start();
    cleanup.push(async () => rm(root, { recursive: true, force: true }));
    cleanup.push(async () => store.close());
    cleanup.push(async () => service.stop());

    const baseUrl = `http://127.0.0.1:${service.getConnectionInfo().port}`;
    const pairResponse = await fetch(`${baseUrl}/api/pair`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pin: service.getConnectionInfo().pin,
        deviceName: "Duplicate iPhone"
      })
    });
    const paired = await pairResponse.json() as { token: string };
    const authorization = { Authorization: `Bearer ${paired.token}` };
    const original = Buffer.from("original");
    const modified = Buffer.from("modified");
    expect(modified.length).toBe(original.length);
    const sha256 = crypto.createHash("sha256").update(original).digest("hex");

    const uploadOriginal = async () => {
      const startedResponse = await fetch(`${baseUrl}/api/uploads`, {
        method: "POST",
        headers: { ...authorization, "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "stale.txt",
          size: original.length,
          type: "text/plain",
          lastModified: 123,
          relativePath: "stale.txt",
          encrypted: false,
          protocolVersion: 2
        })
      });
      expect(startedResponse.status).toBe(201);
      const started = await startedResponse.json() as { id: string };
      const chunkResponse = await fetch(`${baseUrl}/api/uploads/${started.id}?offset=0`, {
        method: "PUT",
        headers: authorization,
        body: Uint8Array.from(original).buffer
      });
      expect(chunkResponse.status).toBe(200);
      const completedResponse = await fetch(`${baseUrl}/api/uploads/${started.id}/complete`, {
        method: "POST",
        headers: { ...authorization, "Content-Type": "application/json" },
        body: JSON.stringify({ sha256 })
      });
      expect(completedResponse.status).toBe(200);
      return completedResponse.json() as Promise<{ duplicate: boolean; savedAs: string }>;
    };

    expect((await uploadOriginal()).duplicate).toBe(false);
    const historicalPath = path.join(downloads, "stale.txt");
    await writeFile(historicalPath, modified);

    const second = await uploadOriginal();
    expect(second).toMatchObject({ duplicate: false, savedAs: "stale (2).txt" });
    expect(await readFile(historicalPath, "utf8")).toBe("modified");
    expect(await readFile(path.join(downloads, "stale (2).txt"), "utf8")).toBe("original");
  });

  it("accepts bounded account-free file requests and holds them for PC approval", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pocketdock-request-"));
    const data = path.join(root, "data");
    const downloads = path.join(root, "downloads");
    const mobile = path.join(root, "mobile");
    await mkdir(mobile, { recursive: true });
    await writeFile(path.join(mobile, "index.html"), "PocketDock");
    const store = new StateStore(data);
    await store.load();
    await store.updateSettings({
      destinationDirectory: downloads,
      port: await availablePort()
    });
    const service = new TransferService(store, mobile, data);
    await service.start();
    cleanup.push(async () => rm(root, { recursive: true, force: true }));
    cleanup.push(async () => store.close());
    cleanup.push(async () => service.stop());

    const fileRequest = await service.createFileRequest({
      name: "Send mix notes",
      destinationSubfolder: "../Client: Uploads",
      expiresHours: 24,
      maxFileSize: 1_024,
      maxFiles: 1,
      requiresApproval: true
    });
    const token = crypto
      .createHmac("sha256", Buffer.from(store.getTransferSecret(), "base64url"))
      .update(`file-request-token:${fileRequest.id}`)
      .digest("base64url");
    const baseUrl = `http://127.0.0.1:${service.getConnectionInfo().port}`;
    const uploaded = await fetch(`${baseUrl}/api/file-requests/${fileRequest.id}/files`, {
      method: "POST",
      headers: {
        "Content-Type": "text/plain",
        "X-PocketDock-Request-Token": token,
        "X-PocketDock-File-Name": encodeURIComponent("../notes?.txt")
      },
      body: "turn the vocal up"
    });
    expect(uploaded.status).toBe(201);
    expect(await uploaded.json()).toMatchObject({ pendingApproval: true });
    const pending = store.getFileRequestUploads()[0];
    expect(pending).toMatchObject({
      fileName: "notes_.txt",
      status: "pending"
    });
    await service.approveFileRequestUpload(pending.id);
    expect(
      await readFile(path.join(downloads, "Client_ Uploads", "notes_.txt"), "utf8")
    ).toBe("turn the vocal up");
    expect(
      (await fetch(`${baseUrl}/api/file-requests/${fileRequest.id}`, {
        headers: { "X-PocketDock-Request-Token": token }
      })).status
    ).toBe(401);
  });

  it("reserves the final file-request slot while an upload is still in flight", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pocketdock-request-race-"));
    const data = path.join(root, "data");
    const mobile = path.join(root, "mobile");
    await mkdir(mobile, { recursive: true });
    await writeFile(path.join(mobile, "index.html"), "PocketDock");
    const store = new StateStore(data);
    await store.load();
    await store.updateSettings({
      destinationDirectory: path.join(root, "downloads"),
      port: await availablePort()
    });
    const service = new TransferService(store, mobile, data);
    await service.start();
    cleanup.push(async () => rm(root, { recursive: true, force: true }));
    cleanup.push(async () => store.close());
    cleanup.push(async () => service.stop());

    const fileRequest = await service.createFileRequest({
      name: "One file only",
      destinationSubfolder: "Requests",
      expiresHours: 24,
      maxFileSize: 1_024,
      maxFiles: 1,
      requiresApproval: true
    });
    const token = crypto
      .createHmac("sha256", Buffer.from(store.getTransferSecret(), "base64url"))
      .update(`file-request-token:${fileRequest.id}`)
      .digest("base64url");
    const baseUrl = `http://127.0.0.1:${service.getConnectionInfo().port}`;
    const uploadUrl = `${baseUrl}/api/file-requests/${fileRequest.id}/files`;

    type HeldResponse = { status: number; body: string };
    let heldRequest!: http.ClientRequest;
    const heldResponse = new Promise<HeldResponse>((resolve, reject) => {
      heldRequest = http.request(
        uploadUrl,
        {
          method: "POST",
          headers: {
            "Content-Type": "text/plain",
            "Content-Length": "2",
            "X-PocketDock-Request-Token": token,
            "X-PocketDock-File-Name": encodeURIComponent("first.txt")
          }
        },
        (incoming) => {
          const chunks: Buffer[] = [];
          incoming.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
          incoming.on("end", () => resolve({
            status: incoming.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8")
          }));
        }
      );
      heldRequest.on("error", reject);
      heldRequest.write("a");
    });
    void heldResponse.catch(() => undefined);
    cleanup.push(async () => {
      heldRequest.destroy();
    });

    let reservationObserved = false;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const statusResponse = await fetch(`${baseUrl}/api/file-requests/${fileRequest.id}`, {
        headers: { "X-PocketDock-Request-Token": token }
      });
      if (
        statusResponse.status === 200 &&
        (await statusResponse.json() as { remainingFiles: number }).remainingFiles === 0
      ) {
        reservationObserved = true;
        break;
      }
    }
    expect(reservationObserved).toBe(true);

    const competingResponse = await fetch(uploadUrl, {
      method: "POST",
      headers: {
        "Content-Type": "text/plain",
        "X-PocketDock-Request-Token": token,
        "X-PocketDock-File-Name": encodeURIComponent("second.txt")
      },
      body: "no"
    });
    expect(competingResponse.status).toBe(401);

    heldRequest.end("b");
    expect((await heldResponse).status).toBe(201);
    expect(store.getFileRequests().find((request) => request.id === fileRequest.id)?.receivedCount)
      .toBe(1);
    expect(store.getFileRequestUploads()).toHaveLength(1);
  });
});
import crypto from "node:crypto";
