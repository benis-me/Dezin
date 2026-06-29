import { test } from "node:test";
import assert from "node:assert/strict";
import { buildBrandSystem, slugifyBrand, isHexColor } from "../src/index.ts";

test("slugifyBrand makes safe ids", () => {
  assert.equal(slugifyBrand("Acme Corp!"), "acme-corp");
  assert.equal(slugifyBrand("  "), "brand");
});

test("isHexColor accepts 3/6-digit hex with or without #", () => {
  assert.ok(isHexColor("#2563eb"));
  assert.ok(isHexColor("abc"));
  assert.ok(!isHexColor("blue"));
});

test("buildBrandSystem produces a valid 9-section system with the accent + fonts", () => {
  const b = buildBrandSystem({ name: "Acme", accent: "ff5a1f", displayFont: "Cabinet Grotesk", vibe: "Bold and warm." });
  assert.equal(b.id, "acme");
  assert.equal(b.name, "Acme");
  // accent normalized + bound in :root
  assert.ok(b.tokensCss.includes("--accent: #ff5a1f;"));
  assert.ok(b.tokensCss.includes('--font-display: "Cabinet Grotesk"'));
  // body font defaults to the display font when omitted
  assert.ok(b.tokensCss.includes('--font-body: "Cabinet Grotesk"'));
  // exactly 9 numbered sections (matches the loader's section assertion)
  const sections = b.designMd.match(/^##\s+\d+\./gm) ?? [];
  assert.equal(sections.length, 9, `got ${sections.length} sections`);
  assert.ok(b.designMd.includes("Bold and warm."));
  assert.equal(typeof b.manifest.name, "string");
});

test("buildBrandSystem picks a readable accent foreground", () => {
  const light = buildBrandSystem({ name: "Lemon", accent: "#ffe600" }); // bright → dark text
  assert.ok(light.tokensCss.includes("--accent-fg: #0a0a0a;"));
  const dark = buildBrandSystem({ name: "Navy", accent: "#1e3a8a" }); // dark → white text
  assert.ok(dark.tokensCss.includes("--accent-fg: #ffffff;"));
});
