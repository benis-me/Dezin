import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";

const css = readFileSync(join(process.cwd(), "src/design-canvas/design-canvas.css"), "utf8");
const conversationCss = readFileSync(join(process.cwd(), "src/components/agent-conversation.css"), "utf8");
const primitivesCss = readFileSync(join(process.cwd(), "src/design-canvas/dezin-agent-primitives.css"), "utf8");
const screenSource = readFileSync(join(process.cwd(), "src/design-canvas/DesignCanvasScreen.tsx"), "utf8");
const focusedChromeSource = readFileSync(join(process.cwd(), "src/design-canvas/FocusedNodeChrome.tsx"), "utf8");
const floatingAgentSource = readFileSync(join(process.cwd(), "src/design-canvas/FloatingNodeAgent.tsx"), "utf8");
const outputRendererSource = readFileSync(join(process.cwd(), "src/design-canvas/AgentOutputRenderer.tsx"), "utf8");
const nodeSource = readFileSync(join(process.cwd(), "src/design-canvas/DesignCanvasNode.tsx"), "utf8");

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
  expect(css.match(/\.design-canvas-node__resize-corner\s*\{[^}]*\}/s)?.[0]).not.toContain("will-change");
  expect(css).toMatch(/\.design-canvas-node__resize-hit-target\s*\{[^}]*position:\s*absolute;[^}]*inset:\s*0;[^}]*width:\s*100%;[^}]*height:\s*100%;/s);
  expect(css).toMatch(/\.design-canvas-node__resize-corner\s*\{[^}]*width:\s*13px;[^}]*height:\s*13px;[^}]*pointer-events:\s*none;/s);
  expect(css).toMatch(/\.design-canvas-node__resize-control:active \.design-canvas-node__resize-corner,[^{]*\.design-canvas-node--resizing \.design-canvas-node__resize-corner\s*\{[^}]*will-change:\s*opacity, transform;/s);
  expect(css).toMatch(/@media \(hover: hover\) and \(pointer: fine\)[^{]*\{\s*\.design-canvas-surface:not\(\[data-node-focus\]\) \.design-canvas-node:hover \.design-canvas-node__resize-control--enabled\s*\{\s*pointer-events:\s*auto;/s);
  expect(css).toMatch(/@media \(hover: hover\) and \(pointer: fine\)[\s\S]*\.design-canvas-node:hover \.design-canvas-node__resize-corner\s*\{[^}]*will-change:\s*opacity, transform;/s);
  expect(css).toMatch(/\.design-canvas-node:hover \.design-canvas-node__resize-control--affordance \.design-canvas-node__resize-corner\s*\{[^}]*opacity:\s*0\.18;/s);
  expect(css).toMatch(/\.design-canvas-node__resize-control:hover \.design-canvas-node__resize-corner\s*\{[^}]*opacity:\s*0\.68;[^}]*border-color:\s*color-mix\(in oklch, var\(--foreground\) 34%, transparent\);/s);
  expect(css).toMatch(/\.design-canvas-surface:not\(\[data-node-focus\]\)[^{]*\.design-canvas-node__resize-control--interactive,[^{]*\.design-canvas-surface:not\(\[data-node-focus\]\)[^{]*\.design-canvas-node--resizing \.design-canvas-node__resize-control--enabled\s*\{[^}]*pointer-events:\s*auto/s);
  expect(css).toContain(".design-canvas-node__resize-control:hover .design-canvas-node__resize-corner");
  expect(css).toMatch(/\.design-canvas-node__resize-hit-target:focus-visible\s*\{[^}]*outline:[^}]*transition:\s*none;/s);
  expect(css).toMatch(/\.design-canvas-node__resize-hit-target:focus-visible \.design-canvas-node__resize-corner\s*\{[^}]*transition:\s*none;[^}]*opacity:\s*1;[^}]*transform:\s*scale\(1\);/s);
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

test("generation dots keep their organic loop on compositor-only properties", () => {
  expect(css).toMatch(/\.design-canvas-node__generation-glow\s*\{[^}]*inset:\s*-28%;[^}]*will-change:\s*transform, opacity;[^}]*design-canvas-generation-morph 4\.8s linear infinite/s);
  const keyframeStart = css.indexOf("@keyframes design-canvas-generation-morph");
  const keyframeEnd = css.indexOf("@keyframes design-canvas-generation-breathe", keyframeStart);
  const keyframes = css.slice(keyframeStart, keyframeEnd);
  expect(keyframes).toContain("transform: translate3d");
  expect(keyframes).not.toMatch(/mask-(?:position|size)/);
});

test("Node previews have no permanent title chrome or zoom-in cursor", () => {
  expect(css).not.toContain(".design-canvas-node__chrome");
  expect(css).not.toContain(".design-canvas-node__identity");
  expect(css).not.toContain(".design-canvas-node__name");
  expect(css).not.toContain("cursor: zoom-in");
  expect(css).toMatch(/\.design-canvas-node__hover-label\s*\{[^}]*pointer-events:\s*none;[^}]*opacity:\s*0;[^}]*transform:\s*translate3d\(0, 7px, 0\);[^}]*transition:[^}]*opacity 160ms[^}]*transform 220ms cubic-bezier\(0\.23, 1, 0\.32, 1\);/s);
  expect(css).toMatch(/@media \(hover: hover\) and \(pointer: fine\)[\s\S]*\.design-canvas-surface:not\(\[data-node-focus\]\) \.design-canvas-node:hover > \.design-canvas-node__hover-label\s*\{[^}]*opacity:\s*1;[^}]*transform:\s*translate3d\(0, calc\(-100% - 7px\), 0\);/s);
  expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*\.design-canvas-node__hover-label\s*\{[^}]*transition:\s*opacity 160ms var\(--design-canvas-ease-out\) !important;/s);
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

