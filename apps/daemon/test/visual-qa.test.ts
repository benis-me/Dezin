import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zlibSync } from "fflate";
import { agentReviewPrompt, auditVisualArtifact, boundComputedFindings, findingsFromGeometry, parseVisualReview, reviewScreenshotWithAgent, reviewWithRetry, shouldRunComputedDetector, sourceFidelityFindings, sourceScreenshotDiffFindings, sourceViewportFromRenderMap, toComputedElements, type GeometryElement, type VisualQaInput } from "../src/visual-qa.ts";
import type { QualityFinding } from "../../../packages/core/src/index.ts";

function geomEl(overrides: Partial<GeometryElement> = {}): GeometryElement {
  return {
    selector: "p",
    tag: "p",
    text: "Readable body copy.",
    rect: { left: 0, top: 0, right: 200, bottom: 20, width: 200, height: 20 },
    position: "static",
    overflowX: "visible",
    overflowY: "visible",
    scrollWidth: 200,
    scrollHeight: 20,
    clientWidth: 200,
    clientHeight: 20,
    ...overrides,
  };
}

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBuf = Buffer.from(type, "ascii");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function rgbaPng(width: number, height: number, rgba: Buffer): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // rgba
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    const rowStart = y * (width * 4 + 1);
    raw[rowStart] = 0;
    rgba.copy(raw, rowStart + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", Buffer.from(zlibSync(raw))),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

test("toComputedElements reshapes the geometry snapshot into pure computed-style elements", () => {
  const computed = toComputedElements([
    geomEl({
      selector: "p.fine",
      text: "Legalese",
      rect: { left: 10, top: 20, right: 210, bottom: 40, width: 200, height: 20 },
      style: { color: "rgb(0, 0, 0)", fontSizePx: 10 },
    }),
  ]);
  assert.equal(computed.length, 1);
  assert.equal(computed[0]!.selector, "p.fine");
  assert.equal(computed[0]!.rect.x, 10);
  assert.equal(computed[0]!.rect.y, 20);
  assert.equal(computed[0]!.rect.width, 200);
  assert.equal(computed[0]!.style.fontSizePx, 10);
});

test("toComputedElements drops zero-area nodes the detector cannot judge", () => {
  const computed = toComputedElements([
    geomEl({ selector: "span.ghost", text: "", rect: { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 } }),
  ]);
  assert.equal(computed.length, 0);
});

test("boundComputedFindings dedupes by id+selector and caps per rule so the repair loop is not flooded", () => {
  const mk = (id: string, selector: string): QualityFinding => ({ severity: "P2", id, message: "m", fix: "f", selector });
  const out = boundComputedFindings(
    [
      mk("tiny-text", "a"),
      mk("tiny-text", "a"), // exact dup → collapses
      mk("tiny-text", "b"),
      mk("tiny-text", "c"),
      mk("tiny-text", "d"), // 4 distinct selectors, but per-id cap is 3
      mk("low-contrast", "x"),
    ],
    3,
    20,
  );
  assert.equal(out.filter((f) => f.id === "tiny-text").length, 3, "per-id cap holds");
  assert.equal(out.filter((f) => f.id === "low-contrast").length, 1, "other rules survive");
});

test("boundComputedFindings enforces the overall total cap", () => {
  const raw: QualityFinding[] = Array.from({ length: 30 }, (_, i) => ({ severity: "P2", id: `r${i}`, message: "m", fix: "f", selector: `s${i}` }));
  assert.equal(boundComputedFindings(raw, 3, 20).length, 20);
});

test("computed anti-slop detector is skipped for Sharingan clones", () => {
  assert.equal(shouldRunComputedDetector({ isSharingan: true } as any), false);
  assert.equal(shouldRunComputedDetector({ isSharingan: false } as any), true);
  assert.equal(shouldRunComputedDetector({} as any), true);
});

test("sourceViewportFromRenderMap uses the source capture viewport for Sharingan QA", () => {
  assert.deepEqual(sourceViewportFromRenderMap({ viewport: { width: 1440, height: 900 } }), { width: 1440, height: 900 });
  assert.equal(sourceViewportFromRenderMap({ viewport: { width: 0, height: 900 } }), undefined);
  assert.equal(sourceViewportFromRenderMap({ viewport: { width: 4000, height: 900 } }), undefined);
});

test("findingsFromGeometry reports horizontal overflow, offscreen fixed controls, and clipped text", () => {
  const findings = findingsFromGeometry(
    {
      viewport: { width: 390, height: 844 },
      document: { scrollWidth: 520, scrollHeight: 900 },
      elements: [
        {
          selector: "header .menu",
          tag: "button",
          text: "Menu",
          rect: { left: 360, top: 12, right: 438, bottom: 44, width: 78, height: 32 },
          position: "fixed",
          overflowX: "visible",
          overflowY: "visible",
          scrollWidth: 78,
          scrollHeight: 32,
          clientWidth: 78,
          clientHeight: 32,
        },
        {
          selector: ".pricing-card h2",
          tag: "h2",
          text: "Enterprise annual plan",
          rect: { left: 16, top: 180, right: 216, bottom: 208, width: 200, height: 28 },
          position: "static",
          overflowX: "hidden",
          overflowY: "hidden",
          scrollWidth: 290,
          scrollHeight: 28,
          clientWidth: 200,
          clientHeight: 28,
        },
      ],
    },
    "mobile",
  );

  assert.deepEqual(
    findings.map((f) => f.id),
    ["visual-horizontal-overflow", "visual-below-fold-strip", "visual-fixed-offscreen", "visual-text-clipped"],
  );
  assert.match(findings[0]!.message, /mobile/i);
  assert.match(findings.find((f) => f.id === "visual-fixed-offscreen")!.snippet ?? "", /header \.menu/);
  const clippedText = findings.find((f) => f.id === "visual-text-clipped")!;
  assert.equal(clippedText.severity, "P2");
  assert.match(clippedText.fix, /wrapping|height|container/i);
});

test("findingsFromGeometry upgrades clipped text to a Sharingan-blocking defect in strict text layout mode", () => {
  const findings = findingsFromGeometry(
    {
      viewport: { width: 1440, height: 900 },
      document: { scrollWidth: 1440, scrollHeight: 900 },
      elements: [
        geomEl({
          selector: ".card-title",
          text: "A copied title that no longer fits the captured text box",
          overflowX: "hidden",
          overflowY: "hidden",
          scrollWidth: 420,
          scrollHeight: 48,
          clientWidth: 240,
          clientHeight: 24,
        }),
      ],
    },
    "desktop",
    { strictTextLayout: true },
  );

  const clippedText = findings.find((f) => f.id === "visual-text-clipped");
  assert.equal(clippedText?.severity, "P1");
});

test("findingsFromGeometry ignores clipped aggregate containers without direct text", () => {
  const findings = findingsFromGeometry(
    {
      viewport: { width: 1440, height: 900 },
      document: { scrollWidth: 1440, scrollHeight: 900 },
      elements: [
        geomEl({
          selector: "div.sharingan-stage",
          tag: "div",
          text: "TapNow Home Workspace Create",
          overflowX: "hidden",
          overflowY: "hidden",
          scrollWidth: 1440,
          scrollHeight: 980,
          clientWidth: 1440,
          clientHeight: 900,
          directTextLength: 0,
          childElementCount: 8,
        } as any),
      ],
    },
    "desktop",
    { strictTextLayout: true },
  );

  assert.ok(!findings.some((f) => f.id === "visual-text-clipped"), "aggregate stage text should not be treated as clipped direct text");
});

test("findingsFromGeometry ignores text clipping that matches the captured Sharingan source box", () => {
  const source = {
    viewport: { width: 1440, height: 900 },
    document: { width: 1440, height: 900 },
    elements: [
      { selector: "span.max-w-20.truncate", tag: "span", text: "Ben Lee's Team", box: { x: 1277, y: 22, w: 80, h: 20 }, style: { fontSize: "14px", lineHeight: "20px" } },
    ],
  };
  const snapshot = {
    viewport: { width: 1440, height: 900 },
    document: { scrollWidth: 1440, scrollHeight: 900 },
    elements: [
      geomEl({
        selector: "div.source-text",
        tag: "div",
        text: "Ben Lee's Team",
        rect: { left: 1277, top: 22, right: 1357, bottom: 42, width: 80, height: 20 },
        overflowX: "hidden",
        overflowY: "hidden",
        scrollWidth: 102,
        scrollHeight: 20,
        clientWidth: 80,
        clientHeight: 20,
        directTextLength: "Ben Lee's Team".length,
        childElementCount: 0,
      }),
    ],
  };

  const findings = findingsFromGeometry(snapshot, "desktop", { strictTextLayout: true, sharinganSource: source } as any);
  assert.ok(!findings.some((f) => f.id === "visual-text-clipped"), "source-equivalent truncation should not block Sharingan repair");
});

test("findingsFromGeometry still flags clipped text when the generated box is smaller than the source", () => {
  const source = {
    viewport: { width: 1440, height: 900 },
    document: { width: 1440, height: 900 },
    elements: [
      { selector: "span.team", tag: "span", text: "Ben Lee's Team", box: { x: 1277, y: 22, w: 120, h: 20 }, style: { fontSize: "14px", lineHeight: "20px" } },
    ],
  };
  const snapshot = {
    viewport: { width: 1440, height: 900 },
    document: { scrollWidth: 1440, scrollHeight: 900 },
    elements: [
      geomEl({
        selector: "div.source-text",
        tag: "div",
        text: "Ben Lee's Team",
        rect: { left: 1277, top: 22, right: 1357, bottom: 42, width: 80, height: 20 },
        overflowX: "hidden",
        overflowY: "hidden",
        scrollWidth: 102,
        scrollHeight: 20,
        clientWidth: 80,
        clientHeight: 20,
        directTextLength: "Ben Lee's Team".length,
        childElementCount: 0,
      }),
    ],
  };

  const findings = findingsFromGeometry(snapshot, "desktop", { strictTextLayout: true, sharinganSource: source } as any);
  assert.equal(findings.find((f) => f.id === "visual-text-clipped")?.severity, "P1");
});

test("findingsFromGeometry flags a thin below-the-fold strip (orphaned element), not a long scrolling page", () => {
  const base = { elements: [] as never[], bodyTextLength: 500 };
  // A ~56px strip hanging below a 100svh app shell → orphaned-element bug.
  const strip = findingsFromGeometry({ ...base, viewport: { width: 1280, height: 800 }, document: { scrollWidth: 1280, scrollHeight: 856 } }, "desktop");
  assert.ok(strip.some((f) => f.id === "visual-below-fold-strip"));
  assert.match(strip.find((f) => f.id === "visual-below-fold-strip")!.message, /below the fold/i);
  // A genuinely long page (overflows by far more than one strip) is NOT flagged.
  const longPage = findingsFromGeometry({ ...base, viewport: { width: 1280, height: 800 }, document: { scrollWidth: 1280, scrollHeight: 3200 } }, "desktop");
  assert.ok(!longPage.some((f) => f.id === "visual-below-fold-strip"));
});

test("parseVisualReview splits objective defects from advisory improvements and marks the review", () => {
  const findings = parseVisualReview(
    JSON.stringify({
      findings: [
        { kind: "defect", severity: "P1", message: "The header overflows below the fold.", fix: "Fix the grid rows." },
        { kind: "improvement", severity: "P2", message: "Tighten the hero hierarchy: raise the headline, mute the subhead.", fix: "Adjust type scale." },
        { kind: "improvement", severity: "P2", message: "Give the sidebar rows more vertical rhythm.", fix: "Increase row padding." },
      ],
    }),
  );
  // No 0-100 score — just objective defects, advisory improvements, and a "reviewed" marker.
  const ids = findings.map((f) => f.id);
  assert.deepEqual(ids, ["visual-ai-review-1", "visual-improve-1", "visual-improve-2", "visual-reviewed"]);
  assert.equal(findings.find((f) => f.id === "visual-ai-review-1")!.severity, "P1");
  assert.equal(findings.filter((f) => f.id.startsWith("visual-improve")).length, 2);
  assert.ok(!findings.some((f) => /\/100/.test(f.message)), "no design score");
});

test("parseVisualReview treats Sharingan review output as required reconstruction findings", () => {
  const findings = parseVisualReview(
    JSON.stringify({
      findings: [
        { kind: "improvement", message: "The source active nav pill is missing.", fix: "Recreate the pill." },
        { kind: "improvement", message: "The composer icon and label are misaligned.", fix: "Align them to the source baseline." },
      ],
    }),
    { isSharingan: true },
  );

  assert.deepEqual(findings.map((f) => f.id), ["visual-ai-review-1", "visual-ai-review-2", "visual-reviewed"]);
  assert.equal(findings[0]?.severity, "P1");
  assert.ok(!findings.some((f) => f.id.startsWith("visual-improve")), "Sharingan must not create advisory visual-improve items");
});

test("parseVisualReview marks a clean review even with no findings", () => {
  const findings = parseVisualReview(JSON.stringify({ findings: [] }));
  assert.deepEqual(findings.map((f) => f.id), ["visual-reviewed"]);
});

test("parseVisualReview rejects a partially malformed model response as unreviewed", () => {
  const findings = parseVisualReview(
    JSON.stringify({
      findings: [
        { severity: "P1", message: "The CTA overlaps the pricing card.", fix: "Move the CTA below the card." },
        { severity: "P9", message: "ignored" },
      ],
    }),
  );

  assert.deepEqual(findings, []);
});

test("agentReviewPrompt supplies the direction and separates objective defects from advisory suggestions, with no score", () => {
  const input = {
    htmlPath: "/proj/index.html",
    projectRoot: "/proj",
    brief: "A calm, minimal AI chat UI",
    directionSpec: "# Console\n\n## Visual language\n- Near-monochrome base; quiet mono blocks.",
  } as unknown as VisualQaInput;
  const prompt = agentReviewPrompt(input, "/proj/.visual-qa/shot.png");
  // The chosen direction is supplied so explicit contradictions can become contract findings.
  assert.match(prompt, /Near-monochrome base/);
  assert.match(prompt, /CHOSEN DIRECTION/);
  // Defects are OBJECTIVE only; taste/palette is an advisory improvement, not a defect.
  assert.match(prompt, /OBJECTIVE/);
  assert.match(prompt, /ADVISORY/);
  assert.match(prompt, /taste, palette, or aesthetic preferences as defects/i);
  // No design score anywhere.
  assert.ok(!/designScore/.test(prompt), "prompt must not ask for a design score");
  assert.ok(!/\b0-100\b/.test(prompt), "prompt must not ask for a 0-100 rating");
});

test("agentReviewPrompt gates defects to provable pixel breakage and rejects inferred scroll causes", () => {
  const input = {
    htmlPath: "/proj/index.html",
    projectRoot: "/proj",
    brief: "A calm chat UI",
  } as unknown as VisualQaInput;
  const prompt = agentReviewPrompt(input, "/proj/.visual-qa/shot.png");
  // A defect must be PROVABLE from the pixels — a closed list, not open-ended judgement.
  assert.match(prompt, /prove from the pixels/i);
  // The falsifiability test: if a correct implementation could produce this same frame, it is not a defect.
  assert.match(prompt, /could a correct, deliberate implementation produce this exact screenshot/i);
  assert.match(prompt, /not a defect/i);
  // Describe the visible breakage, never an inferred runtime cause (the scroll false-positive class).
  assert.match(prompt, /do NOT file scroll position/i);
  // The capture contract matches the shared full-surface helper: normal document fullPage plus a
  // temporarily expanded dominant app-shell scroller, while smaller nested panes stay stateful.
  assert.match(prompt, /dominant vertical scroller/i);
  assert.match(prompt, /not limited to the initial viewport/i);
  assert.match(prompt, /smaller nested/i);
});

test("agentReviewPrompt adds a source-fidelity section when a Sharingan reference is present", () => {
  const input = {
    htmlPath: "/proj/index.html",
    projectRoot: "/proj",
    brief: "Rebuild the site",
    sharinganReference: { screenshotPath: "/proj/.sharingan/home-abcd1234/shot-desktop.png", assetsSummary: "6 images: hero (1200x400), logo (120x40)" },
  } as unknown as VisualQaInput;
  const prompt = agentReviewPrompt(input, "/proj/.visual-qa/shot.png");
  assert.match(prompt, /\.sharingan\/home-abcd1234\/shot-desktop\.png/); // the source screenshot, path relative to projectRoot
  assert.match(prompt, /source/i);
  assert.match(prompt, /reconstruc/i); // "reconstructing" / "reconstruction"
  assert.match(prompt, /6 images: hero/);
  assert.match(prompt, /required reconstruction/i);
  assert.doesNotMatch(prompt, /Sharingan reconstruction.*advisory improvement/i);
});

test("agentReviewPrompt includes the source render map when a Sharingan reference has one", () => {
  const input = {
    htmlPath: "/proj/index.html",
    projectRoot: "/proj",
    brief: "Rebuild the site",
    sharinganReference: {
      screenshotPath: "/proj/.sharingan/home-abcd1234/shot-desktop.png",
      renderMapPath: "/proj/.sharingan/home-abcd1234/render-map.json",
    },
  } as unknown as VisualQaInput;
  const prompt = agentReviewPrompt(input, "/proj/.visual-qa/shot.png");
  assert.match(prompt, /Source render map/i);
  assert.match(prompt, /\.sharingan\/home-abcd1234\/render-map\.json/);
  assert.match(prompt, /browser-measured|bounding boxes|source-vs-result/i);
});

test("sourceFidelityFindings reports missing source text and image-slot count drift", () => {
  const source = {
    viewport: { width: 1440, height: 900 },
    document: { width: 1440, height: 1600 },
    elements: [
      { selector: "h1.hero", tag: "h1", text: "Launch faster", box: { x: 80, y: 120, w: 520, h: 72 }, style: { fontSize: "64px", fontWeight: "700" } },
      { selector: "img.logo", tag: "img", text: "", box: { x: 80, y: 32, w: 120, h: 40 }, style: {} },
      { selector: ".hero-bg", tag: "div", text: "", box: { x: 0, y: 0, w: 1440, h: 420 }, style: { backgroundImage: "url(hero.png)" } },
      { selector: ".offscreen-bg", tag: "div", text: "", box: { x: -2000, y: 0, w: 320, h: 180 }, style: { backgroundImage: "url(offscreen.png)" } },
    ],
  };
  const generated = {
    viewport: { width: 1440, height: 900 },
    document: { width: 1440, height: 900 },
    elements: [
      { selector: "h1", tag: "h1", text: "Welcome", box: { x: 80, y: 120, w: 520, h: 72 }, position: "static", overflowX: "visible", overflowY: "visible", scrollWidth: 520, scrollHeight: 72, clientWidth: 520, clientHeight: 72 },
    ],
  } as any;
  const findings = sourceFidelityFindings(source as any, generated);
  assert.ok(findings.some((f) => f.id === "visual-source-text-missing" && /Launch faster/.test(f.message)));
  assert.ok(findings.some((f) => f.id === "visual-source-image-count" && /source has 2 visible/.test(f.message)));
  assert.ok(findings.every((f) => f.severity === "P1"), "source fidelity drift must gate Sharingan repair");
});

test("sourceFidelityFindings ignores CSS-only backgrounds and tiny carousel edge slivers", () => {
  const source = {
    viewport: { width: 1440, height: 900 },
    document: { width: 1440, height: 900 },
    elements: [
      { selector: ".grid-bg", tag: "div", text: "", box: { x: 0, y: 0, w: 1440, h: 900 }, style: { backgroundImage: "linear-gradient(rgba(0,0,0,.08) 1px, transparent 1px)" } },
      { selector: ".edge-card", tag: "img", text: "", box: { x: -430, y: 617, w: 456, h: 256 }, style: {}, src: "edge-card.png" },
      { selector: ".edge-title", tag: "span", text: "TapTV Arena全球AI动画黑客松·杭州站 正式启动", box: { x: -421, y: 869, w: 432, h: 20 }, style: {} },
    ],
  };
  const generated = {
    viewport: { width: 1440, height: 900 },
    document: { width: 1440, height: 900 },
    elements: [],
  } as any;

  const findings = sourceFidelityFindings(source as any, generated);
  assert.ok(!findings.some((f) => f.id === "visual-source-image-count"), "pure gradients and tiny edge sliver media are not source image slots");
  assert.ok(!findings.some((f) => f.id === "visual-source-text-missing"), "tiny edge sliver text should not be required as visible content");
  assert.ok(!findings.some((f) => f.id === "visual-source-box-delta"), "tiny edge sliver text should not be geometry matched");
});

test("sourceFidelityFindings counts overlapping video and image fallbacks as one media slot", () => {
  const source = {
    viewport: { width: 1440, height: 900 },
    document: { width: 1440, height: 900 },
    elements: [
      { selector: "video.card", tag: "video", text: "", box: { x: 80, y: 120, w: 456, h: 256 }, style: {} },
      { selector: "img.card-fallback", tag: "img", text: "", box: { x: 80, y: 120, w: 456, h: 256 }, style: {} },
      { selector: "video.card-2", tag: "video", text: "", box: { x: 560, y: 120, w: 456, h: 256 }, style: {} },
      { selector: "img.card-2-fallback", tag: "img", text: "", box: { x: 560, y: 120, w: 456, h: 256 }, style: {} },
      { selector: "video.card-3", tag: "video", text: "", box: { x: 80, y: 420, w: 456, h: 256 }, style: {} },
      { selector: "img.card-3-fallback", tag: "img", text: "", box: { x: 80, y: 420, w: 456, h: 256 }, style: {} },
    ],
  };
  const generated = {
    viewport: { width: 1440, height: 900 },
    document: { width: 1440, height: 900 },
    elements: [
      geomEl({
        selector: "img.card",
        tag: "img",
        text: "",
        rect: { left: 80, top: 120, right: 536, bottom: 376, width: 456, height: 256 },
      }),
      geomEl({
        selector: "img.card-2",
        tag: "img",
        text: "",
        rect: { left: 560, top: 120, right: 1016, bottom: 376, width: 456, height: 256 },
      }),
      geomEl({
        selector: "img.card-3",
        tag: "img",
        text: "",
        rect: { left: 80, top: 420, right: 536, bottom: 676, width: 456, height: 256 },
      }),
    ],
  } as any;

  const findings = sourceFidelityFindings(source as any, generated);
  assert.ok(!findings.some((f) => f.id === "visual-source-image-count"), "fallback media at the same visual box is one slot");
});

test("sourceFidelityFindings reports large measured box deltas for matched source text", () => {
  const source = {
    viewport: { width: 1440, height: 900 },
    document: { width: 1440, height: 900 },
    elements: [
      { selector: "h1.hero", tag: "h1", text: "Launch faster", box: { x: 80, y: 120, w: 520, h: 72 }, style: { fontSize: "64px", fontWeight: "700" } },
    ],
  };
  const generated = {
    viewport: { width: 1440, height: 900 },
    document: { width: 1440, height: 900 },
    elements: [
      { selector: "h1", tag: "h1", text: "Launch faster", rect: { left: 240, top: 300, right: 720, bottom: 350, width: 480, height: 50 }, position: "static", overflowX: "visible", overflowY: "visible", scrollWidth: 480, scrollHeight: 50, clientWidth: 480, clientHeight: 50 },
    ],
  } as any;
  const findings = sourceFidelityFindings(source as any, generated);
  const box = findings.find((f) => f.id === "visual-source-box-delta");
  assert.ok(box, "large position/size drift becomes a measured source-fidelity finding");
  assert.equal(box!.severity, "P1");
  assert.match(box!.fix, /x:80|y:120|520x72/);
});

test("sourceScreenshotDiffFindings reports large first-viewport pixel drift as a P1 Sharingan gate", () => {
  const root = mkdtempSync(join(tmpdir(), "dezin-visual-diff-"));
  const sourcePath = join(root, "source.png");
  const generatedPath = join(root, "generated.png");
  const black = Buffer.alloc(4 * 4 * 4);
  const white = Buffer.alloc(4 * 4 * 4);
  for (let i = 0; i < black.length; i += 4) {
    black[i] = 0; black[i + 1] = 0; black[i + 2] = 0; black[i + 3] = 255;
    white[i] = 255; white[i + 1] = 255; white[i + 2] = 255; white[i + 3] = 255;
  }
  writeFileSync(sourcePath, rgbaPng(4, 4, black));
  writeFileSync(generatedPath, rgbaPng(4, 4, white));

  const findings = sourceScreenshotDiffFindings(sourcePath, generatedPath);
  assert.equal(findings[0]?.id, "visual-source-screenshot-diff");
  assert.equal(findings[0]?.severity, "P1");
  assert.match(findings[0]?.message ?? "", /pixel|screenshot|source/i);
  assert.match(findings[0]?.fix ?? "", /visual regression|source screenshot/i);
});

test("sourceScreenshotDiffFindings detects equal-luminance hue drift", () => {
  const root = mkdtempSync(join(tmpdir(), "dezin-visual-hue-diff-"));
  const sourcePath = join(root, "source.png");
  const generatedPath = join(root, "generated.png");
  const red = Buffer.alloc(4 * 4 * 4);
  const equalLumaGreen = Buffer.alloc(4 * 4 * 4);
  for (let i = 0; i < red.length; i += 4) {
    red[i] = 255; red[i + 3] = 255;
    equalLumaGreen[i + 1] = 76; equalLumaGreen[i + 3] = 255;
  }
  writeFileSync(sourcePath, rgbaPng(4, 4, red));
  writeFileSync(generatedPath, rgbaPng(4, 4, equalLumaGreen));

  assert.equal(sourceScreenshotDiffFindings(sourcePath, generatedPath)[0]?.id, "visual-source-screenshot-diff");
});

test("sourceScreenshotDiffFindings detects equal-area width and height drift", () => {
  const root = mkdtempSync(join(tmpdir(), "dezin-visual-dimension-diff-"));
  const sourcePath = join(root, "source.png");
  const generatedPath = join(root, "generated.png");
  writeFileSync(sourcePath, rgbaPng(100, 100, Buffer.alloc(100 * 100 * 4, 255)));
  writeFileSync(generatedPath, rgbaPng(50, 200, Buffer.alloc(50 * 200 * 4, 255)));

  const finding = sourceScreenshotDiffFindings(sourcePath, generatedPath)[0];
  assert.equal(finding?.id, "visual-source-screenshot-diff");
  assert.match(finding?.message ?? "", /width|height|dimension/i);
});

test("sourceScreenshotDiffFindings blocks when explicitly supplied source evidence is missing or corrupt", () => {
  const root = mkdtempSync(join(tmpdir(), "dezin-visual-invalid-source-"));
  const generatedPath = join(root, "generated.png");
  const corruptSourcePath = join(root, "source.png");
  const pixels = Buffer.alloc(4 * 4 * 4, 255);
  writeFileSync(generatedPath, rgbaPng(4, 4, pixels));
  writeFileSync(corruptSourcePath, "not a png");

  const corrupt = sourceScreenshotDiffFindings(corruptSourcePath, generatedPath);
  const missing = sourceScreenshotDiffFindings(join(root, "missing.png"), generatedPath);
  assert.equal(corrupt[0]?.id, "visual-source-evidence-invalid");
  assert.equal(corrupt[0]?.severity, "P0");
  assert.equal(missing[0]?.id, "visual-source-evidence-invalid");
  assert.deepEqual(sourceScreenshotDiffFindings(undefined, generatedPath), [], "optional calls without a source path stay non-blocking");
});

test("sourceScreenshotDiffFindings blocks when explicitly supplied generated evidence is missing or corrupt", () => {
  const root = mkdtempSync(join(tmpdir(), "dezin-visual-invalid-generated-"));
  const sourcePath = join(root, "source.png");
  const corruptGeneratedPath = join(root, "generated.png");
  writeFileSync(sourcePath, rgbaPng(4, 4, Buffer.alloc(4 * 4 * 4, 255)));
  writeFileSync(corruptGeneratedPath, "not a png");

  const corrupt = sourceScreenshotDiffFindings(sourcePath, corruptGeneratedPath);
  const missing = sourceScreenshotDiffFindings(sourcePath, join(root, "missing.png"));
  assert.equal(corrupt[0]?.id, "visual-generated-evidence-invalid");
  assert.equal(corrupt[0]?.severity, "P0");
  assert.equal(missing[0]?.id, "visual-generated-evidence-invalid");
  assert.deepEqual(sourceScreenshotDiffFindings(sourcePath, undefined), [], "optional calls without a generated path stay non-blocking");
});

test("auditVisualArtifact fails closed with P0 when Sharingan render-map evidence is corrupt", async () => {
  const root = mkdtempSync(join(tmpdir(), "dezin-visual-corrupt-render-map-"));
  const htmlPath = join(root, "index.html");
  const sourcePath = join(root, "source.png");
  const renderMapPath = join(root, "render-map.json");
  writeFileSync(htmlPath, "<main>Generated clone</main>");
  writeFileSync(sourcePath, rgbaPng(4, 4, Buffer.alloc(4 * 4 * 4, 255)));
  writeFileSync(renderMapPath, JSON.stringify({ viewport: {}, document: {}, elements: "corrupt" }));

  const findings = await auditVisualArtifact({
    htmlPath,
    projectRoot: root,
    settings: { visualQaEnabled: true, agentCommand: "/usr/bin/true" } as any,
    agentCommand: "/usr/bin/true",
    isSharingan: true,
    sharinganReference: { screenshotPath: sourcePath, renderMapPath },
  });

  assert.equal(findings[0]?.id, "visual-source-evidence-invalid");
  assert.equal(findings[0]?.severity, "P0");
  assert.equal(findings.length, 1, "unverifiable source evidence stops the audit before generic review noise");
});

test("sourceFidelityFindings matches text to the specific generated element, not the root wrapper", () => {
  const source = {
    viewport: { width: 1440, height: 900 },
    document: { width: 1440, height: 900 },
    elements: [
      { selector: "h1.hero", tag: "h1", text: "Launch faster", box: { x: 80, y: 120, w: 520, h: 72 }, style: { fontSize: "64px", fontWeight: "700" } },
    ],
  };
  const generated = {
    viewport: { width: 1440, height: 900 },
    document: { width: 1440, height: 900 },
    elements: [
      { selector: "#root", tag: "div", text: "Launch faster", rect: { left: 0, top: 0, right: 1440, bottom: 900, width: 1440, height: 900 }, position: "static", overflowX: "visible", overflowY: "visible", scrollWidth: 1440, scrollHeight: 900, clientWidth: 1440, clientHeight: 900 },
      { selector: "h1", tag: "h1", text: "Launch faster", rect: { left: 80, top: 120, right: 600, bottom: 192, width: 520, height: 72 }, position: "static", overflowX: "visible", overflowY: "visible", scrollWidth: 520, scrollHeight: 72, clientWidth: 520, clientHeight: 72 },
    ],
  } as any;
  const findings = sourceFidelityFindings(source as any, generated);
  assert.ok(!findings.some((f) => f.id === "visual-source-box-delta"), "root wrapper must not cause a false measured delta");
});

test("sourceFidelityFindings ignores aggregate container text when child text is present", () => {
  const source = {
    viewport: { width: 1440, height: 900 },
    document: { width: 1440, height: 900 },
    elements: [
      { selector: "header", tag: "div", text: "TapNow Home Workspace", box: { x: 0, y: 0, w: 1440, h: 64 }, style: {} },
      { selector: "span.logo", tag: "span", text: "TapNow", box: { x: 80, y: 22, w: 64, h: 20 }, style: {} },
      { selector: "a.home", tag: "a", text: "Home", box: { x: 600, y: 22, w: 48, h: 20 }, style: {} },
      { selector: "a.workspace", tag: "a", text: "Workspace", box: { x: 670, y: 22, w: 96, h: 20 }, style: {} },
    ],
  };
  const generated = {
    viewport: { width: 1440, height: 900 },
    document: { width: 1440, height: 900 },
    elements: [
      { selector: "span.logo", tag: "span", text: "TapNow", rect: { left: 80, top: 22, right: 144, bottom: 42, width: 64, height: 20 }, position: "static", overflowX: "visible", overflowY: "visible", scrollWidth: 64, scrollHeight: 20, clientWidth: 64, clientHeight: 20 },
      { selector: "a.home", tag: "a", text: "Home", rect: { left: 600, top: 22, right: 648, bottom: 42, width: 48, height: 20 }, position: "static", overflowX: "visible", overflowY: "visible", scrollWidth: 48, scrollHeight: 20, clientWidth: 48, clientHeight: 20 },
      { selector: "a.workspace", tag: "a", text: "Workspace", rect: { left: 670, top: 22, right: 766, bottom: 42, width: 96, height: 20 }, position: "static", overflowX: "visible", overflowY: "visible", scrollWidth: 96, scrollHeight: 20, clientWidth: 96, clientHeight: 20 },
    ],
  } as any;
  const findings = sourceFidelityFindings(source as any, generated);
  assert.ok(!findings.some((f) => f.id === "visual-source-text-missing"), "aggregate parent text should not be required verbatim");
  assert.ok(!findings.some((f) => f.id === "visual-source-box-delta"), "aggregate parent box should not be matched to a child");
});

test("sourceFidelityFindings ignores a same-text parent when a smaller child carries the text", () => {
  const source = {
    viewport: { width: 1440, height: 900 },
    document: { width: 1440, height: 900 },
    elements: [
      { selector: "div.logo-wrap", tag: "div", text: "TapNow", box: { x: 16, y: 0, w: 466, h: 64 }, style: {} },
      { selector: "h2.logo", tag: "h2", text: "TapNow", box: { x: 84, y: 23, w: 62, h: 18 }, style: {} },
    ],
  };
  const generated = {
    viewport: { width: 1440, height: 900 },
    document: { width: 1440, height: 900 },
    elements: [
      { selector: "h2.logo", tag: "h2", text: "TapNow", rect: { left: 84, top: 23, right: 146, bottom: 41, width: 62, height: 18 }, position: "static", overflowX: "visible", overflowY: "visible", scrollWidth: 62, scrollHeight: 18, clientWidth: 62, clientHeight: 18 },
    ],
  } as any;
  const findings = sourceFidelityFindings(source as any, generated);
  assert.ok(!findings.some((f) => f.id === "visual-source-box-delta"), "same-text parent should not be matched instead of the child");
});

test("sourceFidelityFindings ignores trailing cursor markers in captured source text", () => {
  const source = {
    viewport: { width: 1440, height: 900 },
    document: { width: 1440, height: 900 },
    elements: [
      { selector: "textarea.prompt", tag: "textarea", text: "帮我记住我的创_", box: { x: 494, y: 418, w: 220, h: 20 }, style: {} },
    ],
  };
  const generated = {
    viewport: { width: 1440, height: 900 },
    document: { width: 1440, height: 900 },
    elements: [
      { selector: ".source-text", tag: "div", text: "帮我记住我的创", rect: { left: 494, top: 418, right: 714, bottom: 438, width: 220, height: 20 }, position: "static", overflowX: "visible", overflowY: "visible", scrollWidth: 220, scrollHeight: 20, clientWidth: 220, clientHeight: 20 },
    ],
  } as any;
  const findings = sourceFidelityFindings(source as any, generated);
  assert.ok(!findings.some((f) => f.id === "visual-source-text-missing"), "cursor marker is not source content");
});

test("sourceFidelityFindings matches repeated source text by nearest measured geometry", () => {
  const source = {
    viewport: { width: 1440, height: 900 },
    document: { width: 1440, height: 900 },
    elements: [
      { selector: "span.card-a", tag: "span", text: "Untitled", box: { x: 536, y: 439, w: 44, h: 18 }, style: {} },
      { selector: "span.card-b", tag: "span", text: "Untitled", box: { x: 733, y: 439, w: 44, h: 18 }, style: {} },
    ],
  };
  const generated = {
    viewport: { width: 1440, height: 900 },
    document: { width: 1440, height: 900 },
    elements: [
      { selector: ".source-text-a", tag: "div", text: "Untitled", rect: { left: 536, top: 439, right: 580, bottom: 457, width: 44, height: 18 }, position: "static", overflowX: "visible", overflowY: "visible", scrollWidth: 44, scrollHeight: 18, clientWidth: 44, clientHeight: 18 },
      { selector: ".source-text-b", tag: "div", text: "Untitled", rect: { left: 733, top: 439, right: 777, bottom: 457, width: 44, height: 18 }, position: "static", overflowX: "visible", overflowY: "visible", scrollWidth: 44, scrollHeight: 18, clientWidth: 44, clientHeight: 18 },
    ],
  } as any;
  const findings = sourceFidelityFindings(source as any, generated);
  assert.ok(!findings.some((f) => f.id === "visual-source-box-delta"), "duplicate labels should match their nearest generated counterpart");
});

test("agentReviewPrompt has no source-fidelity section for a normal (non-Sharingan) build", () => {
  const input = { htmlPath: "/proj/index.html", projectRoot: "/proj", brief: "A chat UI" } as unknown as VisualQaInput;
  const prompt = agentReviewPrompt(input, "/proj/.visual-qa/shot.png");
  assert.ok(!/Source screenshot/i.test(prompt), "no fidelity section without a reference");
});

test("reviewWithRetry retries once when a pass produced no review at all, and keeps the reviewed pass", async () => {
  const reviewed = parseVisualReview(JSON.stringify({ findings: [] }));
  let calls = 0;
  const findings = await reviewWithRetry(async () => {
    calls += 1;
    return calls === 1 ? [] : reviewed; // unparseable first, a real review on retry
  });
  assert.equal(calls, 2);
  assert.ok(findings.some((f) => f.id === "visual-reviewed"));
});

test("reviewWithRetry does not retry when the first pass already produced a review (even a clean one)", async () => {
  const reviewed = parseVisualReview(JSON.stringify({ findings: [] }));
  let calls = 0;
  const findings = await reviewWithRetry(async () => {
    calls += 1;
    return reviewed;
  });
  assert.equal(calls, 1);
  assert.ok(findings.some((f) => f.id === "visual-reviewed"));
});

test("agentReviewPrompt lists on-page selectors and asks the critic to anchor each finding to one", () => {
  const input = {
    htmlPath: "/proj/index.html",
    projectRoot: "/proj",
    brief: "A chat UI",
    criticElements: [
      { selector: ".btn-send", tag: "button", text: "Send", w: 64, h: 32, x: 1100, y: 720 },
      { selector: "#sidebar", tag: "aside", text: "", w: 240, h: 800, x: 0, y: 0 },
    ],
  } as unknown as VisualQaInput;
  const prompt = agentReviewPrompt(input, "/proj/.visual-qa/shot.png");
  assert.match(prompt, /ON-PAGE ELEMENTS/);
  assert.match(prompt, /\.btn-send — button "Send"/);
  assert.match(prompt, /set "selector"/i);
  assert.match(prompt, /"selector":"exact selector or omit"/);
});

test("parseVisualReview anchors a finding to the selector the critic returned", () => {
  const findings = parseVisualReview(
    JSON.stringify({
      findings: [{ kind: "improvement", severity: "P2", selector: ".btn-send", message: "Send has redundant text + arrow.", fix: "Drop the arrow icon." }],
    }),
  );
  const imp = findings.find((f) => f.id.startsWith("visual-improve"))!;
  assert.equal(imp.selector, ".btn-send");
});

test("auditVisualArtifact is disabled by settings", async () => {
  const findings = await auditVisualArtifact({
    htmlPath: "/does/not/exist/index.html",
    settings: {
      agentCommand: "claude",
      model: "",
      apiBaseUrl: "",
      apiKey: "",
      defaultDesignSystemId: "modern-minimal",
      customInstructions: "",
      imageApiBaseUrl: "",
      imageApiKey: "",
      imageModel: "",
      removeBackgroundModel: "",
      editRegionModel: "",
      extractLayerModel: "",
      videoApiBaseUrl: "",
      videoApiKey: "",
      videoModel: "",
      aiProviderId: "openai",
      aiProviderEnabled: false,
      aiProviderModels: "gpt-image-1",
      aiProviderOrganization: "",
      aiProviderProfiles: "",
      visualQaEnabled: false,
      autoFixLiveRuntimeErrors: false,
      sharinganAffirmed: false,
      researchEnabled: false, researchAgentCommand: "", researchModel: "",      visualQaAgentCommand: "",
      visualQaModel: "",
      autoImproveEnabled: true,
      autoImproveMaxRounds: 8,
    },
  });
  assert.deepEqual(findings, []);
});

test("auditVisualArtifact discards a stale screenshot before a failed render", async () => {
  const root = mkdtempSync(join(tmpdir(), "dezin-visual-stale-shot-"));
  const htmlPath = join(root, "index.html");
  const screenshotPath = join(root, ".visual-qa", "screenshot.png");
  mkdirSync(join(root, ".visual-qa"), { recursive: true });
  writeFileSync(htmlPath, "<main>Current artifact content that must fail to render.</main>", "utf8");
  writeFileSync(screenshotPath, Buffer.from("stale screenshot from an earlier audit"));

  const findings = await auditVisualArtifact({
    htmlPath,
    projectRoot: root,
    screenshotPath,
    renderUrl: "file:///this-path-must-not-exist/dezin-visual-qa.html",
    settings: { visualQaEnabled: true, agentCommand: "/usr/bin/true" } as any,
    agentCommand: "/usr/bin/true",
  });

  assert.ok(findings.some((finding) => finding.id === "visual-render-failed"));
  assert.ok(findings.some((finding) => finding.id === "visual-screenshot-missing"));
  assert.ok(!findings.some((finding) => finding.id === "visual-reviewed" || finding.id === "visual-review-unassessed"));
  assert.equal(existsSync(screenshotPath), false, "failed capture must not leave the prior audit screenshot available for evidence persistence");
});

test("auditVisualArtifact limits Sharingan geometry QA to the captured source viewport", async () => {
  const root = mkdtempSync(join(tmpdir(), "dezin-sharingan-source-viewport-"));
  const htmlPath = join(root, "index.html");
  const renderMapPath = join(root, "render-map.json");
  writeFileSync(
    htmlPath,
    [
      "<html><head><style>",
      "html,body{margin:0;width:100%;height:900px;overflow:hidden;background:#111;color:#fff;font:16px/24px system-ui;}",
      "main{height:900px;display:flex;align-items:center;justify-content:center;}",
      "</style></head><body><main>Clone page content for Sharingan viewport QA.</main></body></html>",
    ].join(""),
  );
  writeFileSync(
    renderMapPath,
    JSON.stringify({
      viewport: { width: 1440, height: 900 },
      document: { width: 1440, height: 900 },
      elements: [
        { selector: "main", tag: "main", text: "Clone page content for Sharingan viewport QA.", box: { x: 0, y: 0, w: 1440, h: 900 }, style: {} },
      ],
    }),
  );

  const findings = await auditVisualArtifact({
    htmlPath,
    projectRoot: root,
    settings: { visualQaEnabled: true, agentCommand: "/usr/bin/true" } as any,
    agentCommand: "/usr/bin/true",
    isSharingan: true,
    sharinganReference: { screenshotPath: join(root, "missing-source.png"), renderMapPath },
  });

  assert.ok(!findings.some((f) => f.id === "visual-below-fold-strip" && /mobile/i.test(f.message)), "desktop-only source capture should not trigger synthetic mobile repairs");
});

test("auditVisualArtifact full-page screenshot expands an inner app-shell scroller", async () => {
  const root = mkdtempSync(join(tmpdir(), "dezin-visual-inner-scroll-"));
  const htmlPath = join(root, "index.html");
  const screenshotPath = join(root, ".visual-qa", "screenshot.png");
  const sourcePath = join(root, "source.png");
  const renderMapPath = join(root, "render-map.json");
  writeFileSync(sourcePath, rgbaPng(4, 4, Buffer.alloc(4 * 4 * 4, 255)));
  writeFileSync(renderMapPath, JSON.stringify({
    viewport: { width: 1440, height: 900 },
    document: { width: 1440, height: 1800 },
    elements: [{ selector: "body", tag: "body", text: "", box: { x: 0, y: 0, w: 1440, h: 1800 }, style: {} }],
  }));
  writeFileSync(
    htmlPath,
    [
      "<html><head><style>",
      "html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#111;color:#fff}",
      "#app{height:100%;overflow:hidden}#feed{height:100%;overflow-y:auto}",
      "#content{height:1800px;padding:20px;box-sizing:border-box}",
      "</style></head><body><div id='app'><main id='feed'><div id='content'>Tall generated content with enough real text to paint.<div style='margin-top:1650px'>Bottom marker</div></div></main></div></body></html>",
    ].join(""),
  );

  await auditVisualArtifact({
    htmlPath,
    projectRoot: root,
    screenshotPath,
    settings: { visualQaEnabled: true, agentCommand: "/usr/bin/true" } as any,
    agentCommand: "/usr/bin/true",
    isSharingan: true,
    sharinganReference: { screenshotPath: sourcePath, renderMapPath },
  });

  const screenshot = readFileSync(screenshotPath);
  assert.ok(screenshot.readUInt32BE(20) >= 1750, "generated QA screenshot uses the same inner-scroller expansion as source capture");
});

test("reviewScreenshotWithAgent reports when screenshot capture never happened", async () => {
  const root = mkdtempSync(join(tmpdir(), "dezin-visual-missing-shot-"));
  writeFileSync(join(root, "index.html"), "<h1>Pricing</h1>", "utf8");
  const findings = await reviewScreenshotWithAgent(
    {
      htmlPath: join(root, "index.html"),
      settings: {
        agentCommand: "agent-that-should-not-run",
        model: "",
        apiBaseUrl: "",
        apiKey: "",
        defaultDesignSystemId: "modern-minimal",
        customInstructions: "",
        imageApiBaseUrl: "",
        imageApiKey: "",
        imageModel: "",
        removeBackgroundModel: "",
        editRegionModel: "",
        extractLayerModel: "",
        videoApiBaseUrl: "",
        videoApiKey: "",
        videoModel: "",
        aiProviderId: "openai",
        aiProviderEnabled: false,
        aiProviderModels: "gpt-image-1",
        aiProviderOrganization: "",
        aiProviderProfiles: "",
        visualQaEnabled: true,
        autoFixLiveRuntimeErrors: false,
        sharinganAffirmed: false,
        researchEnabled: false, researchAgentCommand: "", researchModel: "",        visualQaAgentCommand: "",
        visualQaModel: "",
        autoImproveEnabled: true,
        autoImproveMaxRounds: 8,
      },
    },
    join(root, ".visual-qa", "screenshot.png"),
  );
  assert.equal(findings[0]?.id, "visual-screenshot-missing");
  assert.equal(findings[0]?.screenshotPath, ".visual-qa/screenshot.png");
  assert.match(findings[0]?.reviewSummary ?? "", /could not run/i);
});

test("reviewScreenshotWithAgent runs in the project directory with artifact and screenshot context", async () => {
  const root = mkdtempSync(join(tmpdir(), "dezin-visual-review-"));
  const screenshot = join(root, ".visual-qa", "screenshot.png");
  const callsFile = join(root, "calls.json");
  const agent = join(root, "agent.js");
  mkdirSync(join(root, ".visual-qa"), { recursive: true });
  writeFileSync(join(root, "index.html"), "<h1>Pricing</h1>", "utf8");
  writeFileSync(screenshot, Buffer.from([1, 2, 3, 4]));
  writeFileSync(
    agent,
    `#!/usr/bin/env node
const fs = require("fs");
fs.writeFileSync(${JSON.stringify(callsFile)}, JSON.stringify({
  cwd: process.cwd(),
  args: process.argv.slice(2),
  hasArtifact: fs.existsSync("index.html"),
  hasScreenshot: fs.existsSync(".visual-qa/screenshot.png")
}));
console.log(JSON.stringify({ findings: [{ kind: "defect", severity: "P1", message: "Text clips.", fix: "Allow wrapping." }] }));
`,
    { mode: 0o755 },
  );

  const findings = await reviewScreenshotWithAgent(
    {
      htmlPath: join(root, "index.html"),
      settings: {
        agentCommand: agent,
        model: "",
        apiBaseUrl: "",
        apiKey: "",
        defaultDesignSystemId: "modern-minimal",
        customInstructions: "",
        imageApiBaseUrl: "",
        imageApiKey: "",
        imageModel: "",
        removeBackgroundModel: "",
        editRegionModel: "",
        extractLayerModel: "",
        videoApiBaseUrl: "",
        videoApiKey: "",
        videoModel: "",
        aiProviderId: "openai",
        aiProviderEnabled: false,
        aiProviderModels: "gpt-image-1",
        aiProviderOrganization: "",
        aiProviderProfiles: "",
        visualQaEnabled: true,
        autoFixLiveRuntimeErrors: false,
        sharinganAffirmed: false,
        researchEnabled: false, researchAgentCommand: "", researchModel: "",        visualQaAgentCommand: "",
        visualQaModel: "",
        autoImproveEnabled: true,
        autoImproveMaxRounds: 8,
      },
      brief: "make a pricing page",
      conversationHistory: [
        { role: "user", content: "Use the existing three-column pricing direction." },
        { role: "assistant", content: "I made the first draft with pricing tiers." },
        { role: "user", content: "Keep the pricing cards aligned on mobile." },
        { role: "assistant", content: "Updated the spacing and card grid." },
        { role: "user", content: "Make the CTA visible above the fold." },
        { role: "assistant", content: "Moved the CTA into the hero." },
        { role: "user", content: "Use compact enterprise copy." },
        { role: "assistant", content: "Shortened the enterprise tier." },
        { role: "user", content: "Keep the comparison table readable." },
        { role: "assistant", content: "Adjusted the comparison table columns." },
      ],
      consoleMessages: [
        {
          type: "pageerror",
          level: "error",
          text: "ReferenceError: OGL is not defined",
          url: "http://127.0.0.1:5173/src/App.jsx",
          line: 42,
        },
        {
          type: "requestfailed",
          level: "error",
          text: "GET /assets/hero.webp net::ERR_FILE_NOT_FOUND",
        },
      ],
    },
    screenshot,
  );

  const call = JSON.parse(readFileSync(callsFile, "utf8")) as { cwd: string; args: string[]; hasArtifact: boolean; hasScreenshot: boolean };
  assert.equal(call.cwd, realpathSync(root));
  assert.equal(call.hasArtifact, true);
  assert.equal(call.hasScreenshot, true);
  const prompt = call.args.join(" ");
  assert.match(prompt, /Final artifact: index.html/);
  assert.match(prompt, /Rendered screenshot.*\.visual-qa\/screenshot\.png/);
  assert.match(prompt, /Current conversation context/);
  assert.match(prompt, /Use the existing three-column pricing direction/);
  assert.match(prompt, /Adjusted the comparison table columns/);
  assert.match(prompt, /USER BRIEF:/);
  assert.match(prompt, /make a pricing page/);
  assert.match(prompt, /Browser console \/ runtime signals/);
  assert.match(prompt, /ReferenceError: OGL is not defined/);
  assert.match(prompt, /hero\.webp/);
  assert.equal(findings[0]?.id, "visual-ai-review-1");
  assert.equal(findings[0]?.message, "Text clips.");
  assert.equal(findings[0]?.screenshotPath, ".visual-qa/screenshot.png");
  assert.match(findings[0]?.reviewSummary ?? "", /1 issue/i);
});

test("reviewScreenshotWithAgent rejects valid-looking stdout from a failed critic process", async () => {
  const root = mkdtempSync(join(tmpdir(), "dezin-visual-review-exit-"));
  const screenshot = join(root, ".visual-qa", "screenshot.png");
  const agent = join(root, "failed-agent.js");
  mkdirSync(join(root, ".visual-qa"), { recursive: true });
  writeFileSync(join(root, "index.html"), "<h1>Pricing</h1>", "utf8");
  writeFileSync(screenshot, Buffer.from([1, 2, 3, 4]));
  writeFileSync(
    agent,
    `#!/usr/bin/env node
console.log(JSON.stringify({ findings: [{ kind: "defect", severity: "P1", message: "Looks valid.", fix: "But process failed." }] }));
process.exit(7);
`,
    { mode: 0o755 },
  );

  const findings = await reviewScreenshotWithAgent(
    {
      htmlPath: join(root, "index.html"),
      settings: {
        agentCommand: agent,
        model: "",
        apiBaseUrl: "",
        apiKey: "",
        defaultDesignSystemId: "modern-minimal",
        customInstructions: "",
        imageApiBaseUrl: "",
        imageApiKey: "",
        imageModel: "",
        removeBackgroundModel: "",
        editRegionModel: "",
        extractLayerModel: "",
        videoApiBaseUrl: "",
        videoApiKey: "",
        videoModel: "",
        aiProviderId: "openai",
        aiProviderEnabled: false,
        aiProviderModels: "gpt-image-1",
        aiProviderOrganization: "",
        aiProviderProfiles: "",
        visualQaEnabled: true,
        autoFixLiveRuntimeErrors: false,
        sharinganAffirmed: false,
        researchEnabled: false,
        researchAgentCommand: "",
        researchModel: "",
        visualQaAgentCommand: "",
        visualQaModel: "",
        autoImproveEnabled: false,
        autoImproveMaxRounds: 0,
      },
    },
    screenshot,
  );

  assert.equal(findings[0]?.id, "visual-agent-review-failed");
  assert.ok(!findings.some((finding) => finding.id === "visual-reviewed"));
});
