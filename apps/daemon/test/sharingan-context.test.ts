import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSharinganContext } from "../src/sharingan-context.ts";

test("buildSharinganContext lists the probe endpoints, budget, and auth", () => {
  const { promptBlock } = buildSharinganContext({ projectId: "p1", sourceUrl: "https://example.com", origin: "http://127.0.0.1:8787", budget: 6, capturedCount: 1 });
  assert.match(promptBlock, /example\.com/);
  assert.match(promptBlock, /\/api\/sharingan\/[^/]*\/capture/);         // tells the agent how to capture
  assert.match(promptBlock, /\/navigate/);
  assert.match(promptBlock, /x-dezin-daemon-token/);                      // auth
  assert.match(promptBlock, /DEZIN_DAEMON_TOKEN/);
  assert.match(promptBlock, /6/);                                          // budget
});

test("buildSharinganContext tells the agent to inventory assets and fill every image slot", () => {
  const { promptBlock } = buildSharinganContext({ projectId: "p1", sourceUrl: "https://example.com", origin: "http://127.0.0.1:8787", budget: 6, capturedCount: 1 });
  assert.match(promptBlock, /assets\.json/);                         // read the image inventory
  assert.match(promptBlock, /image slot|placeholder image/i);         // fill empty image slots
  assert.match(promptBlock, /match|reproduce/i);                      // match the source structure
});

test("buildSharinganContext directs a faithful 1:1 reproduction using the nested tree, exact palette, and cached local images", () => {
  const { promptBlock } = buildSharinganContext({ projectId: "p1", sourceUrl: "https://example.com", origin: "http://127.0.0.1:8787", budget: 6, capturedCount: 1 });
  assert.match(promptBlock, /faithful|reproduce|1:1|1 ?: ?1/i);       // reproduce, not reconstruct
  assert.match(promptBlock, /\/_assets\//);                            // use the cached local images
  assert.match(promptBlock, /styles\.json|palette/i);                  // match the exact captured palette
  assert.match(promptBlock, /dom\.json/);                              // mirror the captured tree
  assert.ok(!/NOT a byte-for-byte copy/i.test(promptBlock), "the old reconstruct-not-copy framing is gone");
  assert.ok(!/placeholder/i.test(promptBlock) || /_assets/.test(promptBlock), "no longer instructs placeholder-only images");
});