test("focused Agent morphs its real height without scaling its content", () => {
  expect(css).toMatch(/\.design-canvas-agent--floating\s*\{[^}]*z-index:\s*49;[^}]*width:\s*var\(--design-node-agent-width, 352px\);[^}]*height:\s*min\(520px, calc\(100% - 24px\)\);[^}]*transition:\s*height 280ms var\(--design-canvas-ease-in-out\);/s);
  expect(css).toMatch(/\.design-canvas-agent--floating\[data-agent-size="focus"\]\s*\{[^}]*height:\s*calc\(100% - 24px\);/s);
  expect(css).toMatch(/\.design-canvas-surface\[data-node-agent="open"\] \.design-canvas-focus-actions\s*\{[^}]*--design-focus-actions-offset-x:\s*calc\(-1 \* \(var\(--design-node-agent-width, 352px\) \+ 24px\) \/ 2\);/s);
  expect(floatingAgentSource).toContain('layout={floating && !reduceMotion ? "position" : false}');
  expect(floatingAgentSource).toContain("duration: reduceMotion ? 0 : 0.28, ease: AGENT_MORPH_EASE");
  expect(floatingAgentSource).toContain("boundedEntryOffset(nodeCenterX - (resolved.left + panelWidth / 2), 8)");
  expect(floatingAgentSource).not.toContain("data-agent-focus-reveal");
  expect(floatingAgentSource).not.toContain("0.985");
  expect(css).not.toContain("data-agent-focus-reveal");
});

test("Agent header is compact and its solid surface does not use backdrop glass", () => {
  expect(css).toMatch(/\.design-canvas-agent__header\s*\{[^}]*height:\s*50px;[^}]*min-height:\s*50px;[^}]*padding:\s*0 9px 0 14px;/s);
  expect(css).toMatch(/\.design-canvas-agent__surface\s*\{[^}]*background:\s*var\(--card\);/s);
  expect(css).not.toMatch(/\.design-canvas-agent__surface\s*\{[^}]*backdrop-filter/s);
  expect(css).not.toContain(".design-canvas-agent__mark");
});

