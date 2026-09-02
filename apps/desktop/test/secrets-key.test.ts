const test = require("node:test");
const assert = require("node:assert/strict");

const { loadOrCreateSecretsKey } = require("../secrets-key.js");

function fakeSafeStorage(available = true) {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (value: string) => Buffer.from(`sealed:${value}`),
    decryptString: (sealed: Buffer) => {
      const text = sealed.toString();
      if (!text.startsWith("sealed:")) throw new Error("wrong keystore");
      return text.slice("sealed:".length);
    },
  };
}

function memoryIo(initial: Record<string, Buffer> = {}) {
  const files = new Map(Object.entries(initial));
  const modes = new Map<string, number>();
  return {
    files,
    modes,
    readFileSync(path: string) {
      const found = files.get(path);
      if (!found) throw Object.assign(new Error("missing"), { code: "ENOENT" });
      return found;
    },
    writeFileSync(path: string, data: Buffer, options: { mode: number }) {
      files.set(path, data);
      modes.set(path, options.mode);
    },
    mkdirSync() {},
  };
}

test("creates a sealed 32-byte key once and reuses it afterwards", () => {
  const io = memoryIo();
  const safeStorage = fakeSafeStorage();
  const first = loadOrCreateSecretsKey({ file: "/data/secrets-key.enc", safeStorage, io, random: () => Buffer.alloc(32, 7) });
  assert.equal(Buffer.from(first, "base64url").length, 32);
  assert.equal(io.modes.get("/data/secrets-key.enc"), 0o600);
  assert.equal(io.files.get("/data/secrets-key.enc")?.toString(), `sealed:${first}`);

  const second = loadOrCreateSecretsKey({ file: "/data/secrets-key.enc", safeStorage, io, random: () => Buffer.alloc(32, 9) });
  assert.equal(second, first);
});

test("returns null without a keystore and writes nothing", () => {
  const io = memoryIo();
  assert.equal(loadOrCreateSecretsKey({ file: "/data/k", safeStorage: fakeSafeStorage(false), io }), null);
  assert.equal(loadOrCreateSecretsKey({ file: "/data/k", safeStorage: undefined, io }), null);
  assert.equal(io.files.size, 0);
});

test("a sealed key that no longer opens is preserved, not replaced", () => {
  const io = memoryIo({ "/data/k": Buffer.from("garbage") });
  assert.equal(loadOrCreateSecretsKey({ file: "/data/k", safeStorage: fakeSafeStorage(), io }), null);
  assert.equal(io.files.get("/data/k")?.toString(), "garbage");
});

test("a stored value of the wrong length is rejected and not overwritten", () => {
  const io = memoryIo({ "/data/k": Buffer.from("sealed:short") });
  assert.equal(loadOrCreateSecretsKey({ file: "/data/k", safeStorage: fakeSafeStorage(), io }), null);
  assert.equal(io.files.get("/data/k")?.toString(), "sealed:short");
});

test("read errors other than a missing file yield null", () => {
  const io = memoryIo();
  io.readFileSync = () => {
    throw Object.assign(new Error("denied"), { code: "EACCES" });
  };
  assert.equal(loadOrCreateSecretsKey({ file: "/data/k", safeStorage: fakeSafeStorage(), io }), null);
});

test("a write failure yields null instead of an unsealed key", () => {
  const io = memoryIo();
  io.writeFileSync = () => {
    throw new Error("read-only");
  };
  assert.equal(loadOrCreateSecretsKey({ file: "/data/k", safeStorage: fakeSafeStorage(), io }), null);
});
