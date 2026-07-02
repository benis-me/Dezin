# Moodboard Project Agent Reference Design

## Goal

Design-project Agents can reference existing Moodboards from the project composer. During a run, the Agent receives a budgeted understanding of the selected Moodboard, including canvas structure, notes, recent board conversation, and usable local asset file paths.

## Product Shape

- Entry point: the existing project composer `+` menu.
- UI pattern: reuse Dezin's current menu, chip, icon-button, and compact composer patterns.
- User-visible state: selected Moodboards appear as removable compact chips above the input, next to attached files and marked targets.
- Conversation record: the user prompt remains readable and includes a compact reference line naming the Moodboard, not a full hidden context dump.
- Scope: design projects reference Moodboards. This does not export a Moodboard, clone a board into a project, or create a new project from a Moodboard.

## Runtime Context

- `RunInput` carries `moodboardRefs`.
- The daemon resolves each referenced board at run start.
- Context is budgeted: board metadata, counts, ranked relevant nodes, recent node index, recent assets, recent messages, and local asset file paths.
- The full raw canvas is not injected into the prompt.
- Missing, archived, or deleted boards are ignored with a visible process note when practical; a missing board should not crash an otherwise valid run.
- The Agent is instructed to treat Moodboard assets as references or source materials, and to use provided file paths when copying or adapting media.

## Data Flow

1. User opens project composer.
2. User chooses `+` → `Reference a moodboard` → board name.
3. Composer stores `{ id, name }` in local state and shows a chip.
4. On send, the visible prompt gets a compact reference line.
5. `api.streamRun` sends `moodboardRefs`.
6. `handleRun` builds an agent-only context block and passes the augmented message to Standard and Prototype generation paths.
7. Stored conversation history remains concise while the active Agent receives the richer runtime context.

## Verification

- Web unit test: selecting a Moodboard from the composer sends `moodboardRefs` to `streamRun` and renders/removes the chip.
- Daemon unit/integration test: a run with `moodboardRefs` injects board context and local asset paths into the Agent message.
- Typecheck must pass.
