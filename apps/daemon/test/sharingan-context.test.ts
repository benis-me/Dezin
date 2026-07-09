import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSharinganContext, buildSharinganSystemPrompt } from "../src/sharingan-context.ts";

test("buildSharinganContext points the agent at the dezin-probe CLI (not hand-written curl), with budget", () => {
  const { promptBlock } = buildSharinganContext({ sourceUrl: "https://example.com", budget: 6, capturedCount: 1 });
  assert.match(promptBlock, /example\.com/);
  assert.match(promptBlock, /\.sharingan\/probe\.mjs/); // the dedicated CLI tool
  assert.match(promptBlock, /probe\.mjs source-summary/); // bounded digest first
  assert.match(promptBlock, /probe\.mjs source-scaffold/); // measured reference before implementation
  assert.match(promptBlock, /probe\.mjs navigate/); // how to navigate
  assert.match(promptBlock, /probe\.mjs capture/); // how to capture
  assert.match(promptBlock, /probe\.mjs outline/); // condensed capture view (instead of parsing dom.json)
  assert.match(promptBlock, /do NOT hand-write curl\/fetch\/python/i); // don't improvise scripts
  assert.match(promptBlock, /\b6\b/); // budget
});

test("buildSharinganContext tells the agent to inventory assets and fill every image slot", () => {
  const { promptBlock } = buildSharinganContext({ sourceUrl: "https://example.com", budget: 6, capturedCount: 1 });
  assert.match(promptBlock, /assets\.json/); // read the image inventory
  assert.match(promptBlock, /image slot|placeholder image/i); // fill empty image slots
  assert.match(promptBlock, /match|reproduce/i); // match the source structure
});

test("buildSharinganContext directs a faithful 1:1 reproduction using the nested tree, exact palette, and cached local images", () => {
  const { promptBlock } = buildSharinganContext({ sourceUrl: "https://example.com", budget: 6, capturedCount: 1 });
  assert.match(promptBlock, /faithful|reproduce|1:1|1 ?: ?1/i); // reproduce, not reconstruct
  assert.match(promptBlock, /\/_assets\//); // use the cached local images
  assert.match(promptBlock, /styles\.json|palette/i); // match the exact captured palette
  assert.match(promptBlock, /dom\.json/); // mirror the captured tree
  assert.ok(!/NOT a byte-for-byte copy/i.test(promptBlock), "the old reconstruct-not-copy framing is gone");
  assert.ok(!/placeholder/i.test(promptBlock) || /_assets/.test(promptBlock), "no longer instructs placeholder-only images");
});

test("the prompt steers away from drowning in dom.json — outline is the blueprint, build fast", () => {
  const { promptBlock } = buildSharinganContext({ sourceUrl: "https://example.com", budget: 6, capturedCount: 1 });
  assert.match(promptBlock, /outline/i);
  assert.match(promptBlock, /BLUEPRINT/i); // outline is the blueprint, not the raw dom.json
  assert.match(promptBlock, /do NOT cat \/ load \/ parse it with node\/python\/jq/i); // forbid wholesale dom.json parsing
  assert.match(promptBlock, /reference scaffold/i); // scaffold is source material, not the final app
  assert.match(promptBlock, /implement the Standard project/i);
  assert.doesNotMatch(promptBlock, /preserve the generated `SOURCE` scaffold, run the build, and stop/i);
});

test("buildSharinganContext makes render-map.json the measured source for 1:1 layout", () => {
  const { promptBlock } = buildSharinganContext({ sourceUrl: "https://example.com", budget: 6, capturedCount: 1 });
  assert.match(promptBlock, /render-map\.json/);
  assert.match(promptBlock, /bounding boxes|browser-measured|measured/i);
  assert.match(promptBlock, /screenshot diff|visual regression|source-vs-result/i);
  assert.match(promptBlock, /local patches|do not redesign|do not re-layout the whole page/i);
});

test("buildSharinganContext locks the agent to captured content and forbids invented surfaces", () => {
  const { promptBlock } = buildSharinganContext({ sourceUrl: "https://example.com", budget: 6, capturedCount: 1 });
  assert.match(promptBlock, /LOCKED SOURCE CONTRACT/i);
  assert.match(promptBlock, /do not add|do not create/i);
  assert.match(promptBlock, /page|tab|screen|section/i);
  assert.match(promptBlock, /not present in the capture/i);
  assert.match(promptBlock, /no external fallback/i);
  assert.match(promptBlock, /unsplash|placeholder CDN|stock/i);
  assert.match(promptBlock, /ambient canvas|particles|hover-only overlays|simulated likes/i);
  assert.match(promptBlock, /Do not enter Plan Mode|write plan files/i);
  assert.match(promptBlock, /fidelity beats taste/i);
});

test("buildSharinganContext caps source analysis before writing source-derived components", () => {
  const { promptBlock } = buildSharinganContext({ sourceUrl: "https://example.com", budget: 6, capturedCount: 1 });
  assert.match(promptBlock, /ANALYSIS BUDGET/i);
  assert.match(promptBlock, /at most 3/i);
  assert.match(promptBlock, /inspection command/i);
  assert.match(promptBlock, /must use the generated reference scaffold/i);
  assert.match(promptBlock, /region-plan\.json/i);
  assert.match(promptBlock, /Source Component Inventory/i);
  assert.match(promptBlock, /measured reference scaffold/i);
  assert.match(promptBlock, /generate normal Standard React source/i);
  assert.match(promptBlock, /const SOURCE =/i);
  assert.match(promptBlock, /SOURCE\.boxes.*SOURCE\.images.*SOURCE\.texts/i);
  assert.match(promptBlock, /do not hunt for hidden/i);
  assert.match(promptBlock, /source-summary/i);
  assert.match(promptBlock, /source-scaffold/i);
  assert.match(promptBlock, /Banned during the first build pass/i);
  assert.match(promptBlock, /do NOT Glob\/Read\/List\/Search `.sharingan\/`/i);
  assert.match(promptBlock, /do not leave the scaffold replay as the final app/i);
  assert.doesNotMatch(promptBlock, /Do not create `src\/components\/` during the first build pass/i);
  assert.match(promptBlock, /Never add canvas particles|simulated social stats/i);
});

test("buildSharinganSystemPrompt bypasses normal Standard design generation behavior", () => {
  const prompt = buildSharinganSystemPrompt();
  assert.match(prompt, /Sharingan Capture Replayer/i);
  assert.match(prompt, /not a design-generation task/i);
  assert.match(prompt, /reference scaffold/i);
  assert.match(prompt, /region-plan\.json/i);
  assert.match(prompt, /src\/sharingan-regions/i);
  assert.match(prompt, /real Standard project/i);
  assert.match(prompt, /scaffold is not the final artifact/i);
  assert.match(prompt, /Ignore any generic Standard\/design-system\/craft instruction/i);
  assert.match(prompt, /Do not submit the generated SOURCE replay unchanged/i);
  assert.match(prompt, /Do not run `help`, `git status`, `ls`, `find`, `tree`/i);
  assert.doesNotMatch(prompt, /SOURCE object is canonical/i);
  assert.doesNotMatch(prompt, /Active design system/i);
});