test("Agent composer grows within explicit bounds without a separator above it", () => {
  expect(css).toMatch(/\.design-canvas-agent__composer\s*\{[^}]*padding:\s*0 7px 7px;[^}]*background:\s*transparent;/s);
  expect(css).not.toMatch(/\.design-canvas-agent__composer\s*\{[^}]*border-top:/s);
  expect(css).toMatch(/\.design-canvas-agent__composer textarea\s*\{[^}]*max-height:\s*160px;[^}]*min-height:\s*62px;/s);
  expect(css).toMatch(/\.design-canvas-agent__composer-beam\s*\{[^}]*--beam-stroke-opacity:\s*1\.42;[^}]*--beam-inner-opacity:\s*0\.9;[^}]*--beam-bloom-opacity:\s*0\.68;[^}]*width:\s*100%;[^}]*border-radius:\s*14px;/s);
  expect(css).toMatch(/\.design-canvas-agent__composer-shell\s*\{[^}]*box-shadow:\s*none;/s);
  expect(css).toMatch(/\.design-canvas-agent__composer-beam\[data-active\][^{]*\.design-canvas-agent__composer-shell\s*\{[^}]*border-color:\s*transparent;[^}]*background:\s*color-mix\(in oklch, var\(--foreground\) 5\.5%, var\(--card\)\);[^}]*box-shadow:\s*none;/s);
  expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*\.design-canvas-agent__composer-beam\[data-active\]\s*\{[^}]*animation-duration:\s*0\.001ms !important;[^}]*animation-iteration-count:\s*1 !important;[\s\S]*\.design-canvas-agent__composer-beam\[data-active\]::before,[\s\S]*animation:\s*none !important;/s);
  expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*\.design-canvas-agent__composer-beam:focus-within \.design-canvas-agent__composer-shell\s*\{[^}]*border-color:\s*color-mix\(in oklch, var\(--design-canvas-accent\) 48%, var\(--border-strong\)\);/s);
});

test("Agent execution uses bordered Task Rows without decorative left rails", () => {
  expect(css).toMatch(/\.design-canvas-agent__activity-group\s*\{[^}]*overflow:\s*visible;[^}]*border:\s*0;[^}]*border-radius:\s*0;[^}]*background:\s*transparent;/s);
  expect(primitivesCss).toMatch(/\.dezin-agent-task-row\s*\{[^}]*border-radius:\s*22px;[^}]*background:\s*var\(--dz-surface\);[^}]*box-shadow:/s);
  expect(primitivesCss).toMatch(/\.dezin-agent-task-row\[data-open\]\s*\{[^}]*border-radius:\s*14px;/s);
  expect(primitivesCss).not.toContain("__rail");
});

test("Agent disclosure rows keep every expanded glyph and body on the 29px editorial rail", () => {
  const outputColumnWidth = 352 - 14 * 2;
  const traceIconX = 0 + 29;
  const traceTextX = traceIconX + 14 + 7;
  const searchTextX = 29 + 13 + 8;
  const toolChipIconX = 29 - 8 + 1 + 7;
  const toolChipTextX = toolChipIconX + 14 + 7;
  expect({ outputColumnWidth, traceIconX, traceTextX, searchTextX, toolChipIconX, toolChipTextX })
    .toEqual({ outputColumnWidth: 324, traceIconX: 29, traceTextX: 50, searchTextX: 50, toolChipIconX: 29, toolChipTextX: 50 });
  expect(primitivesCss).toMatch(/\.dezin-agent-thinking__steps\s*\{[^}]*padding:\s*4px 0 4px 29px;/s);
  expect(primitivesCss).toMatch(/\.dezin-agent-thinking__steps li\s*\{[^}]*grid-template-columns:\s*14px minmax\(0,1fr\) auto;[^}]*gap:\s*8px;/s);
  expect(primitivesCss).toMatch(/\.dezin-agent-task-row__content\s*\{[^}]*padding:\s*9px 12px 11px 50px;/s);
  expect(primitivesCss).toMatch(/\.dezin-agent-tool-chips__item-summary\s*\{[^}]*height:\s*28px;[^}]*gap:\s*8px;/s);
  expect(primitivesCss).not.toContain("agent-web-search__rail");
});

test("Agent Job status stays in its glyph rather than tinting whole cards", () => {
  expect(primitivesCss).toMatch(/\.dezin-agent-task-row\[data-status="ready"\] \.dezin-agent-task-row__status-label\s*\{[^}]*color:\s*var\(--dz-green\);/s);
  expect(primitivesCss).toMatch(/\.dezin-agent-task-row\[data-status="failed"\] \.dezin-agent-task-row__status-label\s*\{[^}]*color:\s*var\(--dz-red\);/s);
  expect(primitivesCss).not.toMatch(/\.dezin-agent-task-row\[data-status="failed"\]\s*\{[^}]*background:[^;}]*var\(--dz-red\)/s);
});

