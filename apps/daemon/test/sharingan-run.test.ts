import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { Store } from "../../../packages/core/src/index.ts";
import type { AgentRunner, AgentTurnInput } from "../../../packages/agent/src/index.ts";
import { createApp } from "../src/index.ts";
import { findChrome } from "../src/capture-cover.ts";
import { projectDir } from "../src/serve-static.ts";
import { closeAllSharinganSessions } from "../src/sharingan-handler.ts";
import {
  runSharinganRegionSubagents,
  sharinganRegionsForSubagents,
} from "../src/sharingan-region-runner.ts";
import { writeProbeCli } from "../src/sharingan-probe-cli.ts";

test("Sharingan region preparation keeps source order while normalizing duplicate ids", () => {
  const regions = sharinganRegionsForSubagents({
    regions: [
      { id: "Hero Banner", label: "Hero", texts: ["One", "One", "Two"] },
      { id: "Hero Banner", label: "Details", assets: ["/_assets/a.png"] },
    ],
  });

  assert.deepEqual(
    regions.map((region) => ({ id: region.id, label: region.label })),
    [
      { id: "hero-banner", label: "Hero" },
      { id: "hero-banner-2", label: "Details" },
    ],
  );
  assert.deepEqual(regions[0]?.texts, ["One", "Two"]);
});

test("Sharingan region preparation spends its bounded budget across the full source page", () => {
  const sourceRegions = Array.from({ length: 18 }, (_, index) => ({
    id: `region-${index}`,
    label: index === 17 ? "Footer CTA" : `Section ${index}`,
    bbox: { x: 0, y: index * 240, w: 1200, h: 180 },
    counts: index === 10
      ? { boxes: 2, images: 4, vectors: 1, texts: 3 }
      : { boxes: 1, images: 0, vectors: 0, texts: 1 },
    texts: [index === 17 ? "Footer CTA" : `Section ${index}`],
    assets: index === 10 ? ["/_assets/critical-card.png"] : [],
    media: index === 10 ? [{ src: "/_assets/critical-card.png" }] : [],
  }));

  const regions = sharinganRegionsForSubagents({
    regionBudget: 99,
    document: { width: 1200, height: 4260 },
    regions: sourceRegions,
  });
  const selectedIndexes = regions.map((region) => Number(region.id.replace("region-", "")));

  assert.equal(regions.length, 8, "the agent fan-out remains bounded");
  assert.equal(regions[0]?.id, "region-0", "the page opening is always represented");
  assert.equal(regions.at(-1)?.id, "region-17", "the page ending cannot be dropped by a top-biased slice");
  assert.ok(regions.some((region) => region.id === "region-10"), "the strongest measured region in its page segment survives");
  assert.ok(
    selectedIndexes.every((index, position) => position === 0 || index > selectedIndexes[position - 1]!),
    "selected regions stay in source order for main integration",
  );
  assert.ok(
    selectedIndexes.slice(1).every((index, position) => index - selectedIndexes[position]! <= 3),
    `the selection must cover the full page without a large content gap: ${selectedIndexes.join(", ")}`,
  );
});

test("Sharingan region preparation covers sparse lower-page regions when source detail is clustered near the top", () => {
  const topRegions = Array.from({ length: 12 }, (_, index) => ({
    id: `top-${index + 1}`,
    label: `Top detail ${index + 1}`,
    bbox: { x: 0, y: 80 + index * 90, w: 1200, h: 70 },
    counts: index === 11
      ? { boxes: 20, images: 12, vectors: 8, texts: 20 }
      : { boxes: 1, images: 0, vectors: 0, texts: 1 },
  }));
  const regions = sharinganRegionsForSubagents({
    document: { width: 1200, height: 12_000 },
    regions: [
      { id: "opening", label: "Opening", bbox: { x: 0, y: 0, w: 1200, h: 60 } },
      ...topRegions,
      { id: "middle-story", label: "Middle story", bbox: { x: 0, y: 5_200, w: 1200, h: 240 } },
      { id: "lower-proof", label: "Lower proof", bbox: { x: 0, y: 9_100, w: 1200, h: 240 } },
      { id: "footer", label: "Footer", bbox: { x: 0, y: 11_800, w: 1200, h: 180 } },
    ],
  });

  assert.equal(regions.length, 8);
  assert.equal(regions[0]?.id, "opening");
  assert.equal(regions.at(-1)?.id, "footer");
  assert.ok(regions.some((region) => region.id === "middle-story"), "the middle document band must be represented");
  assert.ok(regions.some((region) => region.id === "lower-proof"), "the lower document band must be represented");
  assert.deepEqual(
    [...regions].sort((left, right) =>
      (left.bbox?.y ?? Number.MAX_SAFE_INTEGER) - (right.bbox?.y ?? Number.MAX_SAFE_INTEGER)),
    regions,
    "geometric sampling must preserve source order for integration",
  );
});

