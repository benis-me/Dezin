import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createProviderFetch,
  providerProxyUrlFromScutil,
  resolveProviderProxyUrl,
  shouldBypassProviderProxy,
} from "../src/provider-fetch.ts";

test("resolveProviderProxyUrl prefers explicit proxy environment variables", () => {
  assert.equal(
    resolveProviderProxyUrl({ HTTPS_PROXY: "http://127.0.0.1:6152" }, "linux", () => ""),
    "http://127.0.0.1:6152",
  );
  assert.equal(
    resolveProviderProxyUrl({ ALL_PROXY: "socks5://127.0.0.1:6153" }, "linux", () => ""),
    "socks5://127.0.0.1:6153",
  );
});

test("resolveProviderProxyUrl reads the macOS HTTPS proxy when env vars are not set", () => {
  const scutil = `
<dictionary> {
  HTTPEnable : 1
  HTTPPort : 6152
  HTTPProxy : 127.0.0.1
  HTTPSEnable : 1
  HTTPSPort : 6152
  HTTPSProxy : 127.0.0.1
}`;
  assert.equal(providerProxyUrlFromScutil(scutil), "http://127.0.0.1:6152");
  assert.equal(resolveProviderProxyUrl({}, "darwin", () => scutil), "http://127.0.0.1:6152");
});

test("shouldBypassProviderProxy keeps local endpoints direct", () => {
  assert.equal(shouldBypassProviderProxy("http://127.0.0.1:11434/v1/models"), true);
  assert.equal(shouldBypassProviderProxy("http://localhost:11434/v1/models"), true);
  assert.equal(shouldBypassProviderProxy("https://generativelanguage.googleapis.com/v1beta/models"), false);
});

test("createProviderFetch injects a proxy dispatcher for external provider requests", async () => {
  const calls: RequestInit[] = [];
  const baseFetch = (async (_input, init) => {
    calls.push(init ?? {});
    return new Response("{}", { status: 200 });
  }) as typeof fetch;

  const providerFetch = createProviderFetch(baseFetch, () => "http://127.0.0.1:6152");
  await providerFetch("https://generativelanguage.googleapis.com/v1beta/models");

  assert.ok((calls[0] as RequestInit & { dispatcher?: unknown }).dispatcher);
});

test("createProviderFetch does not proxy local provider requests", async () => {
  const calls: RequestInit[] = [];
  const baseFetch = (async (_input, init) => {
    calls.push(init ?? {});
    return new Response("{}", { status: 200 });
  }) as typeof fetch;

  const providerFetch = createProviderFetch(baseFetch, () => "http://127.0.0.1:6152");
  await providerFetch("http://127.0.0.1:11434/v1/models");

  assert.equal((calls[0] as RequestInit & { dispatcher?: unknown }).dispatcher, undefined);
});
