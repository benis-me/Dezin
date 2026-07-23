import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  immutableProbeCliScript,
  writeProbeCli,
  probeCliScript,
} from "../src/sharingan-probe-cli.ts";

test("probeCliScript bakes the base URL in but keeps the un-baked guard", () => {
  const s = probeCliScript("http://127.0.0.1:7457/api/sharingan/abc");
  assert.match(s, /const BASE = "http:\/\/127\.0\.0\.1:7457\/api\/sharingan\/abc"/, "base is baked into the const");
  assert.match(s, /BASE === "__BASE__"/, "the un-baked guard is preserved");
  assert.match(s, /case "navigate"/, "has the navigate command");
  assert.match(s, /function outline/, "has the outline command");
  assert.match(s, /function renderMap/, "has the render-map command");
  assert.match(s, /function sourceSummary/, "has the source-summary command");
  assert.match(s, /function sourceScaffold/, "has the source-scaffold command");
  const identityStart = s.indexOf("function sourceCaptureIdentity");
  const identityEnd = s.indexOf("function regionSignalScore", identityStart);
  const identitySource = s.slice(identityStart, identityEnd);
  assert.ok(identityStart >= 0 && identityEnd > identityStart, "contains the capture identity implementation");
  assert.doesNotMatch(
    identitySource,
    /readFileSync/,
    "the plan identity must hash the same byte snapshots used to derive its regions, not re-read mutable files",
  );
});