function parseSse(text: string): Array<Record<string, unknown>> {
  return text
    .split("\n\n")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((b) => JSON.parse(b.replace(/^data:\s?/, "")) as Record<string, unknown>);
}

/** Records every turn input it receives, and writes a real file into the project
 *  dir + commits nothing itself — run-handler's own gitCommit() picks up the
 *  change — so the standard-mode build loop sees "files changed" and succeeds. */
class RecordingRunner implements AgentRunner {
  readonly id = "recording";
  calls: AgentTurnInput[] = [];
  async runTurn(input: AgentTurnInput) {
    this.calls.push(input);
    const regionId = input.message.match(/Region ID:\s*([a-z0-9_-]+)/i)?.[1];
    if (regionId) {
      mkdirSync(join(input.projectDir, "src", "sharingan-regions"), { recursive: true });
      writeFileSync(
        join(input.projectDir, "src", "sharingan-regions", `${regionId}.jsx`),
        `export default function Region(){ return <section>${regionId}</section> }`,
      );
      return { text: `built ${regionId}`, artifactHtml: "", artifactPath: "index.html" };
    }
    writeFileSync(join(input.projectDir, "src", "App.jsx"), "export default function App(){ return <main>Cloned</main> }");
    return { text: "done", artifactHtml: "", artifactPath: "index.html" };
  }
  get lastMessage(): string {
    return this.calls.at(-1)?.message ?? "";
  }
}

test("Sharingan region execution replaces an identity-less v2 plan from the pinned capture without mutating it", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "dezin-sharingan-legacy-region-plan-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sharinganDir = join(root, ".sharingan");
  const pageDir = join(sharinganDir, "home");
  mkdirSync(pageDir, { recursive: true });
  mkdirSync(join(root, "src"), { recursive: true });
  writeProbeCli(root, "http://127.0.0.1:9999/api/sharingan/legacy");

  const sourceUrl = "https://example.test/legacy-long-page";
  const renderMapRelative = ".sharingan/home/render-map.json";
  const assetsRelative = ".sharingan/home/assets.json";
  const elements = [
    ...Array.from({ length: 12 }, (_, index) => ({
      selector: `section.top-${index} h2`,
      tag: "h2",
      text: index === 0 ? "Opening" : `Top detail ${index}`,
      box: { x: 80, y: index * 200 + 20, w: 560, h: 48 },
      style: { fontSize: "32px", fontWeight: "700", color: "rgb(20, 20, 20)" },
    })),
    {
      selector: "section.middle-story h2",
      tag: "h2",
      text: "Middle story",
      box: { x: 80, y: 5_200, w: 560, h: 48 },
      style: { fontSize: "32px", fontWeight: "700", color: "rgb(20, 20, 20)" },
    },
    {
      selector: "section.lower-proof h2",
      tag: "h2",
      text: "Lower proof",
      box: { x: 80, y: 9_100, w: 560, h: 48 },
      style: { fontSize: "32px", fontWeight: "700", color: "rgb(20, 20, 20)" },
    },
    {
      selector: "footer.cta",
      tag: "footer",
      text: "Footer CTA",
      box: { x: 80, y: 11_800, w: 560, h: 48 },
      style: { fontSize: "32px", fontWeight: "700", color: "rgb(20, 20, 20)" },
    },
  ];
  writeFileSync(join(sharinganDir, "pages.json"), JSON.stringify({
    sourceUrl,
    entryUrl: sourceUrl,
    pages: [{ url: sourceUrl, renderMap: renderMapRelative, assets: assetsRelative }],
  }));
  writeFileSync(join(root, assetsRelative), "[]");
  writeFileSync(join(root, renderMapRelative), JSON.stringify({
    viewport: { width: 1200, height: 800 },
    document: { width: 1200, height: 12_000 },
    elements,
  }));
  const regionPlanPath = join(sharinganDir, "region-plan.json");
  writeFileSync(regionPlanPath, JSON.stringify({
    protocol: "dezin.sharingan-region-plan.v2",
    version: 2,
    regionBudget: 8,
    candidateCount: 12,
    sourceUrl,
    viewport: { width: 1200, height: 800 },
    document: { width: 1200, height: 12_000 },
    regions: Array.from({ length: 8 }, (_, index) => ({
      id: `legacy-top-${index + 1}`,
      label: index === 0 ? "Opening" : `Legacy top ${index}`,
      bbox: { x: 0, y: index * 200, w: 1200, h: 180 },
      texts: [index === 0 ? "Opening" : `Top detail ${index}`],
    })),
  }, null, 2));
  const pinnedLegacyPlan = readFileSync(regionPlanPath);
  const runner = new RecordingRunner();

  const builds = await runSharinganRegionSubagents({
    runner,
    projectDir: root,
    runId: "legacy-plan-run",
    signal: new AbortController().signal,
    env: {},
    onActivity: () => {},
    emit: () => {},
  });

  assert.equal(builds.length, 8);
  assert.ok(builds.some((build) => build.label.includes("Middle story")));
  assert.ok(builds.some((build) => build.label.includes("Lower proof")));
  assert.ok(builds.at(-1)?.label.includes("Footer CTA"));
  assert.deepEqual(readFileSync(regionPlanPath), pinnedLegacyPlan, "the pinned legacy plan must stay byte-identical");
});

