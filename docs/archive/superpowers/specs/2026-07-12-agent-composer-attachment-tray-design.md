# Agent Composer Attachment Tray Design

## Goal

Raise the Home, Project Agent, and Moodboard Agent composers to one production-quality request system inspired by the supplied attachment-composer reference. Uploaded files, linked paths, Dezin projects, moodboards, effects, selected preview elements, selected canvas nodes, and imported context must be immediately legible as objects without leaking their serialized prompt text into the textarea.

This is a presentation and interaction follow-up to `2026-07-03-agent-composer-context-cards-design.md`. The existing structured frontend model, send-time serialization, and daemon protocol remain authoritative.

## Considered Directions

### A. Restyle the existing chips

Keep the current wrapped chips above the textarea and only improve spacing, icons, and hover states.

- Lowest implementation risk.
- Preserves maximum textarea space.
- Still collapses files, images, projects, and selected elements into nearly identical tokens; long names and useful metadata remain hard to scan.

### B. Large preview cards for every item

Render all context as large image/document cards below the composer.

- Strongest visual preview.
- Closest literal match to the reference.
- Too tall for the 280–520 px Moodboard Agent panel and likely to dominate the Project Agent conversation column.

### C. One attachment rail with two densities — selected

Keep the textarea and tool row compact. When context exists, reveal a horizontally scrollable rail separated by a quiet divider. Home uses the richer reference-style card because it has a wide creation surface; Project Agent and Moodboard Agent use a compact card because their conversation panels can be only 280 px wide. Both densities share the same model, item anatomy, sorting, removal, and focus behavior.

- Preserves the dense Dezin tool shell.
- Gives Home real image/reference previews while adapting the same vocabulary to narrow Agent panels without wrapping them into a tall stack.
- Gives images and references enough identity to be understood at a glance.
- Reuses the existing `AgentComposerContext` model and `@dnd-kit/react` sorting path.

## Scope

In scope:

- Home initial-design composer in `HomeScreen`.
- Project Agent composer in `WorkspaceScreen`.
- Moodboard Agent composer in `MoodboardAgentPanel`.
- Shared presentation in `AgentComposerContext`.
- Structured Home display for dropped images, local paths, referenced projects, and imported `.fig` context; serialization still happens only on Design.
- Uploaded Project Agent image preview using the stable reference URL returned by the existing upload path.
- Every existing context type: file, local path, project, moodboard, effect, preview target, canvas node, and text context.
- Drag reorder, keyboard move fallbacks, remove, focus, hover, active, drop-target, and reduced-motion states.
- Real-file drag overlay wording and visual treatment.
- Moodboard upload wording that accurately says images are added to the board rather than attached to the Agent.
- Browser fallback semantics in `AttachMenu`: only file upload may fall back to the hidden file input; folder/code actions cannot masquerade as a file upload when native path picking is unavailable.
- Narrow panel and wider desktop composer behavior.

Out of scope:

- Backend storage or content-block protocol changes.
- Historical transcript cards.
- Cross-composer drag and drop.
- Upload progress persistence or retry queues.
- Turning Moodboard canvas uploads directly into Agent context; uploaded images continue to become canvas nodes and can then be sent to the Agent through the existing canvas-node insertion path.
- Refactoring persisted running prompts into a new structured queue schema. Queued prompts keep their current baked text plus moodboard/effect references for backward compatibility; tests must prove no context is lost.

## Information Architecture

Every composer has three stable layers:

1. **Message layer** — the textarea contains only user-authored instructions.
2. **Action layer** — add/context menu on the left; agent/model and send/queue/stop actions on the right.
3. **Context layer** — present only when context exists; a separated horizontal attachment rail. Home places its rich rail between message and actions, matching the wide reference surface. Narrow Agent panels place their compact rail below actions so context never competes with typing.

Queued prompts remain above the message layer in Project Agent because they describe execution order rather than current-request context. Design-system controls remain outside the composer shell.

## Context Card Anatomy

Each shared card is a list item with:

