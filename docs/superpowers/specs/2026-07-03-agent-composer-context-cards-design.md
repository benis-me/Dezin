# Agent Composer Context Cards Design

## Goal

Agent composer context should no longer appear as raw prompt text before send. Files, local paths, referenced Dezin projects, referenced moodboards, selected preview elements, and selected moodboard canvas nodes should appear as typed cards in the composer. Users can remove cards and drag reorder them. Sending still serializes the cards into the existing prompt/runtime fields so backend behavior stays stable.

## Scope

This feature covers the Project Agent composer in `WorkspaceScreen` and the Moodboard Agent composer in `MoodboardAgentPanel`.

In scope:

- Shared composer context item model.
- Reusable card strip/component for rendering typed context cards.
- Drag reorder within the context card strip.
- Remove action per card.
- Project Agent cards for uploaded files, local paths, referenced projects, referenced moodboards, and selected preview elements.
- Moodboard Agent cards for local paths, referenced projects, selected canvas nodes, and imported text context.
- Send-time serialization into the existing text prompt and existing `moodboardRefs` runtime field where supported.
- Tests for card rendering, removal, reorder, and send serialization.

Out of scope:

- Backend storage changes for structured content blocks.
- Historical chat bubble card rendering.
- Cross-composer drag between Project Agent and Moodboard Agent.
- Rich previews for file/image contents beyond card labels and metadata.

## Data Model

Add a shared frontend type, `AgentComposerContextItem`, with a stable `id`, `type`, display metadata, and type-specific payload.

Expected item types:

- `file`: uploaded Project Agent reference file with `{ name, path }`.
- `local-path`: native file/folder path selected through Electron.
- `project`: referenced Dezin project with `{ id, name }`, plus uploaded reference path in the Project Agent once resolved.
- `moodboard`: referenced moodboard with `{ id, name }`.
- `preview-target`: selected preview element with the existing `MarkupTarget` payload.
- `canvas-node`: selected moodboard node summary with node id, label, type, position, and dimensions.
- `text-context`: imported context such as `.fig` summaries with `{ title, body }`.

The model lives in the web frontend. It is not sent directly to the daemon.

## UX

The composer shows cards above the textarea, inside the existing composer shell. Cards are compact rows/chips with:

- Type icon.
- Primary label.
- Secondary metadata when useful.
- Drag handle.
- Remove button.

Cards wrap or stack within the composer without covering the textarea or action row. Dragging a card over another card reorders it. Keyboard behavior remains unchanged: Enter sends, Shift+Enter creates a newline.

The existing queued prompt reorder UI remains separate.

## Project Agent Flow

`WorkspaceScreen` replaces separate `attachments`, `moodboardRefs`, and `selectedTargets` composer rendering with context cards.

Send flow:

1. Use the textarea value as the user-authored base prompt.
2. Serialize `preview-target` cards with the existing `formatMarkupTarget` scoped-edit block.
3. Serialize `file`, `local-path`, `project`, and `text-context` cards into the same reference text Dezin already uses.
4. Serialize `moodboard` cards with the existing moodboard reference line.
5. Pass moodboard references to `runBrief` as the existing `moodboardRefs` field.
6. Clear textarea and context cards after send.

When a run is already in flight, the queued prompt stores the serialized text and moodboard refs, matching current behavior.

## Moodboard Agent Flow

`MoodboardAgentPanel` owns a context card list in addition to textarea text.

Send flow:

1. Use the textarea value as the user-authored base prompt.
2. Serialize `canvas-node`, `local-path`, `project`, and `text-context` cards into a prompt suffix.
3. Call existing `onSend(content)` with the serialized text.
4. Clear textarea and context cards after send.

`MoodboardScreen` changes selected canvas insertion from raw text insertion to a typed `canvas-node` composer insertion. Existing selected-node formatting can remain as the serialization body.

Moodboard file upload still calls `onUploadFiles` and creates image nodes on the board. It does not add Agent composer cards in this iteration because the current callback does not return a stable, serializable agent reference. Users can still send those uploaded image nodes to the Agent as `canvas-node` cards after upload.

## Error Handling

- Failed project reference upload keeps the card out of the composer and shows the existing error toast.
- Duplicate project, moodboard, file path, and preview target cards should be ignored or replaced rather than duplicated.
- Sending with only cards and no textarea text is valid when serialization produces non-empty content.
- Sending is disabled only when there is no textarea text and no context cards.
- If drag payload parsing fails, leave ordering unchanged.

## Testing

Use TDD before implementation.

Targeted tests:

- Shared composer card component renders labels, removes items, and reorders by drag/drop.
- Project Agent sends card-only context and serializes files/local paths/preview targets/moodboards into existing prompt text.
- Project Agent passes moodboard refs through `runBrief`/queue behavior as it does today.
- Moodboard Agent converts canvas insertion into a card, can reorder/remove it, and serializes it on send.
- Existing composer keyboard send and queue reorder behavior still pass.

Verification:

- `pnpm --filter @dezin/web test -- ...` for the focused web tests.
- `pnpm --filter @dezin/web build` or the repo's current typecheck/build command after implementation.
- Browser or Electron smoke check for both Project Agent and Moodboard Agent composers.
