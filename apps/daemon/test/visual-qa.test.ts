import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { auditVisualArtifact, findingsFromGeometry, parseVisualReview, reviewScreenshotWithAgent } from "../src/visual-qa.ts";

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
    ["visual-horizontal-overflow", "visual-fixed-offscreen", "visual-text-clipped"],
  );
  assert.match(findings[0]!.message, /mobile/i);
  assert.match(findings[1]!.snippet ?? "", /header \.menu/);
  assert.match(findings[2]!.fix, /wrapping|height|container/i);
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

  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.id, "visual-ai-review-1");
  assert.equal(findings[0]?.severity, "P1");
  assert.match(findings[0]?.message ?? "", /CTA overlaps/);
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
console.log(JSON.stringify({ findings: [{ severity: "P2", message: "Text clips.", fix: "Allow wrapping." }] }));
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
  assert.match(prompt, /Rendered screenshot: \.visual-qa\/screenshot\.png/);
  assert.match(prompt, /Current conversation context/);
  assert.match(prompt, /Use the existing three-column pricing direction/);
  assert.match(prompt, /Adjusted the comparison table columns/);
  assert.match(prompt, /Current user request:\s*USER: make a pricing page/);
  assert.match(prompt, /Browser console \/ runtime signals/);
  assert.match(prompt, /ReferenceError: OGL is not defined/);
  assert.match(prompt, /hero\.webp/);
  assert.equal(findings[0]?.id, "visual-ai-review-1");
  assert.equal(findings[0]?.message, "Text clips.");
  assert.equal(findings[0]?.screenshotPath, ".visual-qa/screenshot.png");
  assert.match(findings[0]?.reviewSummary ?? "", /1 issue/i);
});
