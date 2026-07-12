# Agent Composer Attachment Tray Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Home, Project Agent, and Moodboard Agent one preview-capable attachment system with rich Home cards and compact Agent-panel cards while preserving every existing serialization and run behavior.

**Architecture:** Extend only the frontend `AgentComposerContextItem` presentation metadata, then keep one shared `AgentComposerContextCards` renderer with explicit `hero` and `panel` densities. Home maps its existing image/project payloads plus new path/`.fig` context into the shared renderer; `WorkspaceScreen` and `MoodboardAgentPanel` keep the existing `@dnd-kit/react` sortable path and send-time serialization. No daemon API changes are introduced.

**Tech Stack:** React 19, TypeScript, Tailwind utility classes, Lucide icons, `@dnd-kit/react`, Vitest, Testing Library.

## Global Constraints

- Scope is exactly Home, Project Agent, Moodboard Agent, the shared context renderer, and the shared add menu.
- Keep the daemon protocol and existing send-time prompt serialization unchanged.
- Native upload overlays must respond only to real `Files` drags; internal sortable drags must never open the upload overlay.
- Use the existing Dezin surface, border, foreground, brand, and focus-ring tokens; add no hard-coded palette or glass treatment.
- Every context rail is one horizontal row with owned overflow; it never wraps or creates page-level horizontal scroll.
- Home uses `density="hero"`; Project Agent and Moodboard Agent use `density="panel"`.
- Moodboard file actions remain board uploads and must say so; they must not render false Agent context cards.
- Running queue storage remains backward compatible `{ text, moodboardRefs?, effectRefs? }`; tests must prove the baked prompt retains all current context.
- Preserve Enter, Shift+Enter, IME, queue, stop, context-only send, and canvas insertion behavior.
- Motion is 150–180 ms, uses ease-out behavior, and has a `motion-reduce` fallback.

---

### Task 1: Shared preview-capable attachment rail

**Files:**
- Modify: `apps/web/src/components/AgentComposerContext.tsx`
- Test: `apps/web/src/components/AgentComposerContext.test.tsx`

**Interfaces:**
- Consumes: existing `AgentComposerContextItem`, `moveContextItem`, `removeContextItem`, `upsertContextItems`, and `@dnd-kit/react` sortable events.
- Produces: `AgentComposerContextCards<T>`, accepting `{ items, onChange, onRemove, className?, density?: "hero" | "panel", sortable?: boolean }`; file items additionally accept `previewUrl?: string`, `mimeType?: string`, and `size?: number`.

- [ ] **Step 1: Write the failing shared-rail tests**

Extend the first fixture with a preview-backed upload and assert the new semantics and presentation:

```tsx
const baseItems: AgentComposerContextItem[] = [
  {
    id: "file:.refs/cloud.png",
    type: "file",
    title: "cloud.png",
    subtitle: ".refs/cloud.png",
    name: "cloud.png",
    path: ".refs/cloud.png",
    previewUrl: "data:image/png;base64,Y2xvdWQ=",
    mimeType: "image/png",
    size: 2048,
  },
  { id: "moodboard:m1", type: "moodboard", title: "Warm references", subtitle: "Moodboard", moodboardId: "m1", name: "Warm references" },
  { id: "text-context:fig", type: "text-context", title: "Figma import", subtitle: ".fig", body: "Buttons and cards" },
];

expect(screen.getByRole("list", { name: "Attached context" })).toHaveAttribute("data-context-layout", "rail");
expect(screen.getByRole("list", { name: "Attached context" })).toHaveAttribute("data-context-density", "panel");
expect(screen.getAllByRole("listitem")).toHaveLength(3);
expect(screen.getByRole("img", { name: "cloud.png" })).toHaveAttribute("src", "data:image/png;base64,Y2xvdWQ=");
expect(screen.getByText("Image")).toBeInTheDocument();
expect(screen.getByText("Moodboard")).toBeInTheDocument();
expect(screen.getByText("Imported context")).toBeInTheDocument();
expect(screen.getByLabelText("Remove cloud.png")).toHaveClass("focus-visible:ring-2");
```

