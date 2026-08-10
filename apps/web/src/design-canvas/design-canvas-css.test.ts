import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";

const css = readFileSync(join(process.cwd(), "src/design-canvas/design-canvas.css"), "utf8");
const conversationCss = readFileSync(join(process.cwd(), "src/components/agent-conversation.css"), "utf8");

test("Design Canvas CSS consumes full-color tokens without invalid hsl wrappers", () => {
  expect(css).not.toContain("hsl(var(--");
  expect(css).toContain("var(--background)");
  expect(css).toContain("color-mix(in oklch");
});

test("Design Canvas owns the full shell flex slot", () => {
  expect(css).toMatch(
    /\.design-canvas-root\s*\{[^}]*width:\s*100%;[^}]*min-width:\s*0;[^}]*flex:\s*1 1 auto;/s,
  );
});

test("Design Canvas keeps native titlebar and floating feedback geometry stable", () => {
  expect(css).toMatch(/\.design-canvas-topbar\s*\{[^}]*z-index:\s*50;[^}]*height:\s*36px\s*!important;[^}]*min-height:\s*36px\s*!important;/s);
  expect(css).toMatch(/\.design-canvas-focus-back\s*\{[^}]*z-index:\s*52;[^}]*top:\s*48px;/s);
  expect(css).toMatch(/\.design-canvas-agent__composer\s*\{[^}]*position:\s*relative;/s);
  expect(css).toMatch(/\.design-canvas-agent__composer-notice\s*\{[^}]*position:\s*absolute;/s);
});

test("selected and keyboard-focused Nodes use a gap outline with discoverable corner brackets", () => {
  expect(css).toMatch(/\.design-canvas-node::after\s*\{[^}]*inset:\s*-3px;[^}]*border-radius:\s*14px;/s);
  expect(css).toMatch(/\.design-canvas-node--selected::after\s*\{[^}]*border-color:/s);
  expect(css).toMatch(/\.react-flow__node:focus-visible\s+\.design-canvas-node::after\s*\{[^}]*border-color:[^}]*box-shadow:/s);
  expect(css).toMatch(/\.design-canvas-node__resize-corner\s*\{[^}]*opacity:\s*0;/s);
  expect(css).toContain(".design-canvas-node__resize-control:hover .design-canvas-node__resize-corner");
  expect(css).not.toContain(".react-flow__resize-control.line { border-color");
});

test("Node previews have no permanent title chrome or zoom-in cursor", () => {
  expect(css).not.toContain(".design-canvas-node__chrome");
  expect(css).not.toContain(".design-canvas-node__identity");
  expect(css).not.toContain(".design-canvas-node__name");
  expect(css).not.toContain("cursor: zoom-in");
});

test("focused Nodes fly above an opaque same-color mask while background Nodes retreat", () => {
  expect(css).toMatch(/\.design-canvas-node\s*\{[^}]*transition:\s*transform[^;]+,[^}]*opacity/s);
  expect(css).toMatch(/\[data-node-focus-role="away"\]\s*\{[^}]*opacity:\s*0;[^}]*transform:\s*translate3d\(var\(--design-node-focus-x\),\s*var\(--design-node-focus-y\),\s*0\)/s);
  expect(css).toMatch(/\.design-canvas-surface\[data-node-focus="opening"\]::after\s*\{[^}]*background:\s*inherit;[^}]*opacity:\s*1;/s);
  expect(css).toMatch(/\.design-canvas-surface\[data-node-focus\] > \.react-flow\s*\{[^}]*z-index:\s*46\s*!important;/s);
  expect(css).toMatch(/\.react-flow__node\.design-canvas-flow-node--focused\s*\{[^}]*z-index:\s*48\s*!important;/s);
  expect(css).not.toMatch(/\.design-canvas-surface\[data-node-focus\]\s*\{[^}]*background:/s);
  expect(css).toContain('.design-canvas-surface[data-node-focus] .react-flow__background');
  expect(css).toContain('.design-canvas-surface[data-focus-motion="instant"] .design-canvas-node');
  expect(css).not.toMatch(/data-node-focus-role[^}]*\b(?:top|left|width|height):/s);
});

test("focused Agent fills available height below model-picker overlays", () => {
  expect(css).toMatch(/\.design-canvas-agent--floating\s*\{[^}]*z-index:\s*49;/s);
  expect(css).toMatch(/\.design-canvas-agent--floating\[data-agent-size="focus"\]\s*\{[^}]*height:\s*calc\(100% - 24px\);/s);
});

