# Composer Context Top Rail Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore Sharingan to a hidden heading double-click gesture and render one compact, top-positioned context rail in the Home, Project Agent, and Moodboard Agent composers.

**Architecture:** Keep all context data and send-time serialization unchanged. Consolidate the existing `hero` and `panel` branches in `AgentComposerContextCards` into one compact presentation, then let each composer call site place that shared rail before its textarea. Remove only the visible Sharingan toolbar control while retaining the existing `toggleSharingan` state machine and heading double-click handler.

**Tech Stack:** React 19, TypeScript, Tailwind CSS, Vitest, Testing Library, `@dnd-kit/react`, Lucide React, Vite.

## Global Constraints

- Sharingan has no visible button, menu item, badge, or replacement shortcut.
- Double-clicking the Home heading remains the only Sharingan entry and exit gesture.
- Preserve the Electron-only gate, Standard-mode forcing, authorization affirmation, URL validation, title/eye treatment, and URL placeholder.
- Use one 36px-high context card style in Home, Project Agent, and Moodboard Agent.
- Cards have a content-sized width with a 112px minimum and 184px maximum.
- Context rails appear before the textarea, never wrap, and scroll horizontally.
- Keep context item types, deduplication, removal, sorting, pending references, serialization, and context-only sending unchanged.
- Project and Moodboard remain sortable; Home remains non-sortable.
- Use existing Lucide icons and existing design tokens; add no dependencies and no custom SVG.
- Preserve focus restoration, caret placement, IME handling, drag/drop isolation, and reduced-motion behavior.
- The supplied Option 1 image is the visual reference for top placement and density, not a request to copy its branding.

## File Structure

- `apps/web/src/components/AgentComposerContext.tsx`: the single compact card and top-rail presentation.
- `apps/web/src/components/AgentComposerContext.test.tsx`: component dimensions, metadata visibility, sorting, removal, and accessibility contracts.
- `apps/web/src/screens/HomeScreen.tsx`: hidden Sharingan trigger and Home rail placement.
- `apps/web/src/screens/HomeScreen.sharingan.test.tsx`: desktop double-click behavior and absence of a visible Sharingan entry.
- `apps/web/src/screens/screens.test.tsx`: Home composer ordering and context-only request coverage.
- `apps/web/src/screens/WorkspaceScreen.tsx`: Project Agent rail placement.
- `apps/web/src/screens/workspace.test.tsx`: Project Agent ordering, sorting, removal, focus, and serialization coverage.
- `apps/web/src/moodboard/MoodboardAgentPanel.tsx`: Moodboard Agent rail placement.
- `apps/web/src/moodboard/moodboard-ui.test.tsx`: Moodboard ordering, sorting, removal, focus, and serialization coverage.
- `design-qa.md`: blocking rendered comparison against the supplied Option 1 reference.

---

### Task 1: Restore the hidden Sharingan gesture

**Files:**
- Modify: `apps/web/src/screens/HomeScreen.tsx:963-987`
- Modify: `apps/web/src/screens/HomeScreen.sharingan.test.tsx:32-42`
- Modify: `apps/web/src/screens/screens.test.tsx:267-270`

**Interfaces:**
- Consumes: existing `toggleSharingan(): void`, `sharingan: boolean`, and the Home heading `onDoubleClick` handler.
- Produces: no new API; the toolbar starts with `AttachMenu`, while the heading remains the only Sharingan trigger.

- [ ] **Step 1: Write the failing hidden-entry tests**

Replace the visible-entry assertion in `screens.test.tsx` with:

```tsx
test("HomeScreen keeps Sharingan hidden behind the heading gesture", () => {
  renderWithApi(<HomeScreen projects={[]} />, { listSkills: async () => SKILLS });

  expect(screen.queryByRole("button", { name: "Sharingan clone from URL" })).toBeNull();
  expect(screen.getByRole("heading", { name: "Start a design" })).toHaveAttribute(
    "title",
    "Double-click for Sharingan — clone from a URL",
  );
});
```

Add this assertion before the existing double-click in `HomeScreen.sharingan.test.tsx`:

```tsx
expect(screen.queryByRole("button", { name: "Sharingan clone from URL" })).toBeNull();
fireEvent.doubleClick(screen.getByText("Start a design"));
```

- [ ] **Step 2: Run the tests to verify RED**

Run:

```bash
pnpm --filter @dezin/web test -- src/screens/HomeScreen.sharingan.test.tsx src/screens/screens.test.tsx
```

Expected: FAIL because the toolbar still contains the button named `Sharingan clone from URL`.

- [ ] **Step 3: Remove only the visible toolbar entry**

Delete the Sharingan `<button>` from the left side of the Home composer action row so the block begins with the existing attach menu:

```tsx
<div className="flex flex-wrap items-center gap-2">
  <AttachMenu
    onAttachFile={() => imgInputRef.current?.click()}
    onPickPaths={addHomePaths}
    onContext={addHomeTextContext}
    onReference={(project) => void referenceProject(project)}
  />
```

Do not change `toggleSharingan`, the heading `onDoubleClick`, or Sharingan state rendering.

- [ ] **Step 4: Run the focused tests to verify GREEN**

Run:

```bash
pnpm --filter @dezin/web test -- src/screens/HomeScreen.sharingan.test.tsx src/screens/home-sharingan.test.tsx src/screens/HomeScreen.sharingan-gate.test.tsx src/screens/screens.test.tsx
```

Expected: PASS, including double-click enter, double-click exit, browser denial, authorization gate, and no visible button.

- [ ] **Step 5: Commit the hidden-trigger change**

```bash
git add apps/web/src/screens/HomeScreen.tsx apps/web/src/screens/HomeScreen.sharingan.test.tsx apps/web/src/screens/screens.test.tsx
git commit -m "fix(web): restore hidden Sharingan trigger"
```

---

### Task 2: Consolidate context cards into one compact top rail

**Files:**
- Modify: `apps/web/src/components/AgentComposerContext.tsx:146-322`
- Modify: `apps/web/src/components/AgentComposerContext.test.tsx:38-130`

**Interfaces:**
- Consumes: `AgentComposerContextItem`, `useSortable`, `onChange(items)`, `onRemove(id)`, and `sortable?: boolean`.
- Produces: `AgentComposerContextCards<T>({ items, onChange, onRemove, className?, sortable? })` with `data-context-layout="top-rail"`; the `density` prop and density data attribute are removed.

- [ ] **Step 1: Rewrite component tests for the compact contract**

Update the default rail assertions to:

```tsx
const list = screen.getByRole("list", { name: "Attached context" });
expect(list).toHaveAttribute("data-context-layout", "top-rail");
expect(list).not.toHaveAttribute("data-context-density");

const cloudCard = screen.getByTestId("agent-context-card-file:.refs/cloud.png");
expect(cloudCard).toHaveClass("h-9", "min-w-28", "max-w-[184px]", "w-fit");
expect(screen.getByRole("img", { name: "cloud.png" }).parentElement).toHaveClass("size-6");
expect(screen.getByRole("button", { name: "Remove cloud.png" })).toHaveClass("size-5");
expect(within(list).queryByText("Image")).toBeNull();
expect(cloudCard.getAttribute("title")).toContain("cloud.png: Image · .refs/cloud.png · 2 KB");
```

Replace the hero-density test with a non-sortable compact test:

```tsx
test("AgentComposerContextCards keeps compact cards non-sortable when requested", async () => {
  render(
    <AgentComposerContextCards
      items={baseItems}
      onChange={vi.fn()}
      onRemove={vi.fn()}
      sortable={false}
    />,
  );

  expect(screen.getByRole("list", { name: "Attached context" })).toHaveAttribute("data-context-layout", "top-rail");
  expect(screen.queryByLabelText("Drag cloud.png")).toBeNull();
  expect(screen.getByTestId("agent-context-card-file:.refs/cloud.png")).toHaveClass("h-9", "w-fit");
});
```

Replace the single-panel-card dimension assertions with the compact dimensions:

```tsx
test("AgentComposerContextCards keeps a single compact card and its remove control enabled", async () => {
  render(
    <AgentComposerContextCards
      items={[baseItems[0]!]}
      onChange={vi.fn()}
      onRemove={vi.fn()}
    />,
  );

  const compactCard = screen.getByRole("listitem");
  const removeButton = screen.getByRole("button", { name: "Remove cloud.png" });
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  await waitFor(() => expect(compactCard).not.toHaveAttribute("aria-disabled", "true"));
  expect(removeButton.closest('[aria-disabled="true"]')).toBeNull();
  expect(compactCard).toHaveClass("h-9", "w-fit", "min-w-28", "max-w-[184px]");
  expect(removeButton).toHaveClass("size-5");
  expect(screen.queryByLabelText("Drag cloud.png")).toBeNull();
});
```

