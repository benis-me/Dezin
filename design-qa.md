# Design QA — Canvas Figma import and Agent output system

**Findings**

- No actionable P0, P1, or P2 findings remain.

**Source and implementation evidence**

- Source visual truth: `/tmp/dezin-beautiful-ui-audit/04-thinking-streaming-mobile.png`, `/tmp/dezin-beautiful-ui-audit/05-tool-chips-task-rows-mobile.png`, and the supporting desktop captures in `/tmp/dezin-beautiful-ui-audit/`.
- Rendered Agent implementation: `/tmp/dezin-agent-visual.V9u3EX/agent-panel.png`.
- Normalized side-by-side comparison input: `/tmp/dezin-agent-visual.V9u3EX/reference-vs-agent-panel.png`.
- Browser-rendered integration evidence: `/tmp/dezin-electron-qa.WFCUak/screens/06-main-agent-expanded.png` and `/tmp/dezin-electron-qa.WFCUak/screens/07-node-agent.png`.
- Browser-rendered Figma evidence: `/tmp/dezin-electron-qa.WFCUak/screens/04-figma-dialog-920x600-scrolled.png` and `/tmp/dezin-electron-qa.WFCUak/screens/05-figma-dialog-430x900.png`.
- Electron measurements and interaction log: `/tmp/dezin-electron-qa.WFCUak/electron-report.json`.

**Viewport and normalization**

- Source mobile capture: 390 × 844 pixels at a 390 × 844 CSS viewport, density 1.
- Focused implementation capture: 520 × 1180 pixels at a 520 × 1180 CSS viewport, density 1; the Agent panel is 352 CSS pixels wide with a 324-pixel output column.
- Comparison normalization: the implementation was proportionally scaled to 390 pixels wide and cropped to 390 × 844 before horizontal composition with the 390 × 844 source. The combined comparison is 780 × 844 pixels.
- Integration captures: Electron at 1360 × 900; responsive Figma checks at 920 × 600 and 430 × 900.
- State: dark Agent panel with assistant response, Sources, code and file diff, completed and active Task Rows, Trace, Tool Chips, export outcome, and Prompt Bar. Real persisted history supplied Task Row/Trace/Tool/Outcome/Export states; Search, Image, Streaming, Code, and Sources used deterministic rendered fixtures because the selected Project had no such persisted activity.

**Full-view comparison**

- The implementation keeps the reference's calm dark hierarchy, compact 44-pixel Task Rows, low-contrast hairlines, restrained radii, small metadata, and dense narrow-column composition without copying the gallery shell or its demo controls.
- Dezin intentionally retains its own panel chrome, semantic state colors, existing user message bubble, model controls, Stop/Retry/Reveal actions, and project typography. The reference's demo tabs, left trace rail, fabricated confidence actions, and unsupported structured blocks were not imported.
- The final Electron view preserves transcript scrolling and a fixed composer without overlap or horizontal overflow.

**Focused-region comparison**

- The normalized comparison directly checks the source Thinking/Search and Streaming sections against Dezin's message response, Sources, Task Row, Trace, Tool Chips, export outcome, and Prompt Bar at equivalent narrow-column density.
- Expanded body geometry measures icon start 29 px, icon-adjacent text start 50 px, and right inset 8 px. No vertical left rail remains.
- Collapsed details use `aria-hidden` and `inert`; expanding removes both. Reduced motion resolves transitions to 0 seconds, and rapid reversal settles to one panel.

**Required fidelity surfaces**

- Fonts and typography: existing Dezin Geist/mono stacks remain authoritative; 10–13 px metadata/body scale, optical weights, line heights, truncation, and code treatment remain legible at 352 px panel width.
- Spacing and layout rhythm: Task Row, Trace, Tool Chip, Sources, output, and Prompt Bar spacing match the reference density while preserving Dezin's 29/50/8 gutter contract. The 920 × 600 Figma dialog stays within 16 px vertical gutters and exposes a 349/438 px scroll region with fixed actions; the 430 × 900 dialog keeps 16 px side gutters.
- Colors and visual tokens: all surfaces map to existing Dezin background, surface, border, foreground, muted, success, destructive, and accent tokens. No reference-site colors are hard-coded.
- Image quality and asset fidelity: no source logos, illustrations, inline SVG, CSS drawings, or placeholder imagery were copied. Existing Lucide icons and actual generated images remain the only visible assets.
- Copy and content: the Figma action now says `Import into canvas` and the description explicitly says artifacts are added to this canvas. Agent labels describe real Job/activity state and never invent approvals, confidence, tables, or insights from markdown.

**Accessibility and interaction evidence**

- The Canvas is in the keyboard tab order. The Context Menu key opens `Add Design node`, exposes `Import from Figma`, and Escape returns focus to the Canvas.
- Blank Canvas has the Figma entry; Node menus do not. The menu fully closes before the dialog opens.
- Cancel and Escape restore Canvas focus. Dialog controls remain reachable at 920 × 600 and 430 × 900.
- Main and Node Agent panels were opened from real persisted history. Scroll, collapse/expand, rapid reversal, reduced motion, Prompt Bar stability, and the unchanged user bubble were verified.
- Electron console errors, warnings, page errors, external requests, Figma requests, PAT access, and provider calls were all zero.

**Comparison history**

1. Initial visual pass: no Agent-panel P0/P1/P2 mismatch. Clean-room adaptation preserved the reference hierarchy while retaining Dezin-specific semantics and gutters.
2. Interaction review found the legacy `Import project` label after moving import into the Canvas. Fixed to `Import into canvas`, updated the explanatory copy, and re-captured the final responsive dialogs.
3. Keyboard review found the Canvas surface at `tabIndex=-1`. Changed it to `0`, added a regression, and verified Tab → Context Menu → Figma entry → Escape focus return in Electron.
4. Coverage review found four Home-era Figma component contracts had not moved with the dialog. Added PAT single-flight, retry-key lifecycle, cancellation/Abort, and URL/credential boundary regressions. Documentation was also corrected so `200` covers existing-receipt continuation as well as exact replay.

**Open Questions**

- None.

**Implementation Checklist**

- [x] Canvas-only Figma import entry and project-scoped durable authority.
- [x] Keyboard, focus, responsive, cancellation, and idempotency coverage.
- [x] Typed Agent output registry and single renderer.
- [x] Message Response, Sources, Trace, Tool Group/Tool Chips, Search, Image, Outcome/Error/Export, and Prompt Bar adaptations.
- [x] Reduced motion, inert collapsed content, mobile overflow, and real Electron verification.

**Follow-up Polish**

- None required for handoff. New Approval, Insight, Records, Filter, or Fine-tune visuals should only be added after corresponding typed product payloads exist.

final result: passed
