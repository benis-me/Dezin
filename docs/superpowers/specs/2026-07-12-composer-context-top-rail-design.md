# Composer Context Top Rail

**Status:** Approved direction (Option A)
**Date:** 2026-07-12

## Goal

Restore Sharingan to its intentionally hidden desktop gesture and make attached/reference context feel like part of the request before the user types instructions.

The same compact context treatment applies to:

- the Home design composer;
- the Project Agent composer;
- the Moodboard Agent composer.

## Problems to solve

1. Home currently exposes a visible Sharingan toolbar button even though the intended entry is the existing heading double-click gesture.
2. Context cards currently appear after the textarea or action row, so their visual order does not match their semantic role as input to the prompt.
3. Home uses large preview-led cards while Project and Moodboard use fixed-width two-line cards. The inconsistent sizes make context feel heavier than the instruction itself.

## Interaction design

### Sharingan

- Remove the visible `Sharingan` button from the Home composer toolbar.
- Keep double-click on the Home heading as the only entry and exit gesture.
- Preserve the desktop-only gate, forced Standard mode, authorization affirmation, URL validation, Sharingan title/eye treatment, and URL placeholder.
- Keep the heading's hover title as a subtle hint; do not add a replacement visible control.

### Context top rail

When context exists, render one horizontal rail inside the composer, before the textarea:

- Home: context rail → textarea → action row.
- Project Agent: queued prompts (when present) → context rail → textarea → action row.
- Moodboard Agent: context rail → textarea → action row.

When context is empty, render no rail, separator, or reserved space.

The rail never wraps. It scrolls horizontally when the cards exceed the available width so the composer grows by at most one compact row.

## Card design

All three composers use one compact card style rather than separate `hero` and `panel` densities.

- Height: 36px.
- Width: content-sized with a 112px minimum and 184px maximum, with a single truncated title.
- Leading visual: 24px square image thumbnail for previewable files; otherwise a quiet type icon.
- Trailing remove control: 20px, always available, visually subdued until hover/focus.
- Visible text: title only. Type, path, file size, and other metadata remain available through the card tooltip/title.
- Surface: neutral card background, one restrained border, 8px radius, no shadow stack.
- Rail separation: a bottom hairline and compact bottom padding, matching the supplied Option 1 reference.
- Motion: short opacity/border transitions only, disabled under reduced motion.

Project and Moodboard context remains sortable. The drag handle keeps its reserved space but is visually quiet until card hover or keyboard focus. Existing screen-reader move controls remain available. Home context remains non-sortable.

## Component changes

`AgentComposerContextCards` becomes a single compact presentation:

- remove the `hero` versus `panel` visual branch;
- retain typed icons, thumbnails, horizontal overflow, removal, drag sorting, and keyboard sorting;
- expose `data-context-layout="top-rail"` for behavior/layout tests;
- preserve the `Attached context` accessible list label.

The three composer call sites own only placement and state. Context item data, deduplication, serialization, pending references, file upload behavior, and send-time clearing remain unchanged.

## Focus and error behavior

- Removing a card returns focus to the corresponding textarea and preserves the draft/caret behavior already implemented.
- Failed project reference/file import behavior is unchanged.
- Drag/drop overlays continue to target the whole composer; dragging context cards must not trigger file-drop overlays.
- A context-only request remains sendable.

## Responsive behavior

- The same single-row rail is used on desktop and narrow layouts.
- Cards keep their compact dimensions and horizontal scrolling instead of wrapping or shrinking text/icons below usable sizes.
- The Home toolbar may wrap independently, but the context rail does not participate in toolbar layout.

## Testing

### Automated

- Home exposes no visible Sharingan button, while heading double-click still enters and exits Sharingan.
- Shared context cards render the compact dimensions, thumbnail/icon, title, remove control, and `top-rail` layout marker.
- Project and Moodboard preserve drag/keyboard reorder and removal focus restoration.
- Home, Project, and Moodboard DOM order places the context rail before the textarea and action row.
- Context-only send and serialization behavior remains unchanged.

### Rendered QA

- Verify Home, Project Agent, and Moodboard Agent in the real running app.
- Compare the populated composer against the supplied Option 1 reference: top placement, one-row density, visual hierarchy, horizontal overflow, and removal affordance.
- Exercise add, remove, reorder, context-only send, and Sharingan double-click enter/exit.
- Check desktop and a narrow viewport for clipping, unexpected wrapping, focus loss, console errors, and composer/message overlap.

## Acceptance criteria

- No visible Sharingan entry remains in the Home toolbar.
- Double-clicking the heading is the only Sharingan entry/exit gesture and still works in Electron.
- Every populated composer shows compact context cards above its textarea.
- No large Home hero cards or below-toolbar context rail remains.
- Context state and prompt serialization are behaviorally unchanged.
- Relevant automated tests, typecheck, build, and rendered interaction QA pass.

## Non-goals

- No new attachment or reference types.
- No changes to daemon context serialization or run APIs.
- No replacement Sharingan menu item, keyboard shortcut, or visible badge.
- No redesign of the model picker, attach menu, send button, queue cards, or message transcript beyond spacing required by the top rail.