Remove the old visible `Image`, `Moodboard`, and `Imported context` expectations from the multi-card test because metadata is now tooltip-only. Keep the existing helper, removal, drag-handle, screen-reader move, and draggable-boundary assertions.

- [ ] **Step 2: Run the component test to verify RED**

Run:

```bash
pnpm --filter @dezin/web test -- src/components/AgentComposerContext.test.tsx
```

Expected: FAIL because the component still reports `rail`/`hero`/`panel`, renders two text rows, and uses 40px or 112px cards.

- [ ] **Step 3: Implement the single compact rail**

Remove `density` from the component signature and render the rail with:

```tsx
<div
  role="list"
  aria-label="Attached context"
  data-testid="agent-context-rail"
  data-context-layout="top-rail"
  className={cn("min-w-0 border-b border-border/70 pb-2", className)}
>
  <div className="flex min-w-0 gap-1.5 overflow-x-auto pb-0.5 pr-1 [scrollbar-width:thin]">
    <DragDropProvider onDragEnd={handleDragEnd}>
      {items.map((item, index) => (
        <AgentComposerContextCard
          key={item.id}
          item={item}
          index={index}
          count={items.length}
          sortable={sortable}
          onMoveBefore={() => moveBefore(item.id)}
          onMoveAfter={() => moveAfter(item.id)}
          onRemove={() => onRemove(item.id)}
        />
      ))}
    </DragDropProvider>
  </div>
</div>
```

Keep `contextTypeLabel` and `contextMeta`, and build a deduplicated tooltip string before rendering the card. A stored file contributes its path separately because its existing `contextMeta` value is the file size:

```tsx
const tooltipMeta = Array.from(
  new Set(
    [typeLabel, item.type === "file" ? item.path : undefined, meta].filter(
      (value): value is string => Boolean(value),
    ),
  ),
).join(" · ");
```

Render each card as one row:

```tsx
<div
  ref={showGrip ? ref : undefined}
  role="listitem"
  data-testid={`agent-context-card-${item.id}`}
  data-context-icon={iconKind}
  title={tooltipMeta ? `${item.title}: ${tooltipMeta}` : item.title}
  className={cn(
    "group flex h-9 w-fit min-w-28 max-w-[184px] shrink-0 select-none items-center gap-1.5 overflow-hidden rounded-lg border border-border bg-card px-1.5 text-xs text-foreground-2 transition-[opacity,border-color,background-color] duration-150 ease-out motion-reduce:transition-none",
    isDragging && "opacity-55 ring-2 ring-ring/30",
    isDropTarget && "border-ring ring-2 ring-ring/30",
  )}
>
  <span className="grid size-6 shrink-0 place-items-center overflow-hidden rounded-md border border-border/70 bg-surface-2 text-brand">
    {item.type === "file" && item.previewUrl ? (
      <img className="size-full object-cover" src={item.previewUrl} alt={item.title} />
    ) : (
      contextIcon(iconKind, 12)
    )}
  </span>
  <span className="min-w-0 flex-1 truncate font-medium text-foreground">{item.title}</span>
  {showGrip ? (
    <button
      ref={handleRef}
      type="button"
      aria-label={`Drag ${item.title}`}
      className="grid h-6 w-3 shrink-0 touch-none cursor-grab place-items-center rounded text-muted-foreground/60 opacity-0 transition-[opacity,color,background-color] group-hover:opacity-100 focus:opacity-100 active:cursor-grabbing"
    >
      <GripVertical size={11} strokeWidth={1.75} />
    </button>
  ) : null}
  {showGrip ? (
    <>
      <button type="button" disabled={index === 0} className="sr-only" onClick={onMoveBefore}>
        Move {item.title} before previous context card
      </button>
      <button type="button" disabled={index >= count - 1} className="sr-only" onClick={onMoveAfter}>
        Move {item.title} after next context card
      </button>
    </>
  ) : null}
  <button
    type="button"
    aria-label={`Remove ${item.title}`}
    onPointerDown={(event) => event.stopPropagation()}
    onClick={(event) => {
      event.stopPropagation();
      onRemove();
    }}
    className="grid size-5 shrink-0 place-items-center rounded text-muted-foreground/70 transition-colors hover:bg-surface-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
  >
    <X size={10} strokeWidth={2} />
  </button>
</div>
```