test("Agent transcript restores the original right-aligned Canvas user bubble", () => {
  expect(floatingAgentSource).toContain('message.role === "user" ? "Prompt" : message.role === "assistant" ? "Response"');
  expect(floatingAgentSource).toContain('role="log"');
  expect(floatingAgentSource).toContain('aria-live="polite"');
  expect(floatingAgentSource).toContain('aria-relevant="additions"');
  expect(floatingAgentSource).toContain("<AgentOutputRenderer");
  expect(outputRendererSource).toContain('case "approval"');
  expect(css).toMatch(/\.design-canvas-agent__message\[data-role="user"\]\s*\{[^}]*display:\s*flex;[^}]*justify-content:\s*flex-end;/s);
  expect(css).toMatch(/\.design-canvas-agent__message\[data-role="user"\] \.design-canvas-agent__message-meta\s*\{[^}]*display:\s*none;/s);
  expect(conversationCss).toMatch(/\.agent-user-message\s*\{[^}]*border:\s*1px solid color-mix\(in oklch, var\(--border\) 84%, transparent\);[^}]*border-radius:\s*12px 12px 5px 12px;[^}]*padding:\s*7px 10px;[^}]*background:\s*var\(--surface-2\);[^}]*box-shadow:\s*var\(--shadow-card\);[^}]*font-size:\s*12\.5px;[^}]*line-height:\s*18px;/s);
  expect(css).toMatch(/\.design-canvas-agent__message\[data-role="user"\] \.agent-user-message\s*\{[^}]*max-width:\s*86%;[^}]*border:\s*0;[^}]*border-radius:\s*14px 14px 5px 14px;[^}]*padding:\s*8px 11px;[^}]*background:\s*color-mix\(in oklch, var\(--foreground\) 7%, var\(--card\)\);[^}]*box-shadow:\s*none;/s);
  expect(css).toMatch(/\.design-canvas-agent__message\[data-role="(?:system|tool)"\]\s*\{[^}]*border-top:/s);
  expect(css).toMatch(/\.design-canvas-agent__message-meta\s*\{[^}]*color:\s*color-mix\(in oklch, var\(--foreground\) 52%, var\(--muted-foreground\)\);/s);
  expect(css).toMatch(/\.design-canvas-agent__composer textarea::placeholder\s*\{[^}]*color:\s*color-mix\(in oklch, var\(--foreground\) 68%, var\(--card\)\);/s);
  expect(floatingAgentSource).not.toContain("text-muted-foreground/80");
});

test("Agent panel header uses the locked 50px shell and 2px control rhythm", () => {
  expect(css).toMatch(/\.design-canvas-agent__header\s*\{[^}]*height:\s*50px;[^}]*min-height:\s*50px;[^}]*padding:\s*0 9px 0 14px;/s);
  expect(floatingAgentSource).toContain('className="design-canvas-agent__header-controls"');
  expect(css).toMatch(/\.design-canvas-agent__header-controls\s*\{[^}]*display:\s*flex;[^}]*gap:\s*2px;/s);
});

