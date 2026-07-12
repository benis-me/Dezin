# Composer Context Top Rail Design QA

Reference: supplied Option 1 composer image

## Evidence and environment

- source visual truth: `/tmp/codex-remote-attachments/019f49a7-a25d-76a2-b8d5-2ca94364ae69/2D7186A2-513C-4B5C-B6F5-5E7E7E5218BB/1-照片-1.jpg` (1068 x 1200)
- real application URL: `http://localhost:6273/` from `pnpm dev` in this worktree
- desktop viewport: 1440 x 1000
- narrow viewport: 390 x 844
- app state: dark theme; two local QA projects and two local QA moodboards; real attached reference image; real project and moodboard reference records
- Browser classification: invocation failed. The in-app Browser runtime initialized, but `agent.browsers.get("iab")` returned `Browser is not available: iab`; after the required troubleshooting check, `agent.browsers.list()` returned `[]`.
- permitted fallback: the repository has no Playwright config/package and `pnpm exec playwright --version` returned `Command "playwright" not found`; the preinstalled Playwright runtime drove the installed Chrome executable in a fresh headless context, as permitted by the Task 5 brief after Browser invocation failure.

### Implementation screenshots

- Home desktop full: `/tmp/dezin-composer-context-top-rail-qa/home-populated-desktop-1440x1000.png`
- Home desktop focused: `/tmp/dezin-composer-context-top-rail-qa/home-composer-focused-desktop.png`
- Home 390px: `/tmp/dezin-composer-context-top-rail-qa/home-populated-mobile-390x844.png`
- Home native-bridge Sharingan state: `/tmp/dezin-composer-context-top-rail-qa/home-sharingan-native-bridge-desktop-1440x1000.png`
- Project desktop full: `/tmp/dezin-composer-context-top-rail-qa/project-populated-desktop-1440x1000.png`
- Project desktop focused: `/tmp/dezin-composer-context-top-rail-qa/project-composer-focused-desktop.png`
- Project 390px before responsive fix: `/tmp/dezin-composer-context-top-rail-qa/project-populated-mobile-390x844.png`
- Project 390px after responsive fix: `/tmp/dezin-composer-context-top-rail-qa/project-populated-mobile-fixed-390x844.png`
- Project newest-message check: `/tmp/dezin-composer-context-top-rail-qa/project-newest-message-mobile-fixed-390x844.png`
- Moodboard desktop full: `/tmp/dezin-composer-context-top-rail-qa/moodboard-populated-desktop-1440x1000.png`
- Moodboard desktop focused: `/tmp/dezin-composer-context-top-rail-qa/moodboard-composer-focused-desktop.png`
- Moodboard 390px before responsive fix: `/tmp/dezin-composer-context-top-rail-qa/moodboard-populated-mobile-390x844.png`
- Moodboard 390px after responsive fix: `/tmp/dezin-composer-context-top-rail-qa/moodboard-populated-mobile-fixed-390x844.png`
- Moodboard newest-message check: `/tmp/dezin-composer-context-top-rail-qa/moodboard-newest-message-mobile-fixed-390x844.png`

### Combined comparison inputs

- full source plus Home implementation: `/tmp/dezin-composer-context-top-rail-qa/comparison-full-source-home.png`
- focused Option 1 plus Home composer: `/tmp/dezin-composer-context-top-rail-qa/comparison-focused-option1-home.png`
- Project 390px before/after: `/tmp/dezin-composer-context-top-rail-qa/comparison-project-mobile-before-after.png`
- Moodboard 390px before/after: `/tmp/dezin-composer-context-top-rail-qa/comparison-moodboard-mobile-before-after.png`

The source and implementation were opened separately, then combined into the full and focused comparison inputs above before fidelity judgment. The full comparison establishes overall density and hierarchy. The focused comparison is required because card titles, close controls, preview sizing, and the textarea boundary are too small to judge reliably in the full view.

The supplied image is a light-theme composer layout concept rather than a Dezin screen. Theme, surrounding navigation, model controls, and total page composition are therefore intentionally different. Fidelity judgment is limited to the accepted Option 1 structure: a compact single-row context rail before the instruction area, title-first cards, preview/icon, and a subtle remove affordance.

## Home

- top rail placement: passed
  - rail bounds at desktop: x 353, y 131.75, width 994, height 38
  - textarea begins at y 186.75, so the rail precedes it in both DOM and pixels
- compact card hierarchy: passed
  - card height: 36px
  - preview/icon container: 24px
  - only one truncated title line is visible
  - type/path/size metadata remains available in the native title tooltip and is not rendered as a second row
  - remove controls are low-emphasis 20px buttons and remain keyboard-addressable
