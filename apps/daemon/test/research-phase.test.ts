import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runResearchPhase } from "../src/research-phase.ts";
import { reportPath, visualReportPath, visualAssetsDir } from "../../../packages/research/src/index.ts";

test("runResearchPhase runs product + visual in parallel and tags activities by track", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dezin-rp-"));
  const seen: Array<{ track: string; kind: string }> = [];
  const spawn = async (_cmd: string, args: string[], cwd: string, opts: any) => {
    const isVisual = args.join(" ").includes("Visual Research");
    if (isVisual) {
      mkdirSync(visualAssetsDir(cwd), { recursive: true });
      writeFileSync(visualReportPath(cwd), "# Visual");
      opts.onActivity?.({ kind: "search", text: "dribbble" });
    } else {
      writeFileSync(reportPath(cwd), "# Product");
      opts.onActivity?.({ kind: "search", text: "competitors" });
    }
    return { code: 0, stderr: "" };
  };
  const result = await runResearchPhase(
    { dir, brief: "a hero", agentCommand: "claude", onActivity: (a) => seen.push({ track: a.track, kind: a.kind }) },
    spawn,
  );
  assert.equal(result.produced, true);
  assert.equal(result.visualProduced, true);
  assert.ok(seen.some((a) => a.track === "product"));
  assert.ok(seen.some((a) => a.track === "visual"));
});