test("Agent transcript uses the locked turn hierarchy instead of one uniform stack", () => {
  expect(css).toMatch(/\.design-canvas-agent__transcript\s*\{[^}]*padding:\s*14px 14px 12px;/s);
  expect(css).toMatch(/\.design-canvas-agent__history-more\s*\{[^}]*height:\s*28px;[^}]*margin-bottom:\s*8px;/s);
  expect(css).toMatch(/\.design-canvas-agent__message \+ \.design-canvas-agent__message,[\s\S]*?\.design-canvas-agent__job \+ \.design-canvas-agent__message,[\s\S]*?\{\s*margin-top:\s*16px;/s);
  expect(css).toMatch(/\.design-canvas-agent__message \+ \.design-canvas-agent__job,\s*\.design-canvas-agent__message \+ \.design-canvas-agent__activity-group\s*\{\s*margin-top:\s*10px;/s);
  expect(css).toMatch(/\.design-canvas-agent__activity-group \+ \.design-canvas-agent__message,[\s\S]*\.design-canvas-agent__activity-group \+ \.design-canvas-agent__activity-group\s*\{\s*margin-top:\s*22px;/s);
});

test("Agent responses keep lightweight metadata and compact editorial prose", () => {
  expect(floatingAgentSource).toContain('className="design-canvas-agent__message-meta"');
  expect(css).toMatch(/\.design-canvas-agent__message-meta\s*\{[^}]*color:\s*color-mix\(in oklch, var\(--foreground\) 52%, var\(--muted-foreground\)\);[^}]*font-size:\s*8px;/s);
  expect(css).toMatch(/\.design-canvas-agent__message\[data-role="assistant"\] \.design-canvas-agent__message-meta\s*\{[^}]*display:\s*flex;/s);
  expect(css).toMatch(/\.design-canvas-agent__message \.agent-text-response,\s*\.design-canvas-agent__message \.agent-response-prose\s*\{[^}]*font-size:\s*12\.5px;[^}]*line-height:\s*18\.5px;/s);
  expect(css).toMatch(/\.design-canvas-agent__message \.agent-response-prose > \* \+ \*\s*\{[^}]*margin-top:\s*7px;/s);
});

test("the 324px Message Response keeps Sources, code, and diff surfaces bounded", () => {
  expect(conversationCss).toMatch(/\.agent-text-response\s*\{[^}]*min-width:\s*0;[^}]*max-width:\s*100%;[^}]*overflow-wrap:\s*anywhere;/s);
  expect(conversationCss).toMatch(/\.agent-code-block,\s*\.agent-file-diff\s*\{[^}]*width:\s*100%;[^}]*max-width:\s*100%;[^}]*overflow:\s*hidden;/s);
  expect(conversationCss).toMatch(/\.agent-code-block__body,\s*\.agent-file-diff__body\s*\{[^}]*max-width:\s*100%;[^}]*overflow-x:\s*auto;/s);
  expect(conversationCss).toMatch(/\.agent-citations__header\s*\{[^}]*width:\s*100%;[^}]*grid-template-columns:\s*14px minmax\(0, 1fr\) auto 12px;[^}]*gap:\s*7px;/s);
  expect(conversationCss).toMatch(/\.agent-citations__references\s*\{[^}]*display:\s*grid;[^}]*min-width:\s*0;[^}]*gap:\s*4px;/s);
  expect(css).toMatch(/\.design-canvas-agent__composer-shell\s*\{[^}]*overflow:\s*hidden;[^}]*border-radius:\s*14px;/s);
});

test("Agent composer preserves Beam geometry behind a 12px breath and 18px transcript fade", () => {
  expect(css).toMatch(/\.design-canvas-agent__transcript\s*\{[^}]*padding:\s*14px 14px 12px;/s);
  expect(css).toMatch(/\.design-canvas-agent__composer\s*\{[^}]*padding:\s*0 7px 7px;[^}]*background:\s*transparent;/s);
  expect(css).toMatch(/\.design-canvas-agent__composer::before\s*\{[^}]*bottom:\s*100%;[^}]*height:\s*18px;[^}]*background:\s*linear-gradient\(to bottom, transparent, color-mix\(in oklch, var\(--card\) 94%, transparent\)\);[^}]*pointer-events:\s*none;/s);
  expect(css).toMatch(/\.design-canvas-agent__composer-beam\s*\{[^}]*--beam-stroke-opacity:\s*1\.42;[^}]*--beam-inner-opacity:\s*0\.9;[^}]*--beam-bloom-opacity:\s*0\.68;/s);
  expect(css).toMatch(/\.design-canvas-agent__composer textarea\s*\{[^}]*max-height:\s*160px;[^}]*min-height:\s*62px;[^}]*padding:\s*11px 10px 3px;/s);
});

