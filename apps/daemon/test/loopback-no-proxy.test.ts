import { test } from "node:test";
import assert from "node:assert/strict";
import { ensureLoopbackBypassesEnvProxy } from "../src/loopback-no-proxy.ts";

test("loopback hosts are appended to NO_PROXY exactly once and mirrored to no_proxy", () => {
  const env: NodeJS.ProcessEnv = { NO_PROXY: "example.internal, 10.0.0.0/8" };
  const merged = ensureLoopbackBypassesEnvProxy(env);
  assert.equal(merged, "example.internal,10.0.0.0/8,127.0.0.1,localhost,::1");
  assert.equal(env.NO_PROXY, merged);
  assert.equal(env.no_proxy, merged);
  // Idempotent: a second call does not duplicate entries.
  assert.equal(ensureLoopbackBypassesEnvProxy(env), merged);

  const empty: NodeJS.ProcessEnv = {};
  assert.equal(ensureLoopbackBypassesEnvProxy(empty), "127.0.0.1,localhost,::1");

  const lower: NodeJS.ProcessEnv = { no_proxy: "localhost" };
  assert.equal(ensureLoopbackBypassesEnvProxy(lower), "localhost,127.0.0.1,::1");
});
