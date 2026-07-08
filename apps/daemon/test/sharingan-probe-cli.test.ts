import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { writeProbeCli, probeCliScript } from "../src/sharingan-probe-cli.ts";

test("probeCliScript bakes the base URL in but keeps the un-baked guard", () => {
  const s = probeCliScript("http://127.0.0.1:7457/api/sharingan/abc");
  assert.match(s, /const BASE = "http:\/\/127\.0\.0\.1:7457\/api\/sharingan\/abc"/, "base is baked into the const");
  assert.match(s, /BASE === "__BASE__"/, "the un-baked guard is preserved");
  assert.match(s, /case "navigate"/, "has the navigate command");
  assert.match(s, /function outline/, "has the outline command");
  assert.match(s, /function renderMap/, "has the render-map command");
});

test("writeProbeCli writes a runnable .sharingan/probe.mjs — help + outline of a captured dom.json", () => {
  const dir = mkdtempSync(join(tmpdir(), "probe-"));
  const rel = writeProbeCli(dir, "http://127.0.0.1:9999/api/sharingan/x");
  assert.equal(rel, ".sharingan/probe.mjs");
  const probe = join(dir, ".sharingan", "probe.mjs");
  // help works without a live run
  const help = execFileSync("node", [probe, "help"], { encoding: "utf8" });
  assert.match(help, /dezin-probe/);
  assert.match(help, /outline \[dom.json\]/);
  assert.match(help, /render-map \[render-map.json\]/);
  // outline condenses a captured nested dom.json into a compact indented tree
  const domPath = join(dir, ".sharingan", "dom.json");
  writeFileSync(domPath, JSON.stringify([{ tag: "body", classes: "", text: "", box: { x: 0, y: 0, w: 1440, h: 900 }, style: { display: "flex", flexDirection: "column", gap: "16px" }, children: [
    { tag: "h1", classes: "hero title", text: "Today", box: { x: 0, y: 0, w: 400, h: 48 }, style: { fontSize: "40px", fontWeight: "700", color: "rgb(255, 255, 255)" }, children: [] },
  ] }]));
  const out = execFileSync("node", [probe, "outline", domPath], { encoding: "utf8" });
  assert.match(out, /^body \[1440x900\] \{flex-col gap:16px\}/m, "root line has tag + box + style summary");
  assert.match(out, /^ {2}h1\.hero\.title \[400x48\] \{fg:rgb\(255,255,255\) fs:40px\/700\} "Today"/m, "child shows class + box + styles + text (so the raw dom.json isn't needed)");
});

test("probe render-map prints browser-measured layout rows from a captured render-map.json", () => {
  const dir = mkdtempSync(join(tmpdir(), "probe-render-map-"));
  const rel = writeProbeCli(dir, "http://127.0.0.1:9999/api/sharingan/x");
  assert.equal(rel, ".sharingan/probe.mjs");
  const probe = join(dir, ".sharingan", "probe.mjs");
  const mapPath = join(dir, ".sharingan", "render-map.json");
  writeFileSync(mapPath, JSON.stringify({
    viewport: { width: 1440, height: 900 },
    document: { width: 1440, height: 1600 },
    elements: [
      { selector: "h1.hero", tag: "h1", text: "Today", box: { x: 80, y: 120, w: 520, h: 72 }, style: { fontSize: "64px", fontWeight: "700", color: "rgb(17, 17, 17)" } },
      { selector: "img.logo", tag: "img", text: "", box: { x: 80, y: 32, w: 120, h: 40 }, style: {} },
    ],
  }));
  const out = execFileSync("node", [probe, "render-map", mapPath], { encoding: "utf8" });
  assert.match(out, /^viewport 1440x900 document 1440x1600$/m);
  assert.match(out, /^h1\.hero h1 \[80,120 520x72\] fs:64px\/700 fg:rgb\(17,17,17\) "Today"$/m);
  assert.match(out, /^img\.logo img \[80,32 120x40\]$/m);
});
