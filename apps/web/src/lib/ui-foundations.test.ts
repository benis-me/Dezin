import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "vitest";

import {
  agentAvailabilityReason,
  normalizeAgentModel,
  selectableAgents,
} from "./agent-availability.ts";
import {
  groupTokens,
  isColor,
  parseTokens,
  previewTokensCss,
  scopedTokens,
  tokenScope,
} from "./ds-tokens.ts";
import type { AgentInfo } from "./api.ts";

function agent(overrides: Partial<AgentInfo> = {}): AgentInfo {
  return {
    id: "codex",
    command: "codex",
    available: false,
    availability: "not-installed",
    models: ["gpt-5"],
    ...overrides,
  };
}

test("the web shell uses self-hosted Fontsource assets without remote font origins", () => {
  const html = readFileSync(resolve(process.cwd(), "index.html"), "utf8");
  const main = readFileSync(resolve(process.cwd(), "src/main.tsx"), "utf8");
  expect(html).not.toMatch(/fonts\.(?:googleapis|gstatic)\.com|https?:\/\//i);
  expect(main).toMatch(/@fontsource-variable\/geist/);
  expect(main).toMatch(/@fontsource-variable\/geist-mono/);
});

test("manual light and dark themes expose their color scheme to native controls", () => {
  const css = readFileSync(resolve(process.cwd(), "src/styles/globals.css"), "utf8");
  expect(css).toMatch(/:root\s*\{[^}]*color-scheme:\s*light;/s);
  expect(css).toMatch(/\.dark\s*\{[^}]*color-scheme:\s*dark;/s);
});

test("Agent availability explains every selectable runtime state", () => {
  expect(agentAvailabilityReason(undefined)).toBe("Choose an available Agent.");
  expect(agentAvailabilityReason(agent({ available: true, availability: "ready" }))).toBeNull();
  expect(agentAvailabilityReason(agent({ unavailableReason: "  Sign in first.  " }))).toBe("Sign in first.");
  expect(agentAvailabilityReason(agent({ id: "codebuddy", availability: "authentication-required" }))).toMatch(/CodeBuddy/);
  expect(agentAvailabilityReason(agent({ availability: "authentication-required" }))).toMatch(/this Agent/);
  expect(agentAvailabilityReason(agent({ availability: "verification-required" }))).toMatch(/couldn't be verified/);
  expect(agentAvailabilityReason(agent())).toMatch(/not found/);

  const ready = agent({ id: "ready", available: true, availability: "ready" });
  const auth = agent({ id: "auth", availability: "authentication-required" });
  const verify = agent({ id: "verify", availability: "verification-required" });
  expect(selectableAgents([ready, auth, verify, agent({ id: "missing" })]).map((item) => item.id)).toEqual([
    "ready",
    "auth",
    "verify",
  ]);
  expect(normalizeAgentModel(ready, "gpt-5")).toBe("gpt-5");
  expect(normalizeAgentModel(ready, "unknown")).toBe("");
  expect(normalizeAgentModel(auth, "gpt-5")).toBe("");
  expect(normalizeAgentModel(undefined, "gpt-5")).toBe("");
});

test("Design token helpers preserve scoped values and semantic groups", () => {
  const css = `:root {
    --accent: #3366ff;
    --surface: oklch(0.98 0 0);
    --space-4: 16px;
    --space-1: 4px;
    --space-fluid: clamp(8px, 2vw, 16px);
    --radius: 8px;
    --font-display: "Geist Variable", sans-serif;
    --font-body: 'Inter', sans-serif;
    --font-mono: Geist Mono, monospace;
  }`;
  expect(parseTokens(css)).toHaveLength(9);
  expect(parseTokens("body {}" )).toEqual([]);
  expect(scopedTokens(css, "preview")).toMatch(/^\.preview\s*\{/);
  expect(scopedTokens("body {}", "preview")).toBe("");
  expect(tokenScope("Brand / 01_é")).toBe("ds-canvas-Brand01");
  expect(["#fff", "oklch(1 0 0)", "rgb(0 0 0)", "hsl(0 0% 0%)"].every(isColor)).toBe(true);
  expect(isColor("16px")).toBe(false);

  const grouped = groupTokens(css);
  expect(grouped.colors.map((token) => token.name)).toEqual(["accent", "surface"]);
  expect(grouped.spacing.map((token) => token.name)).toEqual(["space-1", "space-4"]);
  expect(grouped.radii.map((token) => token.name)).toEqual(["radius"]);
  expect(grouped.fonts).toEqual({ display: "Geist Variable", body: "Inter", mono: "Geist Mono" });
  expect(grouped.find("accent")).toBe("#3366ff");
  expect(grouped.find("missing")).toBeUndefined();
});

test("preview token CSS chooses readable accent text and bounded font fallbacks", () => {
  const bright = previewTokensCss({ accent: "ffffff", display: "  ", body: "" });
  expect(bright).toContain("--accent: #ffffff; --accent-fg: #0a0a0a");
  expect(bright).toContain('--font-display: "Inter"');
  expect(bright).toContain('--font-body: "Inter"');

  const dark = previewTokensCss({ accent: "#111111", display: "Geist", body: "Source Sans 3" });
  expect(dark).toContain("--accent-fg: #ffffff");
  expect(dark).toContain('--font-body: "Source Sans 3"');

  const short = previewTokensCss({ accent: "fff", display: "Geist", body: "" });
  expect(short).toContain("--accent: #fff; --accent-fg: #ffffff");
  expect(short).toContain('--font-body: "Geist"');
});
