import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../../../packages/core/src/index.ts";
import * as extensionAuth from "../src/extension-auth.ts";

const EXPECTED_PAIR_CODE_TTL_MS = 5 * 60_000;
const EXPECTED_ATTEMPT_WINDOW_MS = 5 * 60_000;
const EXPECTED_ATTEMPTS_PER_EXTENSION = 8;
const EXPECTED_ATTEMPTS_GLOBAL = 32;

function exchangeError(
  service: extensionAuth.StoreExtensionPairingService,
  code: string,
  extensionId: string,
): { status: number; message: string } {
  try {
    service.exchange(code, extensionId);
    assert.fail("expected exchange to fail");
  } catch (error) {
    const value = error as { status?: unknown; message?: unknown };
    assert.equal(typeof value.status, "number");
    assert.equal(typeof value.message, "string");
    return { status: value.status as number, message: value.message as string };
  }
}

test("extension pairing exports its five-minute bounded attempt policy", () => {
  assert.equal(extensionAuth.EXTENSION_PAIR_CODE_TTL_MS, EXPECTED_PAIR_CODE_TTL_MS);
  assert.equal(extensionAuth.EXTENSION_PAIR_ATTEMPT_WINDOW_MS, EXPECTED_ATTEMPT_WINDOW_MS);
  assert.equal(extensionAuth.EXTENSION_PAIR_ATTEMPTS_PER_EXTENSION, EXPECTED_ATTEMPTS_PER_EXTENSION);
  assert.equal(extensionAuth.EXTENSION_PAIR_ATTEMPTS_GLOBAL, EXPECTED_ATTEMPTS_GLOBAL);
});

test("extension pairing returns 429 after the per-extension attempt ceiling", () => {
  const store = new Store(":memory:");
  const service = new extensionAuth.StoreExtensionPairingService(store, { now: () => 10_000 });
  try {
    for (let attempt = 0; attempt < EXPECTED_ATTEMPTS_PER_EXTENSION; attempt += 1) {
      assert.equal(exchangeError(service, "000000", "extension-a").status, 400);
    }
    assert.equal(exchangeError(service, "000000", "extension-a").status, 429);
  } finally {
    store.close();
  }
});

test("extension pairing returns 429 after the global attempt ceiling across origins", () => {
  const store = new Store(":memory:");
  const service = new extensionAuth.StoreExtensionPairingService(store, { now: () => 20_000 });
  try {
    for (let attempt = 0; attempt < EXPECTED_ATTEMPTS_GLOBAL; attempt += 1) {
      assert.equal(exchangeError(service, "000000", `extension-${attempt}`).status, 400);
    }
    assert.equal(exchangeError(service, "000000", "extension-after-global-ceiling").status, 429);
  } finally {
    store.close();
  }
});

test("extension pairing allows a legitimate code at the per-extension ceiling", () => {
  const store = new Store(":memory:");
  const service = new extensionAuth.StoreExtensionPairingService(store, { now: () => 30_000 });
  try {
    const { code } = service.createCode();
    for (let attempt = 1; attempt < EXPECTED_ATTEMPTS_PER_EXTENSION; attempt += 1) {
      assert.equal(exchangeError(service, "not-the-code", "extension-legitimate").status, 400);
    }
    const paired = service.exchange(code, "extension-legitimate");
    assert.match(paired.token, /^dezin_ext_/);
    assert.equal(paired.credential.extensionId, "extension-legitimate");
  } finally {
    store.close();
  }
});

test("extension pairing resets both attempt windows after five minutes", () => {
  const store = new Store(":memory:");
  let now = 40_000;
  const service = new extensionAuth.StoreExtensionPairingService(store, { now: () => now });
  try {
    for (let attempt = 0; attempt < EXPECTED_ATTEMPTS_PER_EXTENSION; attempt += 1) {
      exchangeError(service, "000000", "extension-reset");
    }
    assert.equal(exchangeError(service, "000000", "extension-reset").status, 429);

    now += EXPECTED_ATTEMPT_WINDOW_MS;
    assert.equal(exchangeError(service, "000000", "extension-reset").status, 400);
    assert.equal(exchangeError(service, "000000", "extension-new-origin").status, 400);
  } finally {
    store.close();
  }
});

test("invalid and expired pairing codes keep the same generic response", () => {
  const store = new Store(":memory:");
  let now = 50_000;
  const service = new extensionAuth.StoreExtensionPairingService(store, { now: () => now });
  try {
    const { code } = service.createCode();
    const invalid = exchangeError(service, "not-the-code", "extension-generic");
    now += EXPECTED_PAIR_CODE_TTL_MS;
    const expired = exchangeError(service, code, "extension-generic");
    assert.deepEqual(expired, invalid);
  } finally {
    store.close();
  }
});
