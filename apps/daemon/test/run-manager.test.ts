import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRun, finishRun, pushEvent, readRunLog, subscribe } from "../src/run-manager.ts";

test("subscribe attaches live listener before replay so reattach cannot miss events", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "dezin-run-manager-"));
  createRun({ runId: "r-race", conversationId: "c1", dataDir });
  pushEvent("r-race", { type: "first", runId: "r-race" });

  const seen: unknown[] = [];
  const unsubscribe = subscribe(
    "r-race",
    dataDir,
    (event) => {
      seen.push(event);
      if (seen.length === 1) pushEvent("r-race", { type: "second", runId: "r-race" });
    },
    () => {},
  );
  unsubscribe();

  assert.deepEqual(
    seen.map((event) => (event as { type?: string }).type),
    ["first", "second"],
  );
});

test("subscribe can replay only events after a cursor", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "dezin-run-manager-"));
  createRun({ runId: "r-cursor", conversationId: "c1", dataDir });
  pushEvent("r-cursor", { type: "first", runId: "r-cursor" });
  pushEvent("r-cursor", { type: "second", runId: "r-cursor" });

  const seen: unknown[] = [];
  const unsubscribe = subscribe("r-cursor", dataDir, (event) => seen.push(event), () => {}, { afterSeq: 1 });
  unsubscribe();

  assert.deepEqual(
    seen.map((event) => ({ type: (event as { type?: string }).type, seq: (event as { seq?: number }).seq })),
    [{ type: "second", seq: 2 }],
  );
});

test("finished run logs persist sequence numbers for restart reattach cursors", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "dezin-run-manager-"));
  createRun({ runId: "r-log", conversationId: "c1", dataDir });
  pushEvent("r-log", { type: "first", runId: "r-log" });
  pushEvent("r-log", { type: "second", runId: "r-log" });
  finishRun("r-log");
  // Poll for the async log flush rather than a fixed 20ms sleep — under load the sleep lost the
  // race and this test flaked intermittently (#108).
  const logPath = join(dataDir, ".runs", "r-log.jsonl");
  const started = Date.now();
  let log = "";
  while (Date.now() - started < 3000) {
    try {
      log = readFileSync(logPath, "utf8");
    } catch {
      log = "";
    }
    if (/"seq":1/.test(log) && /"seq":2/.test(log)) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.match(log, /"seq":1/);
  assert.match(log, /"seq":2/);

  const seen: unknown[] = [];
  subscribe("r-log", dataDir, (event) => seen.push(event), () => {}, { afterSeq: 1 });
  assert.deepEqual(readRunLog(join(dataDir, ".runs", "r-log.jsonl")).map((event) => (event as { seq?: number }).seq), [1, 2]);
  assert.deepEqual(seen.map((event) => (event as { type?: string }).type), ["second"]);
});