test("light-mode bottom controls and context menus follow the Spatial surface language", () => {
  expect(css).toMatch(/\.design-canvas-tools__modes,\s*\.design-canvas-tools #design-canvas-add\s*\{[^}]*background:\s*color-mix\(in oklch, var\(--card\) 86%, transparent\);/s);
  expect(css).toMatch(/\.design-canvas-tools\s*\{\s*right:\s*12px;\s*bottom:\s*12px;/s);
  expect(css).toMatch(/\.design-canvas-zoom\s*\{\s*bottom:\s*12px;\s*left:\s*12px;/s);
  expect(css).toMatch(/#design-canvas-add\s*\{[^}]*width:\s*40px;[^}]*height:\s*40px;[^}]*padding:\s*0;/s);
  expect(css).toMatch(/\.design-canvas-zoom \[data-slot="button"\]\s*\{[^}]*width:\s*32px;[^}]*height:\s*32px;/s);
  expect(css).toMatch(/\.design-canvas-zoom \[data-slot="button"\] > svg\s*\{[^}]*width:\s*16px;[^}]*height:\s*16px;[^}]*stroke-width:\s*2;/s);
  expect(css).toMatch(/\.design-canvas-surface\[data-main-agent\] \.design-canvas-tools\s*\{[^}]*--design-canvas-toolbar-offset-x:\s*calc\(-1 \* \(clamp\(380px, 32vw, 492px\) \+ 8px\)\);/s);
  expect(css).toMatch(/\[data-context-menu-open\][^{]*\.design-canvas-node\s*\{\s*opacity:\s*0\.45;/s);
  expect(css).toMatch(/\[data-context-menu-open\][^{]*::after\s*\{[^}]*opacity:\s*1;[^}]*transition-duration:\s*180ms,\s*200ms;/s);
  expect(css).toMatch(/\.design-node-context-menu\s*\{[^}]*width:\s*284px;[^}]*border-radius:\s*16px;/s);
  expect(css).not.toMatch(/\.design-canvas-node:hover(?:\s+\.design-canvas-node__frame)?\s*\{[^}]*\btransform:\s*[^;}]*scale/s);
});

test("canvas chrome exits on focus opening and re-enters during closing", () => {
  expect(css).toMatch(/\.design-canvas-root\[data-node-focus="opening"\] \.design-canvas-topbar__leading\s*\{[^}]*opacity:\s*0;[^}]*transform:\s*translate3d\(-10px,\s*0,\s*0\);/s);
  expect(css).toMatch(/\.design-canvas-root\[data-node-focus="opening"\] \.design-canvas-topbar__actions\s*\{[^}]*opacity:\s*0;[^}]*transform:\s*translate3d\(10px,\s*0,\s*0\);/s);
  expect(css).toMatch(/\.design-canvas-root\[data-node-focus="closing"\] \.design-canvas-topbar__leading,[^{]*\.design-canvas-root\[data-node-focus="closing"\] \.design-canvas-topbar__actions\s*\{[^}]*opacity:\s*1;[^}]*transform:\s*translate3d\(0,\s*0,\s*0\);/s);
  expect(css).toMatch(/\.design-canvas-surface\[data-node-focus="opening"\] \.design-canvas-tools\s*\{[^}]*opacity:\s*0;[^}]*transform:\s*translate3d\(calc\(var\(--design-canvas-toolbar-offset-x\) \+ 22px\),\s*16px,\s*0\) scale\(0\.975\);/s);
  expect(css).toMatch(/\.design-canvas-surface\[data-node-focus="opening"\] \.design-canvas-zoom\s*\{[^}]*opacity:\s*0;[^}]*transform:\s*translate3d\(-22px,\s*16px,\s*0\) scale\(0\.975\);/s);
  expect(css).toMatch(/\.design-canvas-surface\[data-node-focus="closing"\] \.design-canvas-tools\s*\{[^}]*opacity:\s*1;[^}]*transform:\s*translate3d\(var\(--design-canvas-toolbar-offset-x\),\s*0,\s*0\) scale\(1\);/s);
  expect(css).toMatch(/\.design-canvas-surface\[data-node-focus="closing"\] \.design-canvas-zoom\s*\{[^}]*opacity:\s*1;[^}]*transform:\s*translate3d\(0,\s*0,\s*0\) scale\(1\);/s);
  expect(css).toMatch(/\.design-canvas-surface\[data-node-focus="closing"\] \.design-canvas-tools,\s*\.design-canvas-surface\[data-node-focus="closing"\] \.design-canvas-zoom\s*\{[^}]*transition:\s*opacity 280ms var\(--design-canvas-ease-in-out\),\s*transform 280ms var\(--design-canvas-ease-in-out\);/s);
  expect(css).toMatch(/\.design-canvas-surface\[data-node-focus\] \.react-flow__pane\s*\{\s*pointer-events:\s*none;/s);
});

