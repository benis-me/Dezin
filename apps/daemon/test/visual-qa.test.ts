import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentReviewPrompt, auditVisualArtifact, boundComputedFindings, findingsFromGeometry, parseVisualReview, reviewScreenshotWithAgent, reviewWithRetry, toComputedElements, type GeometryElement, type VisualQaInput } from "../src/visual-qa.ts";
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
  assert.match(findings.find((f) => f.id === "visual-text-clipped")!.fix, /wrapping|height|container/i);
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

test("parseVisualReview marks a clean review even with no findings", () => {
  const findings = parseVisualReview(JSON.stringify({ findings: [] }));
  assert.deepEqual(findings.map((f) => f.id), ["visual-reviewed"]);
});

test("parseVisualReview normalizes model-returned findings", () => {
  const findings = parseVisualReview(
    JSON.stringify({
      findings: [
        { severity: "P1", message: "The CTA overlaps the pricing card.", fix: "Move the CTA below the card." },
        { severity: "P9", message: "ignored" },
      ],
    }),
  );

  assert.equal(findings.filter((f) => f.id.startsWith("visual-ai-review")).length, 1);
  assert.equal(findings[0]?.id, "visual-ai-review-1");
  assert.equal(findings[0]?.severity, "P1");
  assert.match(findings[0]?.message ?? "", /CTA overlaps/);
});

test("agentReviewPrompt supplies the direction and separates objective defects from advisory suggestions, with no score", () => {
  const input = {
    htmlPath: "/proj/index.html",
    projectRoot: "/proj",
    brief: "A calm, minimal AI chat UI",
    directionSpec: "# Console\n\n## Visual language\n- Near-monochrome base; quiet mono blocks.",
  } as unknown as VisualQaInput;
  const prompt = agentReviewPrompt(input, "/proj/.visual-qa/shot.png");
  // The chosen direction is supplied so the critic can reference it — as ADVISORY suggestions.
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
  // The capture is described honestly — no false unconditional "full page" claim, and content that is
  // merely scrolled out of view is explicitly NORMAL, not missing.
  assert.ok(!/full page, top to bottom/i.test(prompt), "must not claim an unconditional full-page capture");
  assert.match(prompt, /scrolled out of view/i);
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
      researchEnabled: false,      visualQaAgentCommand: "",
      visualQaModel: "",
      autoImproveEnabled: true,
      autoImproveMaxRounds: 8,
    },
  });
  assert.deepEqual(findings, []);
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
        researchEnabled: false,        visualQaAgentCommand: "",
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
        researchEnabled: false,        visualQaAgentCommand: "",
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
