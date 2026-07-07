import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSharinganContext } from "../src/sharingan-context.ts";

test("buildSharinganContext lists the probe endpoints, budget, and guardrails", () => {
  const { promptBlock } = buildSharinganContext({ projectId: "p1", sourceUrl: "https://example.com", origin: "http://127.0.0.1:8787", budget: 6, capturedCount: 1 });
  assert.match(promptBlock, /example\.com/);
  assert.match(promptBlock, /\/api\/sharingan\/[^/]*\/capture/);         // tells the agent how to capture
  assert.match(promptBlock, /\/navigate/);
  assert.match(promptBlock, /x-dezin-daemon-token/);                      // auth
  assert.match(promptBlock, /DEZIN_DAEMON_TOKEN/);
  assert.match(promptBlock, /6/);                                          // budget
  assert.match(promptBlock, /reconstruct/i);                              // guardrail: reconstruct not rip
  assert.match(promptBlock, /placeholder/i);                              // guardrail: brand assets as placeholders
});

test("buildSharinganContext tells the agent to inventory assets and fill image slots with free placeholders", () => {
  const { promptBlock } = buildSharinganContext({ projectId: "p1", sourceUrl: "https://example.com", origin: "http://127.0.0.1:8787", budget: 6, capturedCount: 1 });
  assert.match(promptBlock, /assets\.json/);                         // read the image inventory
  assert.match(promptBlock, /picsum\.photos|placehold\.co|unsplash/i); // a free placeholder source
  assert.match(promptBlock, /image slot|placeholder image/i);         // fill empty image slots
  assert.match(promptBlock, /match|reproduce/i);                      // match the source structure
});