- horizontal behavior: passed
  - rail computes `display:flex`, `flex-wrap:nowrap`, and `overflow-x:auto`
  - at 390px, scroll width 328 exceeds client width 304 while rail height remains one 38px row
  - document width remains 390px; the rail owns overflow rather than the page
- toolbar Sharingan button: absent
- hidden Sharingan double-click flow: passed within the available boundary
  - ordinary web mode double-click exercised the intended desktop-only guard: `Sharingan (clone from a URL) requires the desktop app.`
  - a second fresh browser context loaded the same real app with only the native bridge capability supplied before module initialization; double-click changed `Start a design` to `Sharingan`, and double-clicking `Sharingan` restored `Start a design`

## Project Agent

- top rail placement and sorting: passed
  - desktop rail cards begin at y 835; textarea begins at y 890; action row begins at y 947
  - image and project cards were added through the rendered attachment menu
  - dragging the actual project grip across the image grip changed settled DOM order from image/project to project/image
  - the file-drop overlay never appeared during context sorting
- removal focus and context-only send: passed
  - draft `Draft stays intact` remained unchanged
  - focus returned to the textarea and caret stayed at index 6
  - intercepted local run transport received `Reference files (read them from disk): .refs/1-__-1.jpg` with no typed brief
  - rail and textarea cleared after serialization
- responsive: passed after iteration 2
  - three cards force horizontal overflow: scroll width 525, client width 344, one-row height 38, `overflow-x:auto`
  - textarea width 344; add control x 23-55; model control x 202.125-329; send control x 335-367
  - document width remains 390px
  - newest user message bottom 134.75 is above composer top 343.203; overlap is false
  - iteration 3 regression coverage confirms desktop -> narrow -> desktop preserves the loaded composer and preview iframe nodes, unsent draft/caret/focus, and stored desktop split preference

## Moodboard Agent

- top rail placement and sorting: passed
  - desktop cards begin at y 843; textarea begins at y 898; action row begins at y 947
  - project and moodboard cards were added through the rendered attachment menu
  - dragging the actual moodboard grip across the project grip changed settled DOM order from project/moodboard to moodboard/project
  - the file-drop overlay never appeared during context sorting
- removal focus and context-only send: passed after iteration 1
  - draft remained unchanged, focus returned, and caret now remains at its prior index
  - intercepted local message transport received `Reference Dezin projects: QA Reference Project (42aee0db-10df-48e3-8d8d-558d0c1eb987)` with no typed brief
  - rail and textarea cleared after serialization
- responsive: passed after iteration 2
  - two 184px cards force horizontal overflow: scroll width 378, client width 344, one-row height 38
  - textarea width 344; add control x 23-55; model control x 202.125-329; send control x 335-367
  - document width remains 390px
  - newest assistant message bottom 169.5 is above composer top 351.203; overlap is false
  - iteration 3 regression coverage confirms desktop -> narrow -> desktop preserves the loaded composer node, unsent draft/caret/focus, replayed canvas context insertion, and stored desktop split preference

## Responsive and console

- 390px horizontal rail behavior: passed
- clipping/overlap: none after the responsive fix
- page-level horizontal overflow: none
- Project and Moodboard panel orientation below 640px: vertical; composer and artifact/canvas each receive full viewport width
- breakpoint orientation changes update the outer groups in place without remounting their loaded descendants after iteration 3
- page identity: Home, Project, and Moodboard all reported title `Dezin` and their expected meaningful heading/textbox
- blank-page check: passed on all three surfaces
- framework overlay check: none on all three surfaces
- new console errors: none
- React warnings: none
- HTTP failures in the clean smoke pass: none

The local QA projects intentionally have no generated preview run. For the final console-only smoke pass, preview iframe requests were fulfilled with inert local HTML so missing fixture previews would not create unrelated 404 noise; the Home, Project composer, Moodboard composer, routing, DOM, and console remained the real worktree application.

## Interaction evidence

- Home: attach image -> add project reference -> inspect compact rail -> horizontal mobile scroll -> desktop-only Sharingan guard -> native-capability entry/exit
- Project: attach image -> add project reference -> drag by visible grip -> verify order -> remove -> verify focus/draft/caret -> context-only send -> verify serialized payload and clear
- Moodboard: add project reference -> add moodboard reference -> drag by visible grip -> verify order -> remove -> verify focus/draft/caret -> context-only send -> verify serialized payload and clear
- responsive: repeat populated rails at 390px -> verify full-width controls -> force overflow -> inject newest local response through intercepted transport -> compare message/composer rectangles

## Fidelity surfaces