test("Sharingan region execution rejects a valid v2 plan after an interrupted same-variant raw-bundle replacement", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "dezin-sharingan-stale-v2-region-plan-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sharinganDir = join(root, ".sharingan");
  const pageDir = join(sharinganDir, "home");
  mkdirSync(pageDir, { recursive: true });
  mkdirSync(join(root, "src"), { recursive: true });
  writeProbeCli(root, "http://127.0.0.1:9999/api/sharingan/stale-v2");

  const sourceUrl = "https://example.test/changing-long-page";
  const renderMapRelative = ".sharingan/home/render-map.json";
  const assetsRelative = ".sharingan/home/assets.json";
  writeFileSync(join(sharinganDir, "pages.json"), JSON.stringify({
    sourceUrl,
    entryUrl: sourceUrl,
    pages: [{ url: sourceUrl, renderMap: renderMapRelative, assets: assetsRelative }],
  }));
  writeFileSync(join(root, assetsRelative), JSON.stringify([{ kind: "img", local: "/_assets/old.png" }]));
  writeFileSync(join(root, renderMapRelative), JSON.stringify({
    viewport: { width: 1200, height: 800 },
    document: { width: 1200, height: 12_000 },
    elements: [
      ...Array.from({ length: 12 }, (_, index) => ({
        selector: `section.old-${index} h2`,
        tag: "h2",
        text: index === 0 ? "Old opening" : `Old detail ${index}`,
        box: { x: 80, y: index * 200 + 20, w: 560, h: 48 },
        style: { fontSize: "32px", fontWeight: "700", color: "rgb(20, 20, 20)" },
      })),
      {
        selector: "footer.old",
        tag: "footer",
        text: "Old footer",
        box: { x: 80, y: 11_800, w: 560, h: 48 },
        style: { fontSize: "32px", fontWeight: "700", color: "rgb(20, 20, 20)" },
      },
    ],
  }));
  const probe = join(sharinganDir, "probe.mjs");
  execFileSync(process.execPath, [probe, "source-scaffold"], { cwd: root, encoding: "utf8" });
  const regionPlanPath = join(sharinganDir, "region-plan.json");
  const pinnedStalePlan = readFileSync(regionPlanPath);

  // Model the crash window (or an out-of-band bundle sync) in which the same variant's raw
  // evidence is replaced but the normal derived-artifact invalidation has not completed.
  writeFileSync(join(root, assetsRelative), JSON.stringify([{ kind: "img", local: "/_assets/new.png" }]));
  writeFileSync(join(root, renderMapRelative), JSON.stringify({
    viewport: { width: 1200, height: 800 },
    document: { width: 1200, height: 12_000 },
    elements: [
      ...Array.from({ length: 12 }, (_, index) => ({
        selector: `section.new-${index} h2`,
        tag: "h2",
        text: index === 0 ? "New opening" : `New detail ${index}`,
        box: { x: 80, y: index * 200 + 20, w: 560, h: 48 },
        style: { fontSize: "32px", fontWeight: "700", color: "rgb(20, 20, 20)" },
      })),
      {
        selector: "section.new-middle h2",
        tag: "h2",
        text: "New middle story",
        box: { x: 80, y: 5_200, w: 560, h: 48 },
        style: { fontSize: "32px", fontWeight: "700", color: "rgb(20, 20, 20)" },
      },
      {
        selector: "section.new-lower h2",
        tag: "h2",
        text: "New lower proof",
        box: { x: 80, y: 9_100, w: 560, h: 48 },
        style: { fontSize: "32px", fontWeight: "700", color: "rgb(20, 20, 20)" },
      },
      {
        selector: "footer.new",
        tag: "footer",
        text: "New footer CTA",
        box: { x: 80, y: 11_800, w: 560, h: 48 },
        style: { fontSize: "32px", fontWeight: "700", color: "rgb(20, 20, 20)" },
      },
    ],
  }));
  const runner = new RecordingRunner();

  const builds = await runSharinganRegionSubagents({
    runner,
    projectDir: root,
    runId: "stale-v2-plan-run",
    signal: new AbortController().signal,
    env: {},
    onActivity: () => {},
    emit: () => {},
  });

  assert.equal(builds.length, 8);
  assert.ok(builds.some((build) => build.label.includes("New middle story")));
  assert.ok(builds.some((build) => build.label.includes("New lower proof")));
  assert.ok(builds.at(-1)?.label.includes("New footer CTA"));
  assert.ok(!builds.some((build) => build.label.includes("Old footer")));
  assert.deepEqual(readFileSync(regionPlanPath), pinnedStalePlan, "the stale derived plan remains immutable while execution uses fresh raw capture evidence");
});

