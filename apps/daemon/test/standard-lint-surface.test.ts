import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectStandardLintSurface } from "../src/run-handler.ts";

test("Standard lint surface includes JSON media data while excluding dependency trees", async () => {
  const root = mkdtempSync(join(tmpdir(), "dezin-lint-surface-"));
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, "node_modules", "pkg"), { recursive: true });
  writeFileSync(join(root, "src", "content.json"), JSON.stringify({ hero: { src: "https://cdn.example.test/hero" } }));
  writeFileSync(join(root, "node_modules", "pkg", "content.json"), JSON.stringify({ src: "https://dependency.example.test/image" }));

  const surface = await collectStandardLintSurface(root);
  assert.match(surface, /src\/content\.json/);
  assert.match(surface, /cdn\.example\.test/);
  assert.doesNotMatch(surface, /dependency\.example\.test/);
});