Keep `contextTypeLabel` and `contextMeta` for the tooltip/title even though neither renders as a second visible row. The file-path addition is required so a file tooltip retains type, stored path, and size.

- [ ] **Step 4: Run the component test to verify GREEN**

Run:

```bash
pnpm --filter @dezin/web test -- src/components/AgentComposerContext.test.tsx
```

Expected: PASS with compact dimensions, hidden metadata, thumbnails/icons, removal, drag sorting, and non-sortable mode.

- [ ] **Step 5: Commit the shared component**

```bash
git add apps/web/src/components/AgentComposerContext.tsx apps/web/src/components/AgentComposerContext.test.tsx
git commit -m "feat(web): compact composer context cards"
```

---

### Task 3: Move Home context above the instruction field

**Files:**
- Modify: `apps/web/src/screens/HomeScreen.tsx:861-963`
- Modify: `apps/web/src/screens/screens.test.tsx:135-160,450-525`

**Interfaces:**
- Consumes: compact `AgentComposerContextCards` from Task 2 and existing `homeDisplayItems`/`removeHomeDisplayItem` state.
- Produces: Home DOM order `context rail → textarea → action row`; Home calls the shared component with `sortable={false}`.

- [ ] **Step 1: Add failing Home ordering assertions**

In the project-reference-only test, replace the density assertion with:

```tsx
const rail = await screen.findByRole("list", { name: "Attached context" });
const textarea = screen.getByRole("textbox", { name: "Describe your design" });
const attach = screen.getByRole("button", { name: "Add files and context" });

expect(rail).toHaveAttribute("data-context-layout", "top-rail");
expect(rail.compareDocumentPosition(textarea) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
expect(rail.compareDocumentPosition(attach) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
expect(screen.getByTestId("agent-context-card-project:p-source")).toHaveClass("h-9");
```

In `HomeScreen prompt presents dropped image references as rich context without mutating the brief`, replace the density/type-row assertions with:

```tsx
expect(rail).toHaveAttribute("data-context-layout", "top-rail");
expect(rail.compareDocumentPosition(screen.getByLabelText("Describe your design")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
expect(within(rail).getByRole("img", { name: "reference.png" })).toBeInTheDocument();
expect(within(rail).queryByText("Image")).toBeNull();
```

In `HomeScreen keeps local paths and imported fig context structured until Design`, replace the density/type-row assertions with:

```tsx
expect(rail).toHaveAttribute("data-context-layout", "top-rail");
expect(rail.compareDocumentPosition(screen.getByLabelText("Describe your design")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
expect(within(rail).getByText("source-app")).toBeInTheDocument();
expect(within(rail).queryByText("Folder")).toBeNull();
```

- [ ] **Step 2: Run Home tests to verify RED**

Run:

```bash
pnpm --filter @dezin/web test -- src/screens/screens.test.tsx
```

Expected: FAIL because the Home rail still follows the textarea and still passes `density="hero"`.

- [ ] **Step 3: Move the Home rail**

Render the rail immediately inside the composer's inner rounded container, before the relative textarea wrapper:

```tsx
<AgentComposerContextCards
  items={homeDisplayItems}
  onChange={() => {}}
  onRemove={removeHomeDisplayItem}
  sortable={false}
  className="mx-1 mb-2"
/>
```

Place this block immediately before the existing `div` whose class begins `relative overflow-hidden rounded-xl`. Keep that wrapper and its loading surface, textarea, and optimize controls unchanged, then delete the old post-textarea rail.

Delete the old post-textarea rail. Do not change pending image/reference serialization or removal focus behavior.

- [ ] **Step 4: Run Home tests to verify GREEN**

Run:

```bash
pnpm --filter @dezin/web test -- src/screens/screens.test.tsx src/screens/HomeScreen.sharingan.test.tsx
```

Expected: PASS with context-only Design enabled, top ordering, compact cards, removal, and hidden Sharingan behavior.

- [ ] **Step 5: Commit Home placement**

```bash
git add apps/web/src/screens/HomeScreen.tsx apps/web/src/screens/screens.test.tsx
git commit -m "feat(web): move Home context above instructions"
```

---

### Task 4: Move Project and Moodboard context above their instruction fields