test("the immutable exported probe rejects mutable source-scaffold before changing either pinned root", () => {
  const dir = mkdtempSync(join(tmpdir(), "probe-immutable-"));
  const sharingan = join(dir, ".sharingan");
  const assets = join(dir, "public", "_assets");
  mkdirSync(sharingan, { recursive: true });
  mkdirSync(assets, { recursive: true });
  const probe = join(sharingan, "probe.mjs");
  const pages = join(sharingan, "pages.json");
  const asset = join(assets, "source.png");
  writeFileSync(probe, immutableProbeCliScript());
  writeFileSync(pages, "{\"pages\":[]}\n");
  writeFileSync(asset, "exact-source-asset\n");
  const before = {
    probe: readFileSync(probe),
    pages: readFileSync(pages),
    asset: readFileSync(asset),
  };

  const result = spawnSync(process.execPath, [probe, "source-scaffold"], {
    cwd: dir,
    encoding: "utf8",
    timeout: 2_000,
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /immutable.*--stdout/i);
  assert.deepEqual(readFileSync(probe), before.probe);
  assert.deepEqual(readFileSync(pages), before.pages);
  assert.deepEqual(readFileSync(asset), before.asset);
  assert.equal(existsSync(join(sharingan, "region-plan.json")), false);
  assert.equal(existsSync(join(sharingan, "source-scaffold")), false);
});

test("source-scaffold rejects controlled manifest, render-map, and screenshot replacement during one derivation", {
  skip: process.platform === "win32" && "named-pipe replacement probe requires a POSIX host",
}, async () => {
  const runReplacementProbe = async (target: "manifest" | "render-map" | "screenshot"): Promise<void> => {
    const dir = mkdtempSync(join(tmpdir(), `probe-snapshot-${target}-`));
    writeProbeCli(dir, "http://127.0.0.1:9999/api/sharingan/snapshot");
    const sharingan = join(dir, ".sharingan");
    const pageDir = join(sharingan, "home");
    mkdirSync(pageDir, { recursive: true });
    const pages = join(sharingan, "pages.json");
    const renderMap = join(pageDir, "render-map.json");
    const assets = join(pageDir, "assets.json");
    const screenshot = join(pageDir, "shot.png");
    const pipe = target === "manifest" ? pages : target === "render-map" ? renderMap : screenshot;
    execFileSync("mkfifo", [pipe]);

    const manifest = JSON.stringify({
      entryUrl: "https://example.test/snapshot",
      pages: [{
        url: "https://example.test/snapshot",
        renderMap,
        assets,
        screenshots: target === "screenshot" ? { desktop: screenshot } : {},
      }],
    });
    const map = JSON.stringify({
      viewport: { width: 1200, height: 800 },
      document: { width: 1200, height: 800 },
      elements: [{
        selector: "main h1",
        tag: "h1",
        text: "First snapshot",
        box: { x: 80, y: 80, w: 560, h: 48 },
        style: { fontSize: "32px" },
      }],
    });
    if (target !== "manifest") writeFileSync(pages, manifest);
    if (target !== "render-map") writeFileSync(renderMap, map);
    writeFileSync(assets, "[]");
    if (target !== "screenshot") writeFileSync(screenshot, "unused");

    const first = target === "manifest" ? manifest : target === "render-map" ? map : "first screenshot";
    const second = target === "manifest"
      ? manifest.replace("snapshot\"", "snapshot?changed\"")
      : target === "render-map"
        ? map.replace("First snapshot", "Second snapshot")
        : "second screenshot";
    const writer = spawn(process.execPath, [
      "-e",
      "const { writeFileSync } = require('node:fs'); const [path, first, second] = process.argv.slice(1); writeFileSync(path, first); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50); writeFileSync(path, second);",
      pipe,
      first,
      second,
    ], { stdio: "ignore" });
    const writerDone = new Promise<void>((resolve) => writer.once("exit", () => resolve()));
    const result = spawnSync(process.execPath, [join(sharingan, "probe.mjs"), "source-scaffold"], {
      cwd: dir,
      encoding: "utf8",
      timeout: 5_000,
    });
    if (result.status !== 1) writer.kill();
    await writerDone;

    assert.equal(result.status, 1, `${target} replacement must fail closed: ${result.stderr}`);
    assert.match(result.stderr, /captured source changed while source-scaffold was deriving its region plan/i);
    assert.equal(existsSync(join(sharingan, "region-plan.json")), false, "an unstable snapshot cannot publish a derived plan");
  };

  await runReplacementProbe("manifest");
  await runReplacementProbe("render-map");
  await runReplacementProbe("screenshot");
});

test("source-scaffold rejects capture references that escape the pinned .sharingan root", () => {
  const dir = mkdtempSync(join(tmpdir(), "probe-capture-boundary-"));
  writeProbeCli(dir, "http://127.0.0.1:9999/api/sharingan/boundary");
  const sharingan = join(dir, ".sharingan");
  const outsideRenderMap = join(dir, "outside-render-map.json");
  const outsideAssets = join(dir, "outside-assets.json");
  writeFileSync(outsideRenderMap, JSON.stringify({
    viewport: { width: 1200, height: 800 },
    document: { width: 1200, height: 800 },
    elements: [],
  }));
  writeFileSync(outsideAssets, "[]");
  writeFileSync(join(sharingan, "pages.json"), JSON.stringify({
    entryUrl: "https://example.test/boundary",
    pages: [{
      url: "https://example.test/boundary",
      renderMap: outsideRenderMap,
      assets: outsideAssets,
    }],
  }));

  const result = spawnSync(process.execPath, [join(sharingan, "probe.mjs"), "source-scaffold"], {
    cwd: dir,
    encoding: "utf8",
    timeout: 5_000,
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /outside the pinned \.sharingan capture root/i);
  assert.equal(existsSync(join(sharingan, "region-plan.json")), false);
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

test("probe source-summary prints component inventory, tokens, text, and assets in one bounded read", () => {
  const dir = mkdtempSync(join(tmpdir(), "probe-source-summary-"));
  const rel = writeProbeCli(dir, "http://127.0.0.1:9999/api/sharingan/x");
  assert.equal(rel, ".sharingan/probe.mjs");
  const probe = join(dir, ".sharingan", "probe.mjs");
  const pageDir = join(dir, ".sharingan", "home");
  const domPath = join(pageDir, "dom.json");
  const mapPath = join(pageDir, "render-map.json");
  const stylesPath = join(pageDir, "styles.json");
  const assetsPath = join(pageDir, "assets.json");
  mkdirSync(pageDir, { recursive: true });
  writeFileSync(join(dir, ".sharingan", "pages.json"), JSON.stringify({ entryUrl: "https://example.com", pages: [{ url: "https://example.com", dom: domPath, renderMap: mapPath, styles: stylesPath, assets: assetsPath }] }));
  writeFileSync(domPath, JSON.stringify([]));
  writeFileSync(stylesPath, JSON.stringify({ colors: ["rgb(0, 0, 0)", "#ffffff"], fontFamilies: ["Inter", "Arial"], fontSizes: ["12px", "32px"], radii: ["8px"] }));
  writeFileSync(assetsPath, JSON.stringify({ assets: [{ kind: "img", local: "/_assets/card.png", w: 320, h: 180, alt: "Card" }] }));
  writeFileSync(mapPath, JSON.stringify({
    viewport: { width: 1440, height: 900 },
    document: { width: 1440, height: 1600 },
    elements: [
      { selector: "header a.home", tag: "a", text: "Home", box: { x: 80, y: 24, w: 60, h: 24 }, style: { fontSize: "14px", color: "rgb(255, 255, 255)" } },
      { selector: "h1.prompt", tag: "h1", text: "What do you want to create?", box: { x: 400, y: 140, w: 520, h: 44 }, style: { fontSize: "32px", fontWeight: "700", color: "rgb(255, 255, 255)" } },
      { selector: "img.card", tag: "img", text: "", box: { x: 400, y: 260, w: 320, h: 180 }, style: { objectFit: "cover" } },
      { selector: "footer a.privacy", tag: "a", text: "Privacy", box: { x: 80, y: 1460, w: 80, h: 24 }, style: { fontSize: "12px" } },
    ],
  }));
  const out = execFileSync("node", [probe, "source-summary"], { cwd: dir, encoding: "utf8" });
  assert.match(out, /SOURCE COMPONENT INVENTORY/);
  assert.match(out, /Header\/nav: Home/);
  assert.match(out, /Hero\/primary panel: What do you want to create\?/);
  assert.match(out, /Media\/card grid: 1 image/);
  assert.match(out, /STYLE TOKENS/);
  assert.match(out, /ASSET INVENTORY/);
  assert.match(out, /\/_assets\/card\.png/);
});

test("probe defaults select the manifest sourceUrl entry instead of pages[0]", () => {
  const dir = mkdtempSync(join(tmpdir(), "probe-source-entry-"));
  writeProbeCli(dir, "http://127.0.0.1:9999/api/sharingan/x");
  const probe = join(dir, ".sharingan", "probe.mjs");
  const decoyDir = join(dir, ".sharingan", "decoy");
  const entryDir = join(dir, ".sharingan", "entry");
  mkdirSync(decoyDir, { recursive: true });
  mkdirSync(entryDir, { recursive: true });

  const writePage = (pageDir: string, label: string) => {
    const dom = join(pageDir, "dom.json");
    const renderMap = join(pageDir, "render-map.json");
    const styles = join(pageDir, "styles.json");
    const assets = join(pageDir, "assets.json");
    writeFileSync(dom, JSON.stringify([{ tag: "h1", classes: label.toLowerCase(), text: label, box: { x: 20, y: 20, w: 400, h: 48 }, style: {}, children: [] }]));
    writeFileSync(renderMap, JSON.stringify({
      viewport: { width: 1440, height: 900 },
      document: { width: 1440, height: 900 },
      elements: [{ selector: `h1.${label.toLowerCase()}`, tag: "h1", text: label, box: { x: 20, y: 20, w: 400, h: 48 }, style: { fontSize: "40px" } }],
    }));
    writeFileSync(styles, JSON.stringify({ colors: [], fontFamilies: [], fontSizes: ["40px"], radii: [] }));
    writeFileSync(assets, JSON.stringify([]));
    return { dom, renderMap, styles, assets };
  };
  const decoy = writePage(decoyDir, "DECOY HERO");
  const entry = writePage(entryDir, "ENTRY HERO");
  writeFileSync(join(dir, ".sharingan", "pages.json"), JSON.stringify({
    sourceUrl: "https://example.test/entry/",
    pages: [
      { url: "https://example.test/decoy", ...decoy },
      { url: "https://example.test/entry", ...entry },
    ],
  }));

  const summary = execFileSync("node", [probe, "source-summary"], { cwd: dir, encoding: "utf8" });
  const outline = execFileSync("node", [probe, "outline"], { cwd: dir, encoding: "utf8" });
  const renderMap = execFileSync("node", [probe, "render-map"], { cwd: dir, encoding: "utf8" });
  execFileSync("node", [probe, "source-scaffold"], { cwd: dir, encoding: "utf8" });
  const scaffold = readFileSync(join(dir, ".sharingan", "source-scaffold", "App.jsx"), "utf8");
  const regionPlan = JSON.parse(readFileSync(join(dir, ".sharingan", "region-plan.json"), "utf8")) as { sourceUrl?: string };

  for (const output of [summary, outline, renderMap, scaffold]) {
    assert.match(output, /ENTRY HERO/, "every default source input comes from the sourceUrl entry");
    assert.doesNotMatch(output, /DECOY HERO/, "pages[0] cannot leak into the generation inputs");
  }
  assert.equal(regionPlan.sourceUrl, "https://example.test/entry");
});

test("probe source-scaffold writes a measured reference without replacing the Standard app", () => {
  const dir = mkdtempSync(join(tmpdir(), "probe-source-scaffold-"));
  const rel = writeProbeCli(dir, "http://127.0.0.1:9999/api/sharingan/x");
  assert.equal(rel, ".sharingan/probe.mjs");
  const probe = join(dir, ".sharingan", "probe.mjs");
  const pageDir = join(dir, ".sharingan", "home");
  const domPath = join(pageDir, "dom.json");
  const mapPath = join(pageDir, "render-map.json");
  const stylesPath = join(pageDir, "styles.json");
  const assetsPath = join(pageDir, "assets.json");
  mkdirSync(pageDir, { recursive: true });
  writeFileSync(join(dir, ".sharingan", "pages.json"), JSON.stringify({ entryUrl: "https://example.com", pages: [{ url: "https://example.com", dom: domPath, renderMap: mapPath, styles: stylesPath, assets: assetsPath }] }));
  writeFileSync(domPath, JSON.stringify([]));
  writeFileSync(stylesPath, JSON.stringify({}));
  writeFileSync(assetsPath, JSON.stringify({
    0: { kind: "background", url: "https://cdn.test/card.webp", local: "/_assets/card.webp", alt: "Card" },
    1: { kind: "img", url: "https://cdn.test/logo.svg", local: "/_assets/logo.svg", alt: "Logo" },
  }));
  writeFileSync(mapPath, JSON.stringify({
    viewport: { width: 1440, height: 900 },
    document: { width: 1440, height: 900 },
    elements: [
      { selector: "main", tag: "main", text: "", box: { x: 0, y: 0, w: 1440, h: 900 }, style: { backgroundColor: "rgb(15, 15, 15)" } },
      { selector: "div.chrome", tag: "div", text: "", box: { x: 0, y: 0, w: 1440, h: 64 }, style: { backgroundImage: "linear-gradient(0deg, black, transparent)" } },
      { selector: "div.panel", tag: "div", text: "", box: { x: 320, y: 120, w: 520, h: 240 }, style: { backgroundColor: "rgb(32, 32, 32)", borderRadius: "16px" } },
      { selector: "span.nav", tag: "span", text: "Home", box: { x: 600, y: 144, w: 90, h: 40 }, style: { fontSize: "16px", lineHeight: "24px", color: "rgb(255, 255, 255)" } },
      { selector: "svg.nav-icon", tag: "svg", text: "", box: { x: 612, y: 156, w: 16, h: 16 }, style: {}, svg: '<svg viewBox="0 0 16 16"><path d="M2 8h12"/></svg>' },
      { selector: "img.logo", tag: "img", src: "https://cdn.test/logo.svg", currentSrc: "https://cdn.test/logo.svg", text: "", box: { x: 344, y: 144, w: 40, h: 40 }, style: { objectFit: "cover" } },
      { selector: "img.model", tag: "img", src: "data:image/svg+xml,%3csvg%20viewBox='0%200%2010%2010'%3e%3cpath%20d='M0%200h10v10H0z'/%3e%3c/svg%3e", currentSrc: "data:image/svg+xml,%3csvg%20viewBox='0%200%2010%2010'%3e%3cpath%20d='M0%200h10v10H0z'/%3e%3c/svg%3e", text: "", box: { x: 392, y: 154, w: 16, h: 16 }, style: { objectFit: "contain" } },
      { selector: "svg.icon", tag: "svg", text: "", box: { x: 416, y: 154, w: 16, h: 16 }, style: {}, svg: '<svg viewBox="0 0 16 16"><defs><linearGradient id="grad"><stop offset="0%" stop-color="white"/></linearGradient></defs><path fill="url(#grad)" d="M2 8h12"/></svg>' },
      { selector: "div.card-bg", tag: "div", text: "", box: { x: 344, y: 220, w: 220, h: 120 }, style: { backgroundImage: "linear-gradient(0deg, transparent, transparent), url(\"https://cdn.test/card.webp\")", objectFit: "cover", borderRadius: "12px" } },
      { selector: "h1.title", tag: "h1", text: "Hello Source", box: { x: 400, y: 148, w: 240, h: 36 }, style: { fontSize: "32px", fontWeight: "700", color: "rgb(255, 255, 255)" } },
      { selector: "img.edge-sliver", tag: "img", src: "https://cdn.test/card.webp", currentSrc: "https://cdn.test/card.webp", text: "", box: { x: -190, y: 500, w: 200, h: 80 }, style: { objectFit: "cover" } },
    ],
  }));

  const out = execFileSync("node", [probe, "source-scaffold"], { cwd: dir, encoding: "utf8" });
  assert.match(out, /SOURCE SCAFFOLD wrote \.sharingan\/source-scaffold\/App\.jsx and \.sharingan\/source-scaffold\/index\.css/);
  assert.equal(existsSync(join(dir, "src", "App.jsx")), false, "source-scaffold must not replace the Standard app entrypoint");
  const app = readFileSync(join(dir, ".sharingan", "source-scaffold", "App.jsx"), "utf8");
  const css = readFileSync(join(dir, ".sharingan", "source-scaffold", "index.css"), "utf8");
  const regionPlan = JSON.parse(readFileSync(join(dir, ".sharingan", "region-plan.json"), "utf8"));
  assert.equal(regionPlan.protocol, "dezin.sharingan-region-plan.v2");
  assert.equal(regionPlan.version, 2);
  assert.equal(regionPlan.regionBudget, 8);
  assert.equal(regionPlan.candidateCount, regionPlan.regions.length);
  assert.equal(regionPlan.sourceUrl, "https://example.com");
  assert.ok(Array.isArray(regionPlan.regions));
  assert.ok(regionPlan.regions.length >= 2, "source-scaffold writes fine-grained regions for subagents");
  assert.ok(regionPlan.regions.some((region: { id: string; texts?: string[] }) => region.id === "region-1" && region.texts?.includes("Home")), "region plan includes first visible text region");
  assert.ok(regionPlan.regions.some((region: { assets?: string[] }) => region.assets?.includes("/_assets/card.webp")), "region plan maps local assets into owning regions");
  assert.ok(regionPlan.regions.some((region: { textRuns?: Array<{ text?: string; fontSize?: string }> }) => region.textRuns?.some((run) => run.text === "Home" && run.fontSize === "16px")), "region plan preserves measured text styles");
  assert.ok(regionPlan.regions.some((region: { media?: Array<{ src?: string; box?: { w?: number } }> }) => region.media?.some((item) => item.src === "/_assets/card.webp" && item.box?.w === 220)), "region plan preserves measured media boxes");
  assert.ok(regionPlan.regions.some((region: { vectors?: Array<{ html?: string }> }) => region.vectors?.some((item) => item.html?.includes("<svg") && item.html.includes("sgv-1-grad"))), "region plan preserves scoped SVG vectors for icon fidelity");
  assert.match(app, /SHARINGAN SOURCE SCAFFOLD - REFERENCE ONLY/);
  assert.match(app, /const SOURCE =/);
  assert.match(app, /Do not submit this replay unchanged as the final Standard app/);
  assert.match(app, /SOURCE\.vectors/);
  assert.match(app, /Hello Source/);
  assert.match(app, /\/_assets\/logo\.svg/);
  assert.match(app, /\/_assets\/card\.webp/);
  assert.match(app, /height: item\.box\.h/);
  assert.doesNotMatch(app, /minHeight: item\.box\.h/);
  assert.match(app, /data-lines=\{item\.lines \|\| 1\}/);
  const source = JSON.parse(app.match(/const SOURCE = ([\s\S]*?);\n\nfunction boxStyle/)![1]!);
  assert.equal(source.images.length, 3, "pure CSS gradients are paint boxes and barely visible edge slivers are not replayed as image slots");
  assert.equal(source.images[0].src, "/_assets/logo.svg", "logo maps by captured src URL even when assets are not in DOM order");
  assert.match(source.images[1].src, /^data:image\/svg\+xml/, "source data-image icons are replayed directly");
  assert.equal(source.images[2].src, "/_assets/card.webp", "background image maps by CSS url(...)");
  assert.equal(source.vectors.length, 2, "inline source SVGs are replayed as vector slots");
  assert.match(source.vectors[1].html, /id="sgv-1-grad"/, "SVG ids are scoped per vector to avoid collisions");
  assert.match(source.vectors[1].html, /url\(#sgv-1-grad\)/, "SVG url(#id) references are scoped with the ids");
  assert.ok(source.boxes.some((box: { box: { x: number; y: number; w: number; h: number } }) => box.box.x === 320 && box.box.y === 120 && box.box.w === 520 && box.box.h === 240), "large painted containers survive when they contain small image/vector icons");
  assert.ok(source.texts.some((text: { text: string; box: { x: number } }) => text.text === "Home" && text.box.x > 600), "text boxes containing a left icon are shifted after the icon");
  assert.equal(source.texts.find((text: { text: string; lines?: number }) => text.text === "Hello Source")?.lines, 1, "text replay records a fixed line budget from the captured box");
  assert.ok(source.boxes.some((box: { backgroundImage?: string }) => box.backgroundImage?.includes("linear-gradient")), "the gradient layer remains painted as a box");
  assert.match(css, /\.sharingan-stage/);
  assert.match(css, /\.source-vector svg/);
  assert.match(css, /-webkit-line-clamp: var\(--source-lines, 1\)/);
  assert.match(css, /\.source-text\[data-lines="1"\]/);
});

test("probe source-scaffold plans a bounded, measured cross-section of a long page", () => {
  const dir = mkdtempSync(join(tmpdir(), "probe-long-region-plan-"));
  writeProbeCli(dir, "http://127.0.0.1:9999/api/sharingan/x");
  const probe = join(dir, ".sharingan", "probe.mjs");
  const pageDir = join(dir, ".sharingan", "home");
  const renderMap = join(pageDir, "render-map.json");
  const assets = join(pageDir, "assets.json");
  mkdirSync(pageDir, { recursive: true });

  const elements: Array<{
    selector: string;
    tag: string;
    text: string;
    box: { x: number; y: number; w: number; h: number };
    style: Record<string, string>;
  }> = Array.from({ length: 18 }, (_, index) => ({
    selector: index === 17 ? "footer.cta" : `section:nth-child(${index + 1}) h2`,
    tag: index === 17 ? "footer" : "h2",
    text: index === 17 ? "Footer CTA" : `Section ${index}`,
    box: { x: 80, y: index * 240 + 20, w: 560, h: 48 },
    style: { fontSize: "32px", fontWeight: "700", color: "rgb(20, 20, 20)" },
  }));
  elements.push(
    ...Array.from({ length: 4 }, (_, index) => ({
      selector: `.critical-card-${index}`,
      tag: "img",
      text: "",
      box: { x: 680 + index * 80, y: 10 * 240 + 12, w: 64, h: 64 },
      style: { objectFit: "cover" },
    })),
  );

  writeFileSync(join(dir, ".sharingan", "pages.json"), JSON.stringify({
    entryUrl: "https://example.test/long",
    pages: [{ url: "https://example.test/long", renderMap, assets }],
  }));
  writeFileSync(assets, "[]");
  writeFileSync(renderMap, JSON.stringify({
    viewport: { width: 1200, height: 800 },
    document: { width: 1200, height: 4260 },
    elements,
  }));

  execFileSync("node", [probe, "source-scaffold"], { cwd: dir, encoding: "utf8" });
  const plan = JSON.parse(readFileSync(join(dir, ".sharingan", "region-plan.json"), "utf8")) as {
    regions: Array<{ texts?: string[]; bbox?: { y?: number } }>;
  };

  assert.equal(plan.regions.length, 8, "the generated plan and agent budget must agree");
  assert.ok(plan.regions[0]?.texts?.includes("Section 0"), "the opening region is preserved");
  assert.ok(plan.regions.at(-1)?.texts?.includes("Footer CTA"), "the final measured region is preserved");
  assert.ok(plan.regions.some((region) => region.texts?.includes("Section 10")), "a visually dense middle region is preserved");
  assert.ok(
    plan.regions.some((region) => Number(region.bbox?.y) >= 3_600),
    "the plan samples the lower portion of the document instead of stopping near the top",
  );
});

test("probe source-scaffold samples sparse middle and lower document bands instead of spending the budget near the top", () => {
  const dir = mkdtempSync(join(tmpdir(), "probe-clustered-region-plan-"));
  writeProbeCli(dir, "http://127.0.0.1:9999/api/sharingan/x");
  const probe = join(dir, ".sharingan", "probe.mjs");
  const pageDir = join(dir, ".sharingan", "home");
  const renderMap = join(pageDir, "render-map.json");
  const assets = join(pageDir, "assets.json");
  mkdirSync(pageDir, { recursive: true });

  const elements: Array<{
    selector: string;
    tag: string;
    text: string;
    box: { x: number; y: number; w: number; h: number };
    style: Record<string, string>;
  }> = Array.from({ length: 12 }, (_, index) => ({
    selector: `section.top-${index} h2`,
    tag: "h2",
    text: index === 0 ? "Opening" : `Top detail ${index}`,
    box: { x: 80, y: index * 200 + 20, w: 560, h: 48 },
    style: { fontSize: "32px", fontWeight: "700", color: "rgb(20, 20, 20)" },
  }));
  elements.push(
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
    ...Array.from({ length: 6 }, (_, index) => ({
      selector: `.dense-top-${index}`,
      tag: "img",
      text: "",
      box: { x: 680 + index * 70, y: 2_220, w: 60, h: 60 },
      style: { objectFit: "cover" },
    })),
  );

  writeFileSync(join(dir, ".sharingan", "pages.json"), JSON.stringify({
    entryUrl: "https://example.test/clustered",
    pages: [{ url: "https://example.test/clustered", renderMap, assets }],
  }));
  writeFileSync(assets, "[]");
  writeFileSync(renderMap, JSON.stringify({
    viewport: { width: 1200, height: 800 },
    document: { width: 1200, height: 12_000 },
    elements,
  }));

  execFileSync("node", [probe, "source-scaffold"], { cwd: dir, encoding: "utf8" });
  const plan = JSON.parse(readFileSync(join(dir, ".sharingan", "region-plan.json"), "utf8")) as {
    protocol?: string;
    version?: number;
    captureIdentity?: {
      protocol?: string;
      pagesManifestSha256?: string;
      pagesEntrySha256?: string;
      renderMapSha256?: string;
      assetsSha256?: string;
      screenshotsSha256?: string;
    };
    regionBudget?: number;
    candidateCount?: number;
    regions: Array<{ texts?: string[] }>;
  };

  assert.equal(plan.protocol, "dezin.sharingan-region-plan.v2");
  assert.equal(plan.version, 2);
  assert.deepEqual(Object.keys(plan.captureIdentity ?? {}).sort(), [
    "assetsSha256",
    "pagesEntrySha256",
    "pagesManifestSha256",
    "protocol",
    "renderMapSha256",
    "screenshotsSha256",
  ]);
  assert.equal(plan.captureIdentity?.protocol, "dezin.sharingan-entry-capture-identity.v2");
  assert.match(plan.captureIdentity?.pagesManifestSha256 ?? "", /^[a-f0-9]{64}$/);
  assert.match(plan.captureIdentity?.pagesEntrySha256 ?? "", /^[a-f0-9]{64}$/);
  assert.match(plan.captureIdentity?.renderMapSha256 ?? "", /^[a-f0-9]{64}$/);
  assert.match(plan.captureIdentity?.assetsSha256 ?? "", /^[a-f0-9]{64}$/);
  assert.match(plan.captureIdentity?.screenshotsSha256 ?? "", /^[a-f0-9]{64}$/);
  const digest = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");
  assert.equal(plan.captureIdentity?.pagesManifestSha256, digest(readFileSync(join(dir, ".sharingan", "pages.json"))));
  assert.equal(plan.captureIdentity?.renderMapSha256, digest(readFileSync(renderMap)));
  assert.equal(plan.captureIdentity?.assetsSha256, digest(readFileSync(assets)));
  assert.equal(plan.captureIdentity?.screenshotsSha256, digest(Buffer.from("[]", "utf8")));
  assert.equal(plan.regionBudget, 8);
  assert.equal(plan.candidateCount, 15);
  assert.equal(plan.regions.length, 8);
  assert.ok(plan.regions.some((region) => region.texts?.includes("Middle story")));
  assert.ok(plan.regions.some((region) => region.texts?.includes("Lower proof")));
  assert.ok(plan.regions.at(-1)?.texts?.includes("Footer CTA"));
});
