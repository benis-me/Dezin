# Moodboard Canvas Design

## Goal

Add a first-class Moodboard area to Dezin for pre-design material collection, spatial organization, AI image generation, and agent-assisted interpretation. The reference implementation is Awen, but Dezin should distill its canvas architecture rather than inherit its full product surface.

## Product Shape

- Home sidebar gains a `Moodboard` navigation item.
- Moodboard index mirrors the Projects gallery density: board items, search, sort, grid/list, empty state, rename/archive/delete.
- A board opens into a workspace-like split view:
  - Left: an Agent conversation panel scoped to the board.
  - Right: an infinite canvas for image, note, section, and future video nodes.
- The board Agent can read a serialized canvas context and can add generated/collected assets back onto the board.

## MVP Scope

Route A is the approved first version:

- Image generation is real end-to-end.
- Video generation is represented in provider/model configuration and node data shape, but real video jobs are deferred.
- Canvas supports pan, zoom, select, drag, resize, image upload/drop, sticky notes, sections, and generated image placement.
- Board state is local-first and persisted in the Dezin store, with binary assets on disk under the app data directory.
- Existing Dezin components and spacing/tokens are reused; no standalone Awen visual language is imported.

## Awen Concepts To Distill

- Leafer-based high-performance canvas runtime.
- Zustand editor store split into canvas state, selection state, tools, and history.
- Node registry that maps node type to renderer, icon, default size, and serializable data.
- Hooks for canvas setup, node interaction, uploads, undo/redo, shortcuts, and generation.
- Provider catalog pattern: runtime provider readiness is separate from default model choices.

## Dezin Architecture

### Data

New local store entities:

- `moodboards`: id, name, createdAt, updatedAt, archivedAt, cover asset id.
- `moodboard_nodes`: id, boardId, type, x, y, width, height, rotation, zIndex, data JSON, createdAt, updatedAt.
- `moodboard_messages`: id, boardId, role, content, createdAt.
- `moodboard_assets`: id, boardId, kind, fileName, mimeType, width, height, source, createdAt.

Assets live on disk under `moodboards/<boardId>/assets/<assetId>.<ext>`.

### API

Add daemon routes:

- `GET /api/moodboards`
- `POST /api/moodboards`
- `GET /api/moodboards/:id`
- `PATCH /api/moodboards/:id`
- `DELETE /api/moodboards/:id`
- `GET /api/moodboards/:id/nodes`
- `PUT /api/moodboards/:id/nodes`
- `POST /api/moodboards/:id/assets`
- `GET /api/moodboards/:id/assets/:assetId`
- `GET /api/moodboards/:id/messages`
- `POST /api/moodboards/:id/messages`
- `POST /api/moodboards/:id/generate-image`

### Settings

Upgrade media generation settings without overbuilding:

- Keep existing OpenAI-compatible image fields working.
- Present them as a `Media` settings section rather than burying them under generic Connection copy.
- Add default media model roles: image generation and video generation.
- Store video provider/model fields for future use, but mark runtime support as not connected in the UI until real jobs exist.

### Frontend

New screens:

- `MoodboardsScreen`
- `MoodboardScreen`

Canvas modules:

- `moodboard/types.ts`
- `moodboard/store.ts`
- `moodboard/node-registry.ts`
- `moodboard/MoodboardCanvas.tsx`
- `moodboard/MoodboardAgentPanel.tsx`

The first canvas renderer should use Leafer if the dependency footprint stays contained. If integration becomes disproportionately heavy, fall back to a minimal DOM transform canvas for v1 while preserving the node registry and editor-store boundary.

## UX Rules

- The canvas is a working tool surface, not a decorative board.
- Use icon buttons with tooltips for tools: select, hand, note, section, image upload, generate.
- Board item cards use the same restraint as Project cards: preview first, compact metadata, hover actions.
- The Agent panel must show the same message discipline as Project conversations, but it can start simpler: text messages, generated asset cards, and a compact canvas context receipt.
- Empty board canvas should offer direct actions: upload images, paste/drop, generate image.

## Deferred

- Real video generation jobs.
- Audio/3D nodes.
- Collaboration and remote cursors.
- Full Awen workflow graph/node execution.
- Export moodboard to project brief.
- Moodboard-to-project attach flow.

## Verification

- Unit tests for store CRUD and API routes.
- Web tests for navigation, board creation, node persistence, and media settings save/load.
- Typecheck and full test suite.
- Manual browser verification: create board, upload or generate image, drag/zoom/select, leave and re-enter board, confirm state persists.