test("reduced-motion toolbar chrome keeps a fade while removing spatial travel", () => {
  expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*\.design-canvas-tools,\s*\.design-canvas-zoom\s*\{\s*transition:\s*opacity 160ms var\(--design-canvas-ease-out\) !important;\s*\}/s);
  expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*\.design-canvas-surface\[data-node-focus="opening"\] \.design-canvas-tools\s*\{\s*transform:\s*translate3d\(var\(--design-canvas-toolbar-offset-x\),\s*0,\s*0\) scale\(1\) !important;\s*\}/s);
  expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*\.design-canvas-surface\[data-node-focus="opening"\] \.design-canvas-zoom\s*\{\s*transform:\s*translate3d\(0,\s*0,\s*0\) scale\(1\) !important;\s*\}/s);
});

test("focused preview controls are larger and animate with the focus chrome", () => {
  expect(css).toMatch(/\.design-canvas-focus-actions\s*\{[^}]*bottom:\s*16px;[^}]*border-radius:\s*17px;[^}]*padding:\s*5px;/s);
  expect(css).toMatch(/\.design-canvas-focus-actions \[data-slot="button"\]\s*\{[^}]*width:\s*38px;[^}]*height:\s*38px;/s);
  expect(css).toMatch(/\.design-canvas-focus-dismiss\s*\{[^}]*z-index:\s*47;[^}]*inset:\s*0;/s);
  expect(focusedChromeSource).toContain("duration: motionAllowed ? 0.26 : 0");
  expect(focusedChromeSource).toContain("duration: motionAllowed ? 0.2 : 0");
});

test("selected Nodes do not ship an unreachable inline toolbar", () => {
  expect(nodeSource).not.toContain("design-canvas-node__toolbar");
  expect(nodeSource).not.toContain("Fit Node preview");
  expect(css).not.toContain("design-canvas-node__toolbar");
  expect(css).not.toContain("design-canvas-agent__versions");
});