**Files:**
- Modify: `apps/web/src/screens/WorkspaceScreen.tsx:4518-4710`
- Modify: `apps/web/src/screens/workspace.test.tsx:570-690`
- Modify: `apps/web/src/moodboard/MoodboardAgentPanel.tsx:339-467`
- Modify: `apps/web/src/moodboard/moodboard-ui.test.tsx:1910-2012`

**Interfaces:**
- Consumes: compact `AgentComposerContextCards` from Task 2; existing Project/Moodboard state, sorting, removal, focus, and serialization callbacks.
- Produces: Project order `queue → rail → textarea → actions`; Moodboard order `rail → textarea → actions`.

- [ ] **Step 1: Write failing Project ordering assertions**

In each populated Project composer test, assert:

```tsx
const rail = screen.getByRole("list", { name: "Attached context" });
const message = screen.getByRole("textbox", { name: "Message" });
const actions = screen.getByTestId("project-composer-actions");

expect(rail).toHaveAttribute("data-context-layout", "top-rail");
expect(rail.compareDocumentPosition(message) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
expect(rail.compareDocumentPosition(actions) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
```

In `project composer presents uploaded image metadata and serializes only its stored reference`, replace the old visible metadata assertions with tooltip-only coverage:

```tsx
const cloudCard = within(rail).getByTestId("agent-context-card-file:.refs/cloud.png");
expect(within(rail).queryByText("Image")).toBeNull();
expect(within(rail).queryByText("· 5 bytes")).toBeNull();
expect(cloudCard).toHaveAttribute("title", "cloud.png: Image · .refs/cloud.png · 5 bytes");
```

Add a Project call-site sorting test that uploads two files, waits for both cards, activates the screen-reader `Move second.png before previous context card` control, and asserts the `listitem` DOM order changes from `first.png, second.png` to `second.png, first.png`. Stub `uploadRef` from the requested filename so the two items have distinct `.refs/first.png` and `.refs/second.png` ids. This directly proves the Project `onChange={setContextItems}` integration; keep the existing drag-overlay isolation, remove/focus, and context-only send assertions.

- [ ] **Step 2: Write failing Moodboard ordering assertions**

Replace the current action-before-rail expectation with:

```tsx
const rail = screen.getByRole("list", { name: "Attached context" });
const message = screen.getByLabelText("Message");
const actions = screen.getByTestId("moodboard-composer-actions");

expect(rail).toHaveAttribute("data-context-layout", "top-rail");
expect(rail.compareDocumentPosition(message) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
expect(rail.compareDocumentPosition(actions) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
```

Replace the old visible type/meta assertions in the canvas-insertion test with:

```tsx
const materialCard = within(rail).getByTestId("agent-context-card-canvas-node:note-1");
expect(within(rail).queryByText("Canvas selection")).toBeNull();
expect(within(rail).queryByText("· note")).toBeNull();
expect(materialCard).toHaveAttribute("title", "Material tone: Canvas selection · note");
```

Add a second canvas item (`canvas-node:image-2`, title `Texture crop`, node type `image`) to the first `composerInsertion`. Activate `Move Texture crop before previous context card`, assert the listitem DOM order changes to `Texture crop, Material tone`, then remove `Texture crop` before continuing the existing draft/caret removal and single-node serialization assertions. This directly proves Moodboard `onChange={setContextItems}` while preserving the current focus/caret test shape.

- [ ] **Step 3: Run both test files to verify RED**

Run:

```bash
pnpm --filter @dezin/web test -- src/screens/workspace.test.tsx src/moodboard/moodboard-ui.test.tsx
```

Expected: FAIL because both rails still follow their action rows.

- [ ] **Step 4: Move the Project rail**

Move the existing `AgentComposerContextCards` block from after `project-composer-actions` to after queued prompts and the hidden file input, immediately before the Project textarea:

```tsx
<AgentComposerContextCards
  className="mb-2"
  items={contextItems}
  onChange={setContextItems}
  onRemove={(id) => {
    setContextItems((items) => removeContextItem(items, id));
    window.requestAnimationFrame(() => messageInputRef.current?.focus({ preventScroll: true }));
  }}
/>
```

The existing `<textarea ref={messageInputRef} aria-label="Message">` must immediately follow this block without changing its props.

- [ ] **Step 5: Move the Moodboard rail**

Move the existing block from after `moodboard-composer-actions` to immediately before the Moodboard textarea:

```tsx
<AgentComposerContextCards
  className="mb-2"
  items={contextItems}
  onChange={setContextItems}
  onRemove={(id) => {
    setContextItems((items) => removeContextItem(items, id));
    window.requestAnimationFrame(focusComposerEnd);
  }}
/>
```

The existing `<textarea ref={textareaRef} aria-label="Message">` must immediately follow this block without changing its props.

- [ ] **Step 6: Run Project and Moodboard tests to verify GREEN**

Run:

```bash
pnpm --filter @dezin/web test -- src/components/AgentComposerContext.test.tsx src/screens/workspace.test.tsx src/moodboard/moodboard-ui.test.tsx
```

Expected: PASS with rail ordering, sorting, context-only send, removal focus/caret, drag/drop isolation, and serialization unchanged.

- [ ] **Step 7: Commit Project and Moodboard placement**

```bash
git add apps/web/src/screens/WorkspaceScreen.tsx apps/web/src/screens/workspace.test.tsx apps/web/src/moodboard/MoodboardAgentPanel.tsx apps/web/src/moodboard/moodboard-ui.test.tsx
git commit -m "feat(web): place agent context above prompts"
```

---

### Task 5: Rendered design QA and full verification

**Files:**
- Create: `design-qa.md`
- Verify: all files changed in Tasks 1–4

**Interfaces:**
- Consumes: the completed hidden trigger and compact top rail on all three surfaces.
- Produces: `design-qa.md` with `final result: passed`, plus fresh automated and rendered evidence.

- [ ] **Step 1: Run the complete web suite**

Run:

```bash
pnpm --filter @dezin/web test
```

Expected: all Vitest files pass with zero failed tests.

- [ ] **Step 2: Run repository type and build gates**

Run:

```bash
pnpm typecheck
pnpm build:check
git diff --check
```

Expected: `TYPECHECK: PASS`, `BUNDLE: PASS`, and no diff-check output.

- [ ] **Step 3: Start the real application**

Run from the repository root:

```bash
pnpm dev
```

Use the actual URL printed by the development script. Open it with the in-app Browser when available; use the repository's Playwright workflow only if Browser is unavailable.

- [ ] **Step 4: Verify Home against the reference**

At desktop width:

1. Add an image and a project reference.
2. Confirm both appear in one 36px top rail before the textarea.
3. Confirm cards show a 24px preview/icon, one title line, subtle close control, and no visible type/meta row.
4. Confirm horizontal overflow does not wrap the rail.
5. Confirm the toolbar has no Sharingan button.
6. Double-click `Start a design`, confirm Sharingan mode appears, then double-click `Sharingan` to exit.

- [ ] **Step 5: Verify Project and Moodboard interactions**

For each composer:

1. Add at least two different context types.
2. Confirm the rail precedes the textarea and action row.
3. Drag-reorder the two cards and confirm order changes without showing the file-drop overlay.
4. Remove one card and confirm the textarea regains focus with its draft/caret preserved.
5. Send a context-only request and confirm the rail clears after serialization.

- [ ] **Step 6: Verify narrow layout and console health**

At a 390px-wide viewport, confirm:

- cards remain one row and scroll horizontally;
- no card, remove control, textarea, model picker, or send control is clipped;
- the floating Project/Moodboard composers do not overlap the newest message;
- the browser console contains no new errors or React warnings.

- [ ] **Step 7: Write the blocking QA record**

Create `design-qa.md` with this completed structure:

```markdown
# Composer Context Top Rail Design QA

Reference: supplied Option 1 composer image

## Home
- top rail placement: passed
- compact card hierarchy: passed
- hidden Sharingan double-click flow: passed

## Project Agent
- top rail placement and sorting: passed
- removal focus and context-only send: passed

## Moodboard Agent
- top rail placement and sorting: passed
- removal focus and context-only send: passed

## Responsive and console
- 390px horizontal rail behavior: passed
- clipping/overlap: none
- new console errors: none

final result: passed
```

If any item is not verified, write `final result: blocked` or `final result: failed`, fix the issue, and repeat the rendered check before changing it to `passed`.

- [ ] **Step 8: Run the final repository CI command**

Run:

```bash
pnpm run ci
```

Expected: typecheck, all workspace coverage suites, process-leak guard, bundle budget, and production audit exit 0.

- [ ] **Step 9: Review and commit the QA record**

```bash
git diff --check
git status --short
git add design-qa.md
git commit -m "test(web): verify compact composer context rail"
```

Do not push unless the user explicitly requests it.
