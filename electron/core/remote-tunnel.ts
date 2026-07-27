import crypto from "node:crypto";

export type RemoteTunnelDirection = "request" | "response";

export interface RemoteTunnelEnvelope {
  type: "tunnel";
  version: 1 | 2;
  nonce: string;
  payload: string;
}

export interface RemoteEphemeralKeyPair {
  publicKey: string;
  privateKey: crypto.KeyObject;
}

function tunnelKey(secret: string): Buffer {
  const key = Buffer.from(secret, "base64url");
  if (key.length !== 32) {
    throw new Error("The PocketDock remote encryption key is invalid.");
  }
  return key;
}

function tunnelAad(direction: RemoteTunnelDirection, version: 1 | 2): Buffer {
  return Buffer.from(
    direction === "request"
      ? `PocketDock Remote Request v${version}`
      : `PocketDock Remote Response v${version}`,
    "utf8"
  );
}

export function createRemoteEphemeralKeyPair(): RemoteEphemeralKeyPair {
  const pair = crypto.generateKeyPairSync("x25519");
  const der = pair.publicKey.export({ type: "spki", format: "der" });
  return {
    publicKey: der.subarray(der.length - 32).toString("base64"),
    privateKey: pair.privateKey
  };
}

export function deriveRemoteSessionSecret(
  privateKey: crypto.KeyObject,
  peerPublicKey: string,
  transferSecret: string
): string {
  const rawPeer = Buffer.from(peerPublicKey, "base64");
  if (rawPeer.length !== 32) throw new Error("Invalid remote ephemeral public key.");
  const spkiPrefix = Buffer.from("302a300506032b656e032100", "hex");
  const peer = crypto.createPublicKey({
    key: Buffer.concat([spkiPrefix, rawPeer]),
    type: "spki",
    format: "der"
  });
  const shared = crypto.diffieHellman({ privateKey, publicKey: peer });
  const salt = tunnelKey(transferSecret);
  return Buffer.from(
    crypto.hkdfSync(
      "sha256",
      shared,
      salt,
      Buffer.from("PocketDock Remote Forward-Secret Session v2", "utf8"),
      32
    )
  ).toString("base64url");
}

export function encryptRemoteTunnel(
  secret: string,
  value: unknown,
  direction: RemoteTunnelDirection,
  version: 1 | 2 = 1
): RemoteTunnelEnvelope {
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", tunnelKey(secret), nonce);
  cipher.setAAD(tunnelAad(direction, version));
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(value), "utf8"),
    cipher.final()
  ]);
  const payload = Buffer.concat([ciphertext, cipher.getAuthTag()]);
  return {
    type: "tunnel",
    version,
    nonce: nonce.toString("base64"),
    payload: payload.toString("base64")
  };
}

export function decryptRemoteTunnel<T>(
  secret: string,
  envelope: RemoteTunnelEnvelope,
  direction: RemoteTunnelDirection
): T {
  if (
    envelope.type !== "tunnel" ||
    ![1, 2].includes(envelope.version) ||
    typeof envelope.nonce !== "string" ||
    typeof envelope.payload !== "string"
  ) {
    throw new Error("Unsupported PocketDock remote tunnel envelope.");
  }
  const nonce = Buffer.from(envelope.nonce, "base64");
  const combined = Buffer.from(envelope.payload, "base64");
  if (nonce.length !== 12 || combined.length < 17) {
    throw new Error("The PocketDock remote tunnel envelope is malformed.");
  }
  const ciphertext = combined.subarray(0, combined.length - 16);
  const tag = combined.subarray(combined.length - 16);
  const decipher = crypto.createDecipheriv("aes-256-gcm", tunnelKey(secret), nonce);
  decipher.setAAD(tunnelAad(direction, envelope.version));
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return JSON.parse(plaintext.toString("utf8")) as T;
}
