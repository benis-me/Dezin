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
  // outline condenses a captured nested dom.json into a compact indented tree
  const domPath = join(dir, ".sharingan", "dom.json");
  writeFileSync(domPath, JSON.stringify([{ tag: "body", classes: "", text: "", box: { x: 0, y: 0, w: 1440, h: 900 }, children: [
    { tag: "h1", classes: "hero title", text: "Today", box: { x: 0, y: 0, w: 400, h: 48 }, children: [] },
  ] }]));
  const out = execFileSync("node", [probe, "outline", domPath], { encoding: "utf8" });
  assert.match(out, /^body \[1440x900\]/m, "root line has tag + box");
  assert.match(out, /^ {2}h1\.hero\.title \[400x48\] "Today"/m, "child is indented with class + box + text");
});