test("Canvas uses the requested neutral background in both color schemes", () => {
  expect(css).toMatch(/\.design-canvas-surface\s*\{[^}]*background:\s*#e8eaeb;/s);
  expect(css).toMatch(/\.dark \.design-canvas-surface\s*\{\s*background:\s*#e8eaeb;/s);
});

test("Canvas menu surfaces leave presence opacity and transforms to the shared compositor track", () => {
  expect(css).toMatch(/\.design-node-catalog\s*\{[^}]*transform-origin:\s*var\(--radix-dropdown-menu-content-transform-origin,/s);
  expect(css).toMatch(/\.design-node-context-menu\s*\{[^}]*transform-origin:\s*var\(--radix-context-menu-content-transform-origin,/s);
  expect(css).toMatch(/\.design-canvas-agent__mention-menu\s*\{[^}]*transform-origin:\s*bottom center;/s);
  expect(css).not.toMatch(/\.(?:design-node-catalog|design-node-context-menu|design-canvas-agent__mention-menu)\[data-state="(?:open|closed)"\]/s);
  expect(css).not.toMatch(/\.(?:design-node-catalog|design-node-context-menu|design-canvas-agent__mention-menu)\s*\{[^}]*(?:transition:\s*(?:opacity|transform)|animation:)/s);
});

test("canvas chrome motion keeps the measured Agent height as its only layout transition", () => {
  expect(css).toMatch(/\.design-canvas-root\s*\{[^}]*--design-canvas-ease-out:\s*cubic-bezier\(0\.23, 1, 0\.32, 1\);[^}]*--design-canvas-ease-in-out:\s*cubic-bezier\(0\.77, 0, 0\.175, 1\);/s);
  expect(css).toMatch(/\.design-canvas-tools,\s*\.design-canvas-zoom\s*\{[^}]*transition:\s*opacity 240ms var\(--design-canvas-ease-out\),\s*transform 280ms var\(--design-canvas-ease-in-out\);/s);
  expect(css).not.toMatch(/\.design-canvas-tools,\s*\.design-canvas-zoom\s*\{[^}]*transition:[^}]*(?:right|left|bottom)/s);
  expect(css).toMatch(/\.design-canvas-focus-actions\s*\{[^}]*translate:\s*calc\(-50% \+ var\(--design-focus-actions-offset-x\)\) 0;[^}]*transition:\s*translate 280ms var\(--design-canvas-ease-in-out\);/s);
  expect(css).not.toMatch(/\.design-canvas-focus-actions\s*\{[^}]*transition:[^}]*(?:left|bottom)/s);
  expect(css).not.toMatch(/\.design-canvas-agent--floating\s*\{[^}]*transition:[^}]*(?:left|top)/s);
  expect(css).toMatch(/\.design-canvas-agent--floating\s*\{[^}]*transition:\s*height 280ms var\(--design-canvas-ease-in-out\);/s);
  expect(css).toMatch(/\.design-canvas-tools \[data-slot="button"\]:active:not\(:disabled\),[\s\S]*\.design-canvas-focus-actions \[data-slot="button"\]:active:not\(:disabled\)\s*\{[^}]*transform:\s*scale\(0\.97\);/s);
  expect(css).toMatch(/@media \(prefers-reduced-transparency: reduce\)[\s\S]*\.design-node-catalog,[\s\S]*backdrop-filter:\s*none;/s);
  expect(css).toMatch(/@media \(prefers-contrast: more\)[\s\S]*\.design-canvas-surface \.react-flow__selection/s);
  expect(screenSource).toContain("[0.23, 1, 0.32, 1]");
  expect(screenSource).not.toContain("CANVAS_MOTION_EASE_IN_OUT");
  expect(screenSource).toContain("duration: reduceMotion ? 0 : 0.24, ease: CANVAS_MOTION_EASE");
  expect(screenSource).not.toMatch(/\b(?:initial|animate|exit)=\{[^}]*\b(?:x|y|scale):/s);
  expect(screenSource).toContain('transform: "translate3d(0px, 0px, 0px) scale(1)"');
  expect(screenSource).not.toContain("translate3d(0, 0, 0)");
  expect(screenSource).not.toMatch(/translate3d\(-?[\d.]+px, 0, 0\)/);
  expect(screenSource).not.toMatch(/translate3d\(0, -?[\d.]+px, 0\)/);
  expect(floatingAgentSource).not.toContain("translate3d(0, 0, 0)");
  expect(floatingAgentSource).not.toMatch(/translate3d\(-?[\d.]+px, 0, 0\)/);
  expect(floatingAgentSource).not.toMatch(/translate3d\(0, -?[\d.]+px, 0\)/);
  expect(css).toMatch(/\.design-canvas-agent__mention-menu\s*\{[^}]*transform-origin:\s*bottom center;/s);
  expect(css).not.toContain("@keyframes design-canvas-menu-in");
  expect(css).not.toContain("@keyframes design-canvas-menu-out");
  expect(css).toMatch(/@media \(hover: hover\) and \(pointer: fine\)[\s\S]*\.design-canvas-topbar__icon-action:hover,[\s\S]*\.design-canvas-agent__composer-shell:hover[\s\S]*\.design-node-catalog__item:hover/s);
});

test("Agent activity cards keep Thinking compact, complete, and visually quiet", () => {
  expect(primitivesCss).toMatch(/\.dezin-agent-thinking\s*\{[^}]*font-size:\s*12\.5px;[^}]*line-height:\s*18\.75px;/s);
  expect(primitivesCss).toMatch(/\.dezin-agent-thinking__trigger\s*\{[^}]*border:\s*0;[^}]*background:\s*transparent;/s);
  expect(primitivesCss).toMatch(/\.dezin-agent-thinking\[data-active\] \.dezin-agent-thinking__trigger > span\s*\{[^}]*animation:\s*dezin-agent-shimmer 1\.4s linear infinite;/s);
  expect(primitivesCss).toMatch(/\.dezin-agent-task-row > header\s*\{[^}]*min-height:\s*44px;/s);
  expect(primitivesCss).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*animation-duration:\s*\.001ms !important;/s);
});