test("Agent header is compact and its solid surface does not use backdrop glass", () => {
  expect(css).toMatch(/\.design-canvas-agent__header\s*\{[^}]*height:\s*46px;[^}]*min-height:\s*46px;/s);
  expect(css).toMatch(/\.design-canvas-agent__surface\s*\{[^}]*background:\s*var\(--card\);/s);
  expect(css).not.toMatch(/\.design-canvas-agent__surface\s*\{[^}]*backdrop-filter/s);
  expect(css).not.toContain(".design-canvas-agent__mark");
});

test("Agent composer grows within explicit bounds without a separator above it", () => {
  expect(css).toMatch(/\.design-canvas-agent__composer\s*\{[^}]*padding:\s*0 12px 12px;[^}]*background:\s*transparent;/s);
  expect(css).not.toMatch(/\.design-canvas-agent__composer\s*\{[^}]*border-top:/s);
  expect(css).toMatch(/\.design-canvas-agent__composer textarea\s*\{[^}]*max-height:\s*160px;[^}]*min-height:\s*62px;/s);
});

test("expanded Agent detail never grows a left emphasis rail", () => {
  expect(css).not.toMatch(/\.design-canvas-agent__activity[^}]*border-left:/s);
  expect(css).not.toMatch(/\.design-canvas-agent__activity[^}]*box-shadow:[^;}]*inset\s+[\d.]+px\s+0\s+0/s);
  expect(conversationCss).not.toMatch(/\.agent-reasoning[^}]*border-left:/s);
  expect(conversationCss).toMatch(/\.agent-web-search__rail\s*\{\s*display:\s*none;/s);
});

test("Agent Job cards reserve red surfaces for failures", () => {
  expect(css).toMatch(/\.design-canvas-agent__activity\[data-status="ready"\][^\{]*\{[^}]*background:\s*color-mix\(in oklch, var\(--surface\) 36%, transparent\);/s);
  expect(css).toMatch(/\.design-canvas-agent__activity\[data-status="failed"\]\s*\{[^}]*var\(--destructive\)[^}]*background:[^}]*box-shadow:\s*none;/s);
  expect(css).not.toMatch(/\.design-canvas-agent__activity\[data-status="failed"\][^}]*inset\s+[\d.]+px\s+0\s+0/s);
  expect(css).toMatch(/\.design-canvas-agent__activity-status\[data-status="ready"\]\s*\{[^}]*color-mix\(in srgb, var\(--success\)/s);
  expect(css).not.toMatch(/\.design-canvas-agent__activity-status\[data-status="ready"\]\s*\{[^}]*var\(--destructive\)/s);
  expect(css).not.toMatch(/\.design-canvas-agent__activity\[data-status="(?:running|ready)"\][^{]*\{[^}]*background:[^;}]*var\(--destructive\)/s);
});

test("light-mode bottom controls and context menus follow the Spatial surface language", () => {
  expect(css).toMatch(/\.design-canvas-tools__modes,\s*\.design-canvas-tools #design-canvas-add\s*\{[^}]*background:\s*color-mix\(in oklch, var\(--card\) 86%, transparent\);/s);
  expect(css).toMatch(/\.design-canvas-tools\s*\{\s*right:\s*12px;\s*bottom:\s*12px;/s);
  expect(css).toMatch(/\.design-canvas-zoom\s*\{\s*bottom:\s*12px;\s*left:\s*12px;/s);
  expect(css).toMatch(/#design-canvas-add\s*\{[^}]*width:\s*40px;[^}]*height:\s*40px;[^}]*padding:\s*0;/s);
  expect(css).toMatch(/\.design-canvas-zoom \[data-slot="button"\]\s*\{[^}]*width:\s*36px;[^}]*height:\s*36px;/s);
  expect(css).toMatch(/\[data-context-menu-open\][^{]*\.design-canvas-node\s*\{\s*opacity:\s*0\.45;/s);
  expect(css).toMatch(/\[data-context-menu-open\][^{]*::after\s*\{[^}]*opacity:\s*1;[^}]*transition-duration:\s*320ms,\s*360ms;/s);
  expect(css).toMatch(/\.design-node-context-menu\s*\{[^}]*width:\s*284px;[^}]*border-radius:\s*16px;/s);
  expect(css).toMatch(/\.design-canvas-node:hover\s*\{[^}]*scale\(1\.003\)/s);
});

test("Node catalog animation follows the Radix open and closed lifecycle", () => {
  expect(css).toContain('.design-node-catalog[data-state="open"]');
  expect(css).toContain('.design-node-catalog[data-state="closed"]');
  expect(css).toContain('.design-canvas-agent__mention-menu[data-state="open"]');
  expect(css).toContain('.design-canvas-agent__mention-menu[data-state="closed"]');
  expect(css).toContain("@keyframes design-canvas-menu-in");
  expect(css).toContain("@keyframes design-canvas-menu-out");
});
