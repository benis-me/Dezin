import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { immutableProbeCliScript } from "../src/sharingan-probe-cli.ts";

function writeImmutableProbe(): { dir: string; probe: string } {
  const dir = mkdtempSync(join(tmpdir(), "probe-immutable-"));
  const sharingan = join(dir, ".sharingan");
  mkdirSync(sharingan, { recursive: true });
  const probe = join(sharingan, "probe.mjs");
  writeFileSync(probe, immutableProbeCliScript());
  return { dir, probe };
}

test("immutable probe contains only offline capture readers", () => {
  const script = immutableProbeCliScript();
  assert.doesNotMatch(script, /__BASE__|__RUN_ID__|DEZIN_DAEMON_TOKEN|\bfetch\s*\(/);
  assert.doesNotMatch(script, /case\s+["'](?:navigate|read-dom|styles|links|click|scroll|capture)["']/);
  assert.match(script, /source-summary/);
  assert.match(script, /source-scaffold --stdout/);
  assert.match(script, /outline \[dom\.json\]/);
  assert.match(script, /render-map \[render-map\.json\]/);
});

test("immutable probe rejects mutable commands before touching capture files", () => {
  const { dir, probe } = writeImmutableProbe();
  const pages = join(dir, ".sharingan", "pages.json");
  writeFileSync(pages, "{\"pages\":[]}\n");
  const before = readFileSync(pages);

  const result = spawnSync(process.execPath, [probe, "navigate", "https://example.test"], {
    cwd: dir,
    encoding: "utf8",
    timeout: 2_000,
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /allows only offline/i);
  assert.deepEqual(readFileSync(pages), before);
});

test("immutable probe can read a captured DOM outline offline", () => {
  const { dir, probe } = writeImmutableProbe();
  const dom = join(dir, ".sharingan", "dom.json");
  writeFileSync(dom, JSON.stringify([{
    tag: "body",
    classes: "",
    text: "",
    box: { x: 0, y: 0, w: 1440, h: 900 },
    style: { display: "flex", flexDirection: "column", gap: "16px" },
    children: [{
      tag: "h1",
      classes: "hero title",
      text: "Today",
      box: { x: 0, y: 0, w: 400, h: 48 },
      style: { fontSize: "40px", fontWeight: "700", color: "rgb(255, 255, 255)" },
      children: [],
    }],
  }]));

  const result = spawnSync(process.execPath, [probe, "outline", dom], {
    cwd: dir,
    encoding: "utf8",
    timeout: 2_000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^body \[1440x900\] \{flex-col gap:16px\}/m);
  assert.match(result.stdout, /^ {2}h1\.hero\.title \[400x48\].*"Today"/m);
});