test("a sharingan run captures the site, injects the context, and skips research", { skip: !findChrome() && "no Chrome" }, async () => {
  // Local fixture standing in for the site being cloned.
  const fixture = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(`<!doctype html><title>Acme</title><h1>Acme</h1><p>${"w ".repeat(60)}</p>`);
  });
  await new Promise<void>((r) => fixture.listen(0, "127.0.0.1", r));
  const sourceUrl = `http://127.0.0.1:${(fixture.address() as AddressInfo).port}/`;

  const dataDir = mkdtempSync(join(tmpdir(), "dezin-shar-run-"));
  const store = new Store(":memory:");
  const project = store.createProject({ name: "Clone", mode: "standard", sharingan: true, sourceUrl });

  // Manually stand up the standard-project git scaffold (standardProjectSetup only runs from
  // POST /api/projects, not from a project created directly via the store).
  const dir = projectDir(dataDir, project.id);
  mkdirSync(join(dir, "src"), { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: dir });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { dev: "vite" } }));
  writeFileSync(join(dir, "src", "App.jsx"), "export default function App(){ return <main>Base</main> }");
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["-c", "user.name=Dezin", "-c", "user.email=dezin@local", "commit", "-q", "-m", "base"], { cwd: dir });

  const runner = new RecordingRunner();
  const app = createApp({
    store,
    dataDir,
    runner,
    visualQa: async () => [],
    standardProjectSetup: async () => {},
    ensureDevServer: async () => ({ url: "http://127.0.0.1:1/" }),
  });
  await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
  try {
    const res = await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      // research intentionally omitted (undefined) — the client does NOT force it off;
      // skipping must come from the server-side `!project.sharingan` gate.
      body: JSON.stringify({ projectId: project.id, brief: sourceUrl }),
    });
    const events = parseSse(await res.text());
    assert.ok(
      events.some((e) => e.type === "run-done"),
      `expected a run-done event, got: ${events.map((e) => e.type).join(", ")}`,
    );

    assert.ok(
      existsSync(join(projectDir(dataDir, project.id), ".sharingan", "pages.json")),
      "the entry capture ran before the build turn",
    );
    assert.match(
      runner.lastMessage,
      /Reproduce from Capture|probe\.mjs/i,
      "the sharingan context block was injected into the agent brief",
    );
    assert.ok(
      !existsSync(join(projectDir(dataDir, project.id), "research")),
      "research was skipped for the sharingan project",
    );
  } finally {
    await closeAllSharinganSessions();
    await new Promise<void>((r) => app.close(() => r()));
    fixture.closeAllConnections();
    await new Promise<void>((r) => fixture.close(() => r()));
    store.close();
  }
});
