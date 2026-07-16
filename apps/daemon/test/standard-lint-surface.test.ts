import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  collectStandardLintSurface,
  StandardLintSurfaceError,
} from "../src/standard-lint-surface.ts";

test("Standard lint surface includes JSON media data while excluding dependency trees", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "dezin-lint-surface-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, "node_modules", "pkg"), { recursive: true });
  writeFileSync(join(root, "src", "content.json"), JSON.stringify({ hero: { src: "https://cdn.example.test/hero" } }));
  writeFileSync(join(root, "node_modules", "pkg", "content.json"), JSON.stringify({ src: "https://dependency.example.test/image" }));

  const surface = await collectStandardLintSurface(root);
  assert.match(surface, /src\/content\.json/);
  assert.match(surface, /cdn\.example\.test/);
  assert.doesNotMatch(surface, /dependency\.example\.test/);
});

test("Standard lint surface fails closed instead of truncating later files or UTF-8 bytes", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "dezin-lint-surface-budget-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "a.ts"), "const first = 'ééé';\n");
  writeFileSync(join(root, "z.ts"), "const hiddenDefect = true;\n");

  await assert.rejects(
    collectStandardLintSurface(root, 64),
    (error: unknown) => error instanceof StandardLintSurfaceError
      && /byte|budget/i.test(error.message),
  );
});

test("Standard lint surface rejects malformed UTF-8 instead of omitting the source", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "dezin-lint-surface-utf8-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "broken.ts"), Buffer.from([0xc3, 0x28]));

  await assert.rejects(
    collectStandardLintSurface(root),
    (error: unknown) => error instanceof StandardLintSurfaceError
      && /UTF-8/.test(error.message),
  );
});
