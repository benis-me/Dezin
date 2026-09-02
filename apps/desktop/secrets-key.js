// The daemon encrypts API keys at rest with DEZIN_SECRETS_KEY. The shell owns that
// key: a random 32-byte value sealed with Electron's safeStorage (Keychain on macOS,
// DPAPI on Windows, libsecret on Linux) and kept in userData. Nothing is written when
// the OS keystore is unavailable, and an existing sealed key that no longer opens is
// left alone so ciphertext already in the database stays recoverable.

const { randomBytes } = require("node:crypto");
const fs = require("node:fs");
const { dirname } = require("node:path");

const KEY_BYTES = 32;

function validKey(candidate) {
  return typeof candidate === "string" && Buffer.from(candidate, "base64url").length === KEY_BYTES ? candidate : null;
}

/**
 * @returns {string | null} base64url key for DEZIN_SECRETS_KEY, or null when the
 * keystore is unavailable or the stored key cannot be opened.
 */
function loadOrCreateSecretsKey({ file, safeStorage, io = fs, random = randomBytes }) {
  if (!safeStorage || typeof safeStorage.isEncryptionAvailable !== "function" || !safeStorage.isEncryptionAvailable()) {
    return null;
  }
  let sealed = null;
  try {
    sealed = io.readFileSync(file);
  } catch (error) {
    if (!error || error.code !== "ENOENT") return null;
  }
  if (sealed !== null) {
    try {
      return validKey(safeStorage.decryptString(sealed));
    } catch {
      return null;
    }
  }
  const key = random(KEY_BYTES).toString("base64url");
  try {
    io.mkdirSync(dirname(file), { recursive: true });
    io.writeFileSync(file, safeStorage.encryptString(key), { mode: 0o600 });
  } catch {
    return null;
  }
  return key;
}

module.exports = { loadOrCreateSecretsKey };
