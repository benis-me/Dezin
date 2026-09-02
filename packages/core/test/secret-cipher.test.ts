import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { Store, SecretCipherError, createSecretCipher, isEncryptedSecret, secretCipherFromEnv } from "../src/index.ts";

const KEY = randomBytes(32);

test("secret cipher round-trips, never repeats a nonce, and rejects the wrong key", () => {
  const cipher = createSecretCipher(KEY);
  const a = cipher.encrypt("sk-live-1234");
  const b = cipher.encrypt("sk-live-1234");
  assert.ok(isEncryptedSecret(a));
  assert.notEqual(a, b, "each value gets its own nonce");
  assert.equal(cipher.decrypt(a), "sk-live-1234");
  assert.equal(cipher.decrypt(""), "");
  assert.equal(cipher.decrypt("plain-legacy"), "plain-legacy");
  assert.equal(cipher.encrypt(""), "");
  assert.throws(() => createSecretCipher(randomBytes(16)), SecretCipherError);
  assert.throws(() => createSecretCipher(randomBytes(32)).decrypt(a), SecretCipherError);
  assert.throws(() => cipher.decrypt("enc:v1:malformed"), SecretCipherError);
});

test("secretCipherFromEnv reads DEZIN_SECRETS_KEY and refuses a short key", () => {
  assert.equal(secretCipherFromEnv({}), null);
  assert.equal(secretCipherFromEnv({ DEZIN_SECRETS_KEY: "  " }), null);
  assert.throws(() => secretCipherFromEnv({ DEZIN_SECRETS_KEY: "dG9vLXNob3J0" }), SecretCipherError);
  const cipher = secretCipherFromEnv({ DEZIN_SECRETS_KEY: KEY.toString("base64url") });
  assert.ok(cipher);
  assert.equal(cipher.decrypt(cipher.encrypt("x")), "x");
});

function storedColumn(store: Store, column: string): string {
  const row = store.db.prepare(`SELECT ${column} AS value FROM settings WHERE id = 'app'`).get() as { value: string } | undefined;
  return row?.value ?? "";
}

test("settings secrets are ciphertext on disk and plain text through the Store", () => {
  const store = new Store(":memory:", undefined, { secretCipher: createSecretCipher(KEY) });
  store.updateSettings({ apiKey: "sk-live-1234", imageApiKey: "img-9", model: "opus" });
  assert.equal(store.getSettings().apiKey, "sk-live-1234");
  assert.equal(store.getSettings().imageApiKey, "img-9");
  assert.equal(store.getSettings().model, "opus");
  assert.ok(isEncryptedSecret(storedColumn(store, "api_key")));
  assert.ok(isEncryptedSecret(storedColumn(store, "image_api_key")));
  assert.equal(storedColumn(store, "video_api_key"), "");
  // An unrelated update keeps the ciphertext untouched.
  const before = storedColumn(store, "api_key");
  store.updateSettings({ model: "sonnet" });
  assert.equal(storedColumn(store, "api_key"), before);
  assert.equal(store.getSettings().apiKey, "sk-live-1234");
  store.close();
});

test("legacy plain-text secrets are migrated to ciphertext on the next write", () => {
  const plain = new Store(":memory:");
  plain.updateSettings({ apiKey: "legacy-plain" });
  assert.equal(storedColumn(plain, "api_key"), "legacy-plain");
  plain.close();

  const store = new Store(":memory:", undefined, { secretCipher: createSecretCipher(KEY) });
  store.db.prepare("INSERT INTO settings (id, api_key) VALUES ('app', 'legacy-plain')").run();
  assert.equal(store.getSettings().apiKey, "legacy-plain");
  store.updateSettings({ model: "opus" });
  assert.ok(isEncryptedSecret(storedColumn(store, "api_key")));
  assert.equal(store.getSettings().apiKey, "legacy-plain");
  store.close();
});

test("a ciphertext the current process cannot open reads as unconfigured and is never overwritten", () => {
  const writer = new Store(":memory:", undefined, { secretCipher: createSecretCipher(KEY) });
  writer.updateSettings({ apiKey: "sk-live-1234" });
  const sealed = storedColumn(writer, "api_key");
  writer.close();

  for (const options of [{}, { secretCipher: createSecretCipher(randomBytes(32)) }]) {
    const store = new Store(":memory:", undefined, options);
    store.db.prepare("INSERT INTO settings (id, api_key) VALUES ('app', ?)").run(sealed);
    assert.equal(store.getSettings().apiKey, "");
    store.updateSettings({ model: "opus" });
    assert.equal(storedColumn(store, "api_key"), sealed, "unreadable ciphertext survives unrelated writes");
    store.updateSettings({ apiKey: "" });
    assert.equal(storedColumn(store, "api_key"), "", "an explicit clear still clears");
    store.close();
  }
});
