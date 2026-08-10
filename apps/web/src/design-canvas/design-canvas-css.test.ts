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
  expect(css).toMatch(/\.design-canvas-focus-back\s*\{[^}]*z-index:\s*52;[^}]*top:\s*12px;[^}]*left:\s*12px;/s);
  expect(css).toMatch(/\.design-canvas-agent__composer\s*\{[^}]*position:\s*relative;/s);
  expect(css).toMatch(/\.design-canvas-agent__composer-notice\s*\{[^}]*position:\s*absolute;/s);
});

test("selected and keyboard-focused Nodes use restrained depth with discoverable corner brackets", () => {
  expect(css).toMatch(/\.design-canvas-node::after\s*\{[^}]*inset:\s*-3px;[^}]*border-radius:\s*14px;/s);
  expect(css).toMatch(/\.design-canvas-node--selected::after\s*\{[^}]*border-color:\s*transparent;[^}]*box-shadow:\s*none;/s);
  expect(css).toMatch(/\.design-canvas-node--selected \.design-canvas-node__frame\s*\{[^}]*box-shadow:[^}]*0 10px 20px/s);
  expect(css).not.toMatch(/\.design-canvas-node--selected::after\s*\{[^}]*border-color:\s*white/s);
  expect(css).toMatch(/\[data-node-focus\][^{]*\[data-node-focus-role="source"\]::after\s*\{[^}]*border-color:\s*transparent;[^}]*box-shadow:\s*none;/s);
  expect(css).toMatch(/\.react-flow__node:focus-visible\s+\.design-canvas-node::after\s*\{[^}]*border-color:[^}]*box-shadow:/s);
  expect(css).toMatch(/\.design-canvas-node__resize-corner\s*\{[^}]*opacity:\s*0;/s);
  expect(css).toMatch(/\.design-canvas-node__resize-corner\s*\{[^}]*opacity:\s*0;[^}]*transition:\s*opacity 160ms[^}]*transform 180ms/s);
  expect(css).toMatch(/@media \(hover: hover\) and \(pointer: fine\)[^{]*\{\s*\.design-canvas-surface:not\(\[data-node-focus\]\) \.design-canvas-node:hover \.design-canvas-node__resize-control--enabled\s*\{\s*pointer-events:\s*auto;/s);
  expect(css).toMatch(/\.design-canvas-node:hover \.design-canvas-node__resize-control--affordance \.design-canvas-node__resize-corner\s*\{[^}]*opacity:\s*0\.3;/s);
  expect(css).toMatch(/\.design-canvas-surface:not\(\[data-node-focus\]\)[^{]*\.design-canvas-node__resize-control--interactive,[^{]*\.design-canvas-surface:not\(\[data-node-focus\]\)[^{]*\.design-canvas-node--resizing \.design-canvas-node__resize-control--enabled\s*\{[^}]*pointer-events:\s*auto/s);
  expect(css).toContain(".design-canvas-node__resize-control:hover .design-canvas-node__resize-corner");
  expect(css).toMatch(/\.design-canvas-node__resize-control\.top\.left \.design-canvas-node__resize-corner\s*\{[^}]*top:\s*7px;[^}]*left:\s*7px;/s);
  expect(css).not.toContain(".react-flow__resize-control.line { border-color");
});

test("marquee selection is solid and leaves a short animated solid ghost", () => {
  expect(css).toMatch(/\.design-canvas-surface \.react-flow__selection\s*\{[^}]*border:\s*1\.5px solid/s);
  expect(css).toMatch(/\.design-canvas-surface \.react-flow__nodesselection-rect\s*\{[^}]*border:\s*2px solid[^}]*background:[^}]*box-shadow:/s);
  expect(css).not.toMatch(/\.react-flow__(?:nodes)?selection[^}]*dashed/s);
  expect(css).toMatch(/\.design-canvas-selection-ghost\s*\{[^}]*border:\s*1px solid[^}]*animation:\s*design-canvas-selection-out 180ms/s);
  expect(css).toContain("@keyframes design-canvas-selection-out");
});