- fonts and typography: passed. Dezin keeps its existing compact product typography and optical hierarchy. Card text is one 12px medium-weight truncated line; no visible metadata row competes with the title. The source uses larger light-theme text, but the accepted implementation requirement is the Dezin 36px rail rather than a source-theme transplant.
- spacing and layout rhythm: passed. Cards are 36px high with 6px gaps, 24px preview/icon slots, a subtle 8px radius, and a divider before the textarea. Rail, textarea, and action rows remain visually distinct without an empty-state gap.
- colors and visual tokens: passed. Existing Dezin border, card, surface, foreground, muted, ring, and brand tokens are used consistently. The light source palette is not imported into the dark Dezin product shell; contrast and hover/focus affordances remain legible.
- image quality and asset fidelity: passed. The attached JPEG is rendered as the real image, cropped with `object-fit: cover`; project/moodboard context uses the existing Lucide icon family. No custom inline SVG, CSS drawing, emoji, placeholder image, or handcrafted asset replaces source content.
- copy and content: passed. Only user-facing titles are visible on cards. Project/moodboard/file type, path, and size remain tooltip-only. Placeholders and action labels retain the existing product copy.
- icons and controls: passed. Icons share one stroke family; remove and grip controls align within 36px cards and remain accessible by name.
- accessibility: passed for the exercised surface. Rails expose list/listitem semantics; remove and drag controls have labels; screen-reader move controls remain; focus and selection are restored; mobile controls stay on-screen.

## Comparison and iteration history

### Iteration 1 - Moodboard caret preservation

- finding: P2 behavior regression. Removing a Moodboard context card restored focus and the draft but moved a live caret from index 4 to index 17 (the end).
- RED: focused test changed to place the caret at index 5; `moodboard-ui.test.tsx` failed with `expected 19 to be 5`.
- root cause: the removal path reused `focusComposerEnd`, which unconditionally called `setSelectionRange(value.length, value.length)`; the working Project path only restored focus.
- fix: capture the Moodboard textarea selection before state removal, restore focus on the next animation frame, then restore that selection.
- GREEN: focused Moodboard file passed 105/105.
- post-fix rendered evidence: live removal kept draft, focus, and selection `{ start: 4, end: 4 }`.

### Iteration 2 - 390px Project and Moodboard clipping

- finding: P2 responsive layout regression. Horizontal panel minimums squeezed the 390px Project conversation composer to 99px and the Moodboard agent composer to 116.8125px; card rails and model/send controls extended outside those panes.
- before evidence: `project-populated-mobile-390x844.png`, `moodboard-populated-mobile-390x844.png`, and the two before/after comparison inputs.
- RED: two focused loading-layout tests expected horizontal resize separators at the narrow breakpoint and failed because both separators remained vertically oriented.
- root cause: the Project and Moodboard resizable groups always used horizontal orientation even when their summed pixel minimums exceeded the viewport.
- fix: use the existing `useMediaQuery("(max-width: 639px)")` hook to switch only the outer Project and Moodboard groups to vertical orientation; avoid persisting vertical height ratios into desktop width preferences; reduce only the narrow artifact/canvas minimum to 240px.
- GREEN: focused responsive files passed 118/118.
- post-fix evidence: Project and Moodboard separators are horizontal; both composers are 344px wide inside a 390px document; all controls fit; forced context overflow remains one scrollable row; newest-message overlap is false.

### Iteration 3 - Breakpoint lifecycle preservation

- finding: Important lifecycle regression. Breakpoint-derived keys on the outer Project and Moodboard resizable groups remounted their loaded descendant trees whenever the viewport crossed 639px.
- RED: the focused loaded-state transition tests failed `2 failed, 118 passed`; both found a replacement Message textarea after desktop -> narrow, and the Moodboard replacement had already lost its draft.
- root cause: React treated the narrow and desktop groups as different keyed component instances even though `Group` supports changing `orientation` as a prop.
- fix: remove only the four dynamic keys from the loading and loaded Project/Moodboard groups, retaining responsive orientation, minimum sizes, and desktop-only persistence guards.
- GREEN: the two focused files passed `120/120`; desktop -> narrow -> desktop retained composer and preview identity, transient draft/context/caret/focus state, and both stored desktop split preferences.
- verification boundary: focused suites and `git diff --check`; full CI was not rerun for this review follow-up by instruction.

## Findings

- No remaining actionable P0, P1, or P2 findings.
- No P3 polish item is required for acceptance. The source/implementation theme difference is intentional product-system preservation, not fidelity drift.

## Automated verification

- `pnpm --filter @dezin/web test`: 46 files passed, 504 tests passed
- `pnpm typecheck`: `TYPECHECK: PASS`
- `pnpm build:check`: `BUNDLE: PASS`, total JS gzip 771.0 KiB / 806.6 KiB
- `git diff --check`: clean
- `pnpm run ci`: exit 0; coverage suites passed; `PROCESS LEAKS: PASS`; bundle passed; production audit reported no known vulnerabilities
- post-review lifecycle regression: focused Project/Moodboard screen files passed, 120 tests passed

final result: passed