Keep the existing helper, remove, and keyboard move assertions, updating the old `Agent context cards` query to `Attached context`. Render a second harness with `density="hero"` and `sortable={false}`; assert `data-context-density="hero"` and that no `Drag cloud.png` control is present.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
pnpm --filter @dezin/web test -- AgentComposerContext.test.tsx
```

Expected: FAIL because the file type does not accept preview metadata, the container is not a labelled list/rail, and no image/type labels render.

- [ ] **Step 3: Extend the type and presentation helpers**

Change the file branch and add pure presentation helpers:

```tsx
| {
    id: string;
    type: "file";
    title: string;
    subtitle?: string;
    name: string;
    path: string;
    previewUrl?: string;
    mimeType?: string;
    size?: number;
  }

function contextTypeLabel(item: AgentComposerContextItem, iconKind: ContextIconKind): string {
  if (iconKind === "image") return "Image";
  switch (item.type) {
    case "file": return "File";
    case "local-path": return iconKind === "folder" ? "Folder" : "File";
    case "project": return "Project";
    case "moodboard": return "Moodboard";
    case "effect": return "Effect";
    case "preview-target": return "Selected element";
    case "canvas-node": return "Canvas selection";
    case "text-context": return "Imported context";
  }
}

function contextMeta(item: AgentComposerContextItem): string | undefined {
  if (item.type === "file" && typeof item.size === "number") return formatFileSize(item.size);
  if (item.type === "canvas-node") return item.nodeType;
  return item.subtitle;
}
```

`formatFileSize` returns `2 KB`, `1.5 MB`, or a byte count without exposing a full path when a useful size is available.

- [ ] **Step 4: Replace the wrapped chip strip with the rail and object card**

The container must be a labelled list and own horizontal overflow:

```tsx
<div
  role="list"
  aria-label="Attached context"
  data-testid="agent-context-rail"
  data-context-layout="rail"
  data-context-density={density}
  className={cn("min-w-0 border-t border-border/70 pt-2.5", className)}
>
  <div className="flex min-w-0 gap-2 overflow-x-auto pb-0.5 pr-1 [scrollbar-width:thin]">
    <DragDropProvider onDragEnd={handleDragEnd}>{/* cards */}</DragDropProvider>
  </div>