test("image Nodes suppress frame chrome because their geometry owns the intrinsic media ratio", () => {
  expect(css).toMatch(/\.design-canvas-node\[data-node-kind="image"\],[^}]*\{[^}]*min-width:\s*120px;[^}]*min-height:\s*80px;/s);
  expect(css).toMatch(/\.design-canvas-node\[data-node-kind="image"\] \.design-canvas-node__frame\s*\{[^}]*border-color:\s*transparent;[^}]*background:\s*transparent;/s);
  expect(css).toMatch(/\.design-canvas-node__asset--image\s*\{[^}]*object-fit:\s*contain;[^}]*background-color:\s*transparent;/s);
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
  expect(css).toMatch(/\.design-canvas-surface\[data-node-focus\] > \.react-flow\s*\{[^}]*z-index:\s*48\s*!important;[^}]*pointer-events:\s*none;/s);
  expect(css).toMatch(/\.react-flow__node\.design-canvas-flow-node--focused\s*\{[^}]*z-index:\s*48\s*!important;/s);
  expect(css).toMatch(/\.design-canvas-surface::after\s*\{[^}]*opacity var\(--design-focus-duration\)[^}]*transform var\(--design-focus-duration\)/s);
  expect(css).toMatch(/data-node-focus="opening"[^}]*opacity:\s*1;/s);
  expect(css).toMatch(/data-node-focus="closing"[^}]*opacity:\s*0;/s);
  expect(css).not.toMatch(/\.design-canvas-surface\[data-node-focus\]\s*\{[^}]*background:/s);
  expect(css).toContain('.design-canvas-surface[data-node-focus] .react-flow__background');
  expect(css).toContain('.design-canvas-surface[data-focus-motion="instant"] .design-canvas-node');
  expect(css).not.toMatch(/data-node-focus-role[^}]*\b(?:top|left|width|height):/s);
});

test("focused Agent fills available height below model-picker overlays", () => {
  expect(css).toMatch(/\.design-canvas-agent--floating\s*\{[^}]*z-index:\s*49;[^}]*width:\s*var\(--design-node-agent-width, 352px\);/s);
  expect(css).toMatch(/\.design-canvas-agent--floating\[data-agent-size="focus"\]\s*\{[^}]*height:\s*calc\(100% - 24px\);/s);
  expect(css).toMatch(/\.design-canvas-surface\[data-node-agent="open"\] \.design-canvas-focus-actions\s*\{[^}]*left:\s*calc\(50% - \(var\(--design-node-agent-width, 352px\) \+ 24px\) \/ 2\);/s);
});

test("Agent header is compact and its solid surface does not use backdrop glass", () => {
  expect(css).toMatch(/\.design-canvas-agent__header\s*\{[^}]*height:\s*48px;[^}]*min-height:\s*48px;[^}]*padding:\s*0 10px 0 14px;/s);
  expect(css).toMatch(/\.design-canvas-agent__surface\s*\{[^}]*background:\s*var\(--card\);/s);
  expect(css).not.toMatch(/\.design-canvas-agent__surface\s*\{[^}]*backdrop-filter/s);
  expect(css).not.toContain(".design-canvas-agent__mark");
});

test("Agent composer grows within explicit bounds without a separator above it", () => {
  expect(css).toMatch(/\.design-canvas-agent__composer\s*\{[^}]*padding:\s*0 10px 10px;[^}]*background:\s*transparent;/s);
  expect(css).not.toMatch(/\.design-canvas-agent__composer\s*\{[^}]*border-top:/s);
  expect(css).toMatch(/\.design-canvas-agent__composer textarea\s*\{[^}]*max-height:\s*160px;[^}]*min-height:\s*62px;/s);
  expect(css).toMatch(/\.design-canvas-agent__composer-beam\s*\{[^}]*width:\s*100%;[^}]*border-radius:\s*14px;/s);
  expect(css).toMatch(/\.design-canvas-agent__composer-shell\s*\{[^}]*box-shadow:\s*none;/s);
  expect(css).toMatch(/\.design-canvas-agent__composer-beam\[data-active\][^{]*\.design-canvas-agent__composer-shell\s*\{[^}]*border-color:\s*transparent;[^}]*background:\s*color-mix\(in oklch, var\(--foreground\) 5\.5%, var\(--card\)\);[^}]*box-shadow:\s*none;/s);
  expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*\.design-canvas-agent__composer-beam\[data-active\]\s*\{[^}]*animation-duration:\s*0\.001ms !important;[^}]*animation-iteration-count:\s*1 !important;[\s\S]*\.design-canvas-agent__composer-beam\[data-active\]::before,[\s\S]*animation:\s*none !important;/s);
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
  expect(css).toMatch(/\.design-canvas-zoom \[data-slot="button"\]\s*\{[^}]*width:\s*32px;[^}]*height:\s*32px;/s);
  expect(css).toMatch(/\.design-canvas-zoom \[data-slot="button"\] > svg\s*\{[^}]*width:\s*16px;[^}]*height:\s*16px;[^}]*stroke-width:\s*2;/s);
  expect(css).toMatch(/\.design-canvas-surface\[data-main-agent\] \.design-canvas-tools\s*\{[^}]*right:\s*calc\(clamp\(380px, 32vw, 492px\) \+ 20px\);/s);
  expect(css).toMatch(/\[data-context-menu-open\][^{]*\.design-canvas-node\s*\{\s*opacity:\s*0\.45;/s);
  expect(css).toMatch(/\[data-context-menu-open\][^{]*::after\s*\{[^}]*opacity:\s*1;[^}]*transition-duration:\s*320ms,\s*360ms;/s);
  expect(css).toMatch(/\.design-node-context-menu\s*\{[^}]*width:\s*284px;[^}]*border-radius:\s*16px;/s);
  expect(css).not.toMatch(/\.design-canvas-node:hover(?:\s+\.design-canvas-node__frame)?\s*\{[^}]*\btransform:\s*[^;}]*scale/s);
});

