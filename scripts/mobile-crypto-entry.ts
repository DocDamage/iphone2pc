import { gcm } from "@noble/ciphers/aes.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { detectIphoneBrowser } from "./mobile-runtime.js";

function encrypt(
  key: Uint8Array,
  nonce: Uint8Array,
  aad: Uint8Array,
  plaintext: Uint8Array
): Uint8Array {
  return gcm(key, nonce, aad).encrypt(plaintext);
}

function decrypt(
  key: Uint8Array,
  nonce: Uint8Array,
  aad: Uint8Array,
  payload: Uint8Array
): Uint8Array {
  return gcm(key, nonce, aad).decrypt(payload);
}

Object.assign(globalThis, {
  PocketDockCrypto: Object.freeze({
    encrypt,
    decrypt,
    sha256,
    detectBrowser: detectIphoneBrowser
  })
});