</div>
```

Each item is a fixed-basis list item. Use an `<img>` only when a file has `previewUrl`; otherwise render the existing Lucide icon in the type tile. `hero` uses a richer preview-led card; `panel` uses a 36–40 px compact row. Put the title and type/meta line in a `min-w-0` text column, place the remove control at the edge, and show the grip only when `sortable && count > 1`. Preserve the hidden move-before/move-after buttons and `useSortable` ids for sortable rails. Replace the hard-coded blue drop shadow with ring-token classes.

- [ ] **Step 5: Run the shared tests and refactor while green**

Run:

```bash
pnpm --filter @dezin/web test -- AgentComposerContext.test.tsx
```

Expected: PASS with rendering, remove, and reorder coverage.

---

### Task 2: Home composer structured rich attachments

**Files:**
- Modify: `apps/web/src/screens/HomeScreen.tsx:360-593, 758-967`
- Test: `apps/web/src/screens/screens.test.tsx:327-454`

**Interfaces:**
- Consumes: Task 1 `AgentComposerContextCards` with `density="hero"` and `sortable={false}`.
- Produces: Home display items for images, projects, local paths, and imported `.fig` context; `submit` still calls the existing `setPendingImages`, `setPendingRefs`, and `onNewProject` paths.

- [ ] **Step 1: Write failing Home structure and serialization tests**

Extend the dropped-image test and add a path/context test:

```tsx
expect(await screen.findByRole("list", { name: "Attached context" })).toHaveAttribute("data-context-density", "hero");
expect(screen.getByRole("img", { name: "reference.png" })).toBeInTheDocument();
expect(screen.getByText("Image")).toBeInTheDocument();
expect(screen.getByLabelText("Describe your design")).toHaveValue("");
```

For local paths and imported context, expose a small pure `homeContextItemsForPaths(paths)` mapper and drive the real `.fig` input callback. Assert:

```tsx
expect(screen.getByText("source-app")).toBeInTheDocument();
expect(screen.getByText("Folder")).toBeInTheDocument();
expect(screen.getByText("Imported context")).toBeInTheDocument();
expect(screen.getByLabelText("Describe your design")).not.toHaveValue(expect.stringContaining("Use these local paths"));
fireEvent.click(screen.getByLabelText("Design"));
expect(onNewProject).toHaveBeenCalledWith(
  expect.stringContaining("Reference local paths:"),
  "frontend-design",
  "modern-minimal",
  "prototype",
);
```

Keep the existing reference-only default brief and pending image/project payload tests green or add them if absent.

- [ ] **Step 2: Run Home tests and verify RED**

```bash
pnpm --filter @dezin/web test -- screens.test.tsx
```

Expected: FAIL because Home has separate image thumbnails/project chips and still writes paths/`.fig` summaries into the textarea.

- [ ] **Step 3: Add caller-owned Home context state and mapping**

Keep image bytes and project bytes in their existing arrays. Add `homeContextItems` for local-path/text-context objects, then derive one shared display list:

```tsx
const homeDisplayItems: AgentComposerContextItem[] = [
  ...images.map((image, index) => ({
    id: `home-image:${image.name}:${index}`,
    type: "file" as const,
    title: image.name,
    name: image.name,
    path: image.name,
    previewUrl: image.preview,
    mimeType: "image/*",
  })),
  ...refs.map((ref) => ({
    id: `project:${ref.id}`,
    type: "project" as const,
    title: ref.name,
    subtitle: "Project",
    projectId: ref.id,
    name: ref.name,
  })),
  ...homeContextItems,
];
```

Map `AttachMenu.onPickPaths` to `local-path` items and `onContext` to a `text-context` item. Do not mutate `brief` in either callback.

- [ ] **Step 4: Serialize hidden Home context only at Design time**

Build a suffix without changing the visible textarea:

```tsx
const pathItems = homeContextItems.filter((item) => item.type === "local-path");
const textItems = homeContextItems.filter((item) => item.type === "text-context");
const contextSuffix = [
  pathItems.length ? `Reference local paths: ${pathItems.map((item) => item.path).join(", ")}` : "",
  ...textItems.map((item) => `${item.title}:\n${item.body}`),
].filter(Boolean).join("\n\n");
const base = brief.trim() || (images.length ? "Recreate the reference screenshot faithfully." : refs.length ? "Build on the referenced design." : "Use the attached context to design the artifact.");
const text = [base, contextSuffix].filter(Boolean).join("\n\n");
```

Continue calling `setPendingImages`, `setPendingRefs`, `setPendingAgent`, and `startCreate` exactly once.

- [ ] **Step 5: Replace Home's two custom attachment blocks with the shared hero rail**

Render one `AgentComposerContextCards density="hero" sortable={false}` between the textarea surface and action row. Route `onRemove` by id prefix to `images`, `refs`, or `homeContextItems`. Include `homeContextItems.length` in placeholder/default-brief and Design-button enabled logic.

- [ ] **Step 6: Run Home tests**

```bash
pnpm --filter @dezin/web test -- screens.test.tsx HomeScreen.sharingan.test.tsx home-sharingan.test.tsx
```

Expected: PASS, including Sharingan, prompt optimization, saved controls, image drop, and structured context serialization.

---

### Task 3: Project Agent composer placement and uploaded-image preview

**Files:**
- Modify: `apps/web/src/screens/WorkspaceScreen.tsx:2043-2046, 4036-4062, 4492-4702`
- Test: `apps/web/src/screens/workspace.test.tsx:561-608`

**Interfaces:**
- Consumes: Task 1 file presentation fields and `AgentComposerContextCards`.
- Produces: uploaded Project Agent file items with `{ previewUrl, mimeType, size }`, using the existing served-reference URL for images; context rail after the action row; textarea focus restored after removing an item.

- [ ] **Step 1: Write the failing upload-preview and order test**

Add a test with a deterministic upload result:

```tsx
test("project composer shows an uploaded image in the attachment rail below its actions", async () => {
  const fake = makeFakeApi({
    uploadRef: async () => ({ name: "cloud.png", path: ".refs/cloud.png" }),
  });
  render(
    <ApiProvider client={fake}>
      <WorkspaceScreen projectId="p1" />
    </ApiProvider>,
  );

  const message = await screen.findByLabelText("Message");
  const upload = screen.getByLabelText("Attach files");
  fireEvent.change(upload, {
    target: { files: [new File(["cloud"], "cloud.png", { type: "image/png" })] },
  });

  const rail = await screen.findByRole("list", { name: "Attached context" });
  expect(within(rail).getByRole("img", { name: "cloud.png" })).toHaveAttribute("src", expect.stringMatching(/^data:image\/png;base64,/));
  const actions = screen.getByTestId("project-composer-actions");
  expect(actions.compareDocumentPosition(rail) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

  fireEvent.click(within(rail).getByLabelText("Remove cloud.png"));
  await waitFor(() => expect(message).toHaveFocus());
});
```

Update the existing project context serialization test to query `Attached context` and keep its internal-drag overlay assertion.

- [ ] **Step 2: Run the workspace test and verify RED**

Run:

```bash
pnpm --filter @dezin/web test -- workspace.test.tsx
```

Expected: FAIL because the uploaded item has no preview metadata, the rail is above the textarea/action row, and the action row has no stable test id.

- [ ] **Step 3: Preserve upload presentation metadata**

In `attachFiles`, use the existing served-reference URL after upload rather than retaining a potentially large data URL in React state:

```tsx
{
  id: `file:${ref.path}`,
  type: "file",
  title: ref.name,
  subtitle: ref.path,
  name: ref.name,
  path: ref.path,
  previewUrl: file.type.startsWith("image/") ? api.refUrl(projectId, ref.path) : undefined,
  mimeType: file.type || undefined,
  size: file.size,
}
```

Do not add these fields to the prompt serialization in `send`.

- [ ] **Step 4: Move the rail beneath the action row and restore focus on removal**

Add a textarea ref, attach it to the existing `Message` textarea, and replace the old rail location with:

```tsx
<div data-testid="project-composer-actions" className="mt-1.5 flex items-center justify-between gap-2">
  {/* existing AttachMenu, model, variant, stop, queue, and send actions */}
</div>
<AgentComposerContextCards
  className="mt-2.5"
  items={contextItems}
  onChange={setContextItems}
  onRemove={(id) => {
    setContextItems((items) => removeContextItem(items, id));
    window.requestAnimationFrame(() => messageInputRef.current?.focus({ preventScroll: true }));
  }}
/>
```

Increase the resting message textarea minimum height modestly, but keep `max-h-40`, field sizing, IME logic, and send behavior unchanged.

- [ ] **Step 5: Make the real-file overlay request-specific**

Change the overlay copy to `Add files to this request` and use an inset dashed focus-color border. Do not change `hasDraggedFiles` guards.

- [ ] **Step 6: Run workspace tests**

Run:

```bash
pnpm --filter @dezin/web test -- workspace.test.tsx
```

Expected: PASS, including IME, queue, selected-target serialization, and the new preview/order test.

---

### Task 4: Moodboard Agent composer placement and focus behavior

**Files:**
- Modify: `apps/web/src/moodboard/MoodboardAgentPanel.tsx:305-465`
- Test: `apps/web/src/moodboard/moodboard-ui.test.tsx:1895-1964`

**Interfaces:**
- Consumes: Task 1 `AgentComposerContextCards` rail.
- Produces: Moodboard context rail after the action row; unchanged canvas-node/local-path/project/moodboard serialization; textarea focus restored after removal.

- [ ] **Step 1: Write the failing Moodboard rail-order and focus assertions**

In the existing canvas insertion test:

```tsx
const rail = screen.getByRole("list", { name: "Attached context" });
expect(within(rail).getByText("Canvas selection")).toBeInTheDocument();
const actions = screen.getByTestId("moodboard-composer-actions");
expect(actions.compareDocumentPosition(rail) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

fireEvent.click(within(rail).getByLabelText("Remove Material tone"));
await waitFor(() => expect(message).toHaveFocus());
```

Then rerender/insert the item again before the existing context-only send assertion so removal and serialization remain independently covered.

- [ ] **Step 2: Run the focused Moodboard test and verify RED**

Run:

```bash
pnpm --filter @dezin/web test -- moodboard-ui.test.tsx
```

Expected: FAIL because the old chip list is above the textarea and the action row has no stable id.

- [ ] **Step 3: Move the shared rail and preserve existing behavior**

Keep the message textarea first and mark the action row:

```tsx
<div data-testid="moodboard-composer-actions" className="mt-1.5 flex items-center justify-between gap-2">
  {/* existing AttachMenu, AgentModelSelect, and Send */}
</div>
<AgentComposerContextCards
  className="mt-2.5"
  items={contextItems}
  onChange={setContextItems}
  onRemove={(id) => {
    setContextItems((items) => removeContextItem(items, id));
    window.requestAnimationFrame(focusComposerEnd);
  }}
/>
```

Use the same inset dashed treatment as Project Agent, but say `Add images to this moodboard`. Keep Moodboard uploads creating canvas nodes; do not invent a new agent attachment protocol.

- [ ] **Step 4: Run Moodboard tests**

Run:

```bash
pnpm --filter @dezin/web test -- moodboard-ui.test.tsx
```

Expected: PASS, including IME, canvas insertion, drop guards, conversation controls, and context-only send.

---

### Task 5: Accurate add-menu and Moodboard upload semantics

**Files:**
- Modify: `apps/web/src/components/AttachMenu.tsx:25-117`
- Modify: `apps/web/src/moodboard/MoodboardAgentPanel.tsx:170-173, 331-350, 385-433`
- Test: `apps/web/src/components/AttachMenu.test.tsx`
- Test: `apps/web/src/moodboard/moodboard-ui.test.tsx`

**Interfaces:**
- Consumes: existing `AttachMenu` callbacks and native bridge.
- Produces: optional `fileActionLabel?: string`; browser fallback only for file uploads; Moodboard composer copy that accurately describes adding images to the board.

- [ ] **Step 1: Write failing browser-fallback tests**

Create `AttachMenu.test.tsx` with the normal API provider. In the browser test environment, click each action and assert:

```tsx
const onAttachFile = vi.fn();
render(
  <ApiProvider client={makeFakeApi()}>
    <AttachMenu onAttachFile={onAttachFile} onPickPaths={vi.fn()} />
  </ApiProvider>,
);

fireEvent.click(screen.getByLabelText("Add files and context"));
fireEvent.click(await screen.findByRole("menuitem", { name: "Attach file" }));
expect(onAttachFile).toHaveBeenCalledOnce();

fireEvent.click(screen.getByLabelText("Add files and context"));
fireEvent.click(await screen.findByRole("menuitem", { name: "Attach folder" }));
expect(onAttachFile).toHaveBeenCalledOnce();
```

Add a second render with `fileActionLabel="Add images to board"` and assert that exact menu item appears.

- [ ] **Step 2: Run the add-menu test and verify RED**

```bash
pnpm --filter @dezin/web test -- AttachMenu.test.tsx
```

Expected: FAIL because folder picking in a browser incorrectly invokes `onAttachFile` and the label is not configurable.

- [ ] **Step 3: Correct fallback and copy without changing native behavior**

Add the optional prop with a default and split the non-native branch:

```tsx
export function AttachMenu({ fileActionLabel = "Attach file", ...props }: {
  fileActionLabel?: string;
  // existing callbacks
}) {
  const pick = async (kind: "files" | "folder", label: string): Promise<void> => {
    if (!native) {
      if (kind === "files" && onAttachFile) onAttachFile();
      else toast(`${label} is available in the desktop app.`);
      return;
    }
    const paths = kind === "files" ? await native.pickFiles() : await native.pickFolder();
    if (paths.length) onPickPaths?.(paths);
  };
}
```

Use `fileActionLabel` for the first menu row and its fallback label. Keep project/moodboard/effect and `.fig` behavior unchanged.

- [ ] **Step 4: Make Moodboard upload target explicit**

Pass `fileActionLabel="Add images to board"` from `MoodboardAgentPanel`. Change its drop overlay to `Add images to this moodboard`. Keep `attachFiles` calling `onUploadFiles` and do not add an Agent context item. Add an assertion that dropping an image calls `onUploadFiles` while `Attached context` remains absent.

- [ ] **Step 5: Run add-menu and Moodboard tests**

```bash
pnpm --filter @dezin/web test -- AttachMenu.test.tsx moodboard-ui.test.tsx
```

Expected: PASS with accurate browser/native and board/Agent semantics.

---

### Task 6: Cross-surface verification and polish

**Files:**
- Review: `apps/web/src/components/AgentComposerContext.tsx`
- Review: `apps/web/src/screens/HomeScreen.tsx`
- Review: `apps/web/src/screens/WorkspaceScreen.tsx`
- Review: `apps/web/src/moodboard/MoodboardAgentPanel.tsx`
- Review: `apps/web/src/components/AttachMenu.tsx`

**Interfaces:**
- Consumes: completed Tasks 1–5.
- Produces: verified rendered behavior, no new public interface.

- [ ] **Step 1: Run the focused composer suite**

```bash
pnpm --filter @dezin/web test -- AgentComposerContext.test.tsx AttachMenu.test.tsx screens.test.tsx workspace.test.tsx moodboard-ui.test.tsx
```

Expected: all focused files pass with zero failures.

- [ ] **Step 2: Run React and design-quality review**

Review every edited TSX file for stable props, unnecessary rerenders, overflow ownership, semantic list markup, pointer/touch target size, focus visibility, and reduced-motion classes. Run the repository's design detector when its current target scan includes the edited files; treat hits as defect evidence, not proof of quality.

- [ ] **Step 3: Exercise the real UI**

Start the normal local Dezin web/desktop surface. On Home, drop an image, add a project/local path/`.fig` context, remove items, and Design at wide and narrow widths. In Project Agent, upload an image, add a local path or project reference, reorder, remove, and send context-only at normal and minimum conversation widths. In Moodboard Agent, send one and multiple selected canvas nodes, add a project/moodboard reference, reorder, remove, and send at 280 px and 520 px panel widths. Confirm native upload overlays never appear during internal sorting and Moodboard upload copy says the image is added to the board.

- [ ] **Step 4: Run complete verification**

```bash
pnpm --filter @dezin/web test
pnpm typecheck
pnpm build:check
git diff --check
```

Expected: all commands exit 0. `build:check` may print Vite's informational large-lazy-chunk warning, but the repository bundle budget must report `BUNDLE: PASS`.

- [ ] **Step 5: Independent diff review**

Review the final diff against `docs/superpowers/specs/2026-07-12-agent-composer-attachment-tray-design.md`. Reject changes outside Home, the two Agent composers, shared context renderer, add menu, focused tests, and documentation. Confirm no `.dezin` generated project, uploaded reference, build artifact, or credential is staged.