- A preview tile. Home cards use a 64–72 px visual area; panel cards use a 28 px tile. Uploaded images use an actual preview. Other items use the existing Lucide type icon on a restrained secondary surface.
- A single-line title with the full value available through `title`.
- A concise type label such as `Image`, `File`, `Folder`, `Project`, `Moodboard`, `Effect`, `Selected element`, `Canvas selection`, or `Imported context`.
- Optional secondary metadata when it is useful and safe to show, truncated rather than wrapped.
- A remove button with at least a 28 px panel target and 32 px Home target, plus visible keyboard focus. It may become visually quieter until hover/focus on precise pointers, but remains available on touch.
- A drag affordance when two or more cards exist. The entire card can remain sortable through `useSortable`; a visible grip communicates the behavior.

Cards use existing background, foreground, border, brand, focus-ring, and surface tokens. No new hard-coded palette or decorative glass treatment is introduced.

## Layout and Responsive Behavior

- Every rail uses one horizontal row with `overflow-x: auto`; it never wraps into multiple rows.
- Home cards use a richer fixed basis and preview area. Panel cards use a compact 36–40 px height and expose part of the next card in a narrow panel, communicating horizontal continuity.
- The shared renderer accepts an explicit `density="hero" | "panel"` rather than inferring layout from item count.
- Long titles and paths truncate. The rail owns horizontal overflow, so the composer and page never gain horizontal scroll.
- The composer height observer already used by both Agent surfaces continues to include the rail, preserving transcript bottom clearance.

## Interaction

- Adding a context item reveals the rail without moving focus away from the textarea.
- Removing a card keeps the textarea focused when possible and collapses the rail when the final item is removed.
- Internal card sorting stays on `@dnd-kit/react`. Native upload overlays continue to respond only to a real `Files` drag.
- Dragging a card lowers opacity and gives it a raised shadow. The current drop target receives a clear focus-color outline.
- Dragging files over Project Agent shows `Add files to this request`; dragging media over Moodboard Agent says `Add images to this moodboard` because that action creates board nodes rather than Agent attachments.
- Enter/Shift+Enter, IME composition, send-only-context, queue, stop, and serialization behavior remain unchanged.
- Motion is limited to 150–180 ms state transitions and disabled under `prefers-reduced-motion`.

## Data Model

Extend only the frontend presentation model with optional metadata:

- `previewUrl?: string` for an already-read local image data URL.
- `mimeType?: string` and `size?: number` for concise display when available.

Home can keep image bytes and referenced-project bytes in its existing caller-owned state, but maps them to the shared display model. Local paths and imported `.fig` summaries become Home context items instead of being appended into the visible textarea; `submit` adds their serialized suffix when it calls `onNewProject`.

The fields are never serialized to the daemon. Existing items without them retain icon-based rendering.

## Accessibility

- The rail is labelled `Attached context` and uses list/listitem semantics.
- Remove and drag controls retain explicit item-specific accessible names.
- Existing screen-reader move-before/move-after controls remain available.
- Focus rings use the existing ring token and remain visible on every interactive element.
- Image previews use the item title as alt text; decorative type icons are hidden from assistive technology.
- The rail can be scrolled without trapping keyboard focus.

## Error and Edge States

- Failed uploads continue to show the existing error toast and do not leave a false ready card.
- Missing previews fall back to a type tile.
- Duplicate ids continue to replace their existing card through `upsertContextItems`.
- Unknown or empty subtitles do not create blank metadata rows.
- Very long names, paths, and translated labels must not expand card width.
- One card has no active drag affordance; two or more cards expose drag state and keyboard ordering controls.

## Testing and Verification

Use TDD before production edits.

Automated coverage:

- Shared rail renders list semantics, type labels, image previews, fallback tiles, remove, and reorder behavior.
- Home image/project/path/`.fig` context renders through the rich density without modifying textarea text, and Design still emits the complete pending image/reference/context payload.
- Project Agent upload of an image adds a preview-backed context card while preserving the serialized reference path.
- Project Agent and Moodboard Agent place context after the action row and continue allowing context-only send.
- Internal sortable interaction does not trigger the file-drop overlay.
- Existing IME, queue, stop, reference, and canvas insertion tests remain green.

Rendered verification:

- Inspect Home at desktop and narrow window widths.
- Inspect Project Agent at a normal desktop split and at its minimum conversation width.
- Inspect Moodboard Agent at 280 px and 520 px widths.
- Exercise add, file drop, selected canvas insertion, reference project/moodboard, remove, reorder, keyboard focus, and reduced motion.
- Confirm the textarea remains the dominant instruction surface and the attachment rail reads as request context rather than another nested panel.