test("canvas chrome exits on focus opening and re-enters during closing", () => {
  expect(css).toMatch(/\.design-canvas-root\[data-node-focus="opening"\] \.design-canvas-topbar__leading\s*\{[^}]*opacity:\s*0;[^}]*transform:\s*translate3d\(-10px,\s*0,\s*0\);/s);
  expect(css).toMatch(/\.design-canvas-root\[data-node-focus="opening"\] \.design-canvas-topbar__actions\s*\{[^}]*opacity:\s*0;[^}]*transform:\s*translate3d\(10px,\s*0,\s*0\);/s);
  expect(css).toMatch(/\.design-canvas-root\[data-node-focus="closing"\] \.design-canvas-topbar__leading,[^{]*\.design-canvas-root\[data-node-focus="closing"\] \.design-canvas-topbar__actions\s*\{[^}]*opacity:\s*1;[^}]*transform:\s*translate3d\(0,\s*0,\s*0\);/s);
  expect(css).toMatch(/\.design-canvas-surface\[data-node-focus="opening"\] \.design-canvas-tools\s*\{[^}]*opacity:\s*0;[^}]*transform:\s*translate3d\(10px,\s*8px,\s*0\) scale\(0\.98\);/s);
  expect(css).toMatch(/\.design-canvas-surface\[data-node-focus="opening"\] \.design-canvas-zoom\s*\{[^}]*opacity:\s*0;[^}]*transform:\s*translate3d\(-10px,\s*8px,\s*0\) scale\(0\.98\);/s);
  expect(css).toMatch(/\.design-canvas-surface\[data-node-focus="closing"\] \.design-canvas-tools,[^{]*\.design-canvas-surface\[data-node-focus="closing"\] \.design-canvas-zoom\s*\{[^}]*opacity:\s*1;[^}]*transform:\s*translate3d\(0,\s*0,\s*0\) scale\(1\);/s);
  expect(css).toMatch(/\.design-canvas-surface\[data-node-focus\] \.react-flow__pane\s*\{\s*pointer-events:\s*none;/s);
});

test("focused preview controls are larger and animate with the focus chrome", () => {
  expect(css).toMatch(/\.design-canvas-focus-actions\s*\{[^}]*bottom:\s*16px;[^}]*border-radius:\s*17px;[^}]*padding:\s*5px;/s);
  expect(css).toMatch(/\.design-canvas-focus-actions \[data-slot="button"\]\s*\{[^}]*width:\s*38px;[^}]*height:\s*38px;/s);
  expect(css).toMatch(/\.design-canvas-focus-dismiss\s*\{[^}]*z-index:\s*47;[^}]*inset:\s*0;/s);
});

test("Canvas uses the requested neutral background in both color schemes", () => {
  expect(css).toMatch(/\.design-canvas-surface\s*\{[^}]*background:\s*#e8eaeb;/s);
  expect(css).toMatch(/\.dark \.design-canvas-surface\s*\{\s*background:\s*#e8eaeb;/s);
});

test("Node catalog animation follows the Radix open and closed lifecycle", () => {
  expect(css).toContain('.design-node-catalog[data-state="open"]');
  expect(css).toContain('.design-node-catalog[data-state="closed"]');
  expect(css).toContain('.design-canvas-agent__mention-menu[data-state="open"]');
  expect(css).toContain('.design-canvas-agent__mention-menu[data-state="closed"]');
  expect(css).toContain("@keyframes design-canvas-menu-in");
  expect(css).toContain("@keyframes design-canvas-menu-out");
});
