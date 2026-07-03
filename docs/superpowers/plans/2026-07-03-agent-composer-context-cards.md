# Agent Composer Context Cards Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace raw pre-send Agent context text with shared typed composer cards in the Project Agent and Moodboard Agent.

**Architecture:** Add a focused frontend model/component for composer context cards, with helper functions for dedupe, removal, and HTML5 drag reorder. Project Agent and Moodboard Agent own their local card state and serialize cards into Dezin's existing prompt text and `moodboardRefs` fields at send time, leaving daemon contracts unchanged.

**Tech Stack:** React 19, TypeScript, Vitest, Testing Library, lucide-react, existing Dezin web UI utilities.

## Global Constraints

- Work on branch `feature/agent-composer-context-cards`.
- Keep backend protocol unchanged; do not add structured message storage.
- Use shared frontend model/component for both `WorkspaceScreen` and `MoodboardAgentPanel`.
- Use existing Dezin compact composer styling and lucide icons.
- Support remove and drag reorder for context cards.
- Sending with only context cards is valid when serialization produces non-empty content.
- Keep Moodboard file upload as board-node creation; do not create upload cards unless a stable agent reference exists.
- Write failing tests before production code.

---

### Task 1: Shared Composer Context Model And Cards

**Files:**
- Create: `apps/web/src/components/AgentComposerContext.tsx`
- Create: `apps/web/src/components/AgentComposerContext.test.tsx`

**Interfaces:**
- Produces: `AgentComposerContextItem<PreviewTarget = unknown>`
- Produces: `upsertContextItems<T extends AgentComposerContextItem>(items: T[], incoming: T[]): T[]`
- Produces: `removeContextItem<T extends AgentComposerContextItem>(items: T[], id: string): T[]`
- Produces: `moveContextItem<T extends AgentComposerContextItem>(items: T[], activeId: string, overId: string): T[]`
- Produces: `AgentComposerContextCards<T extends AgentComposerContextItem>(props)`

- [ ] **Step 1: Write the failing shared component tests**

Create `apps/web/src/components/AgentComposerContext.test.tsx`:

```tsx
import { fireEvent, render, screen, within } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import {
  AgentComposerContextCards,
  moveContextItem,
  removeContextItem,
  upsertContextItems,
  type AgentComposerContextItem,
} from "./AgentComposerContext.tsx";

const baseItems: AgentComposerContextItem[] = [
  { id: "local-path:/tmp/a.png", type: "local-path", title: "a.png", subtitle: "/tmp/a.png", path: "/tmp/a.png" },
  { id: "moodboard:m1", type: "moodboard", title: "Warm references", subtitle: "Moodboard", moodboardId: "m1", name: "Warm references" },
  { id: "text-context:fig", type: "text-context", title: "Figma import", subtitle: ".fig", body: "Buttons and cards" },
];

test("context item helpers dedupe, remove, and reorder by id", () => {
  expect(upsertContextItems(baseItems, [{ ...baseItems[1], title: "Warm references updated" }])).toEqual([
    baseItems[0],
    { ...baseItems[1], title: "Warm references updated" },
    baseItems[2],
  ]);
  expect(removeContextItem(baseItems, "moodboard:m1")).toEqual([baseItems[0], baseItems[2]]);
  expect(moveContextItem(baseItems, "text-context:fig", "local-path:/tmp/a.png")).toEqual([baseItems[2], baseItems[0], baseItems[1]]);
});

test("AgentComposerContextCards renders typed cards, removes, and drag reorders", () => {
  const onChange = vi.fn();
  const onRemove = vi.fn();
  render(<AgentComposerContextCards items={baseItems} onChange={onChange} onRemove={onRemove} />);

  const list = screen.getByLabelText("Agent context cards");
  expect(within(list).getByText("a.png")).toBeInTheDocument();
  expect(within(list).getByText("Warm references")).toBeInTheDocument();
  expect(within(list).getByText("Figma import")).toBeInTheDocument();

  fireEvent.click(screen.getByLabelText("Remove Warm references"));
  expect(onRemove).toHaveBeenCalledWith("moodboard:m1");

  const dragHandle = screen.getByLabelText("Drag Figma import");
  fireEvent.dragStart(dragHandle, {
    dataTransfer: {
      effectAllowed: "",
      setData: vi.fn(),
    },
  });
  fireEvent.drop(screen.getByTestId("agent-context-card-local-path:/tmp/a.png"), {
    dataTransfer: {
      getData: vi.fn(() => "text-context:fig"),
    },
  });
  expect(onChange).toHaveBeenCalledWith([baseItems[2], baseItems[0], baseItems[1]]);
});
```

- [ ] **Step 2: Run shared test to verify it fails**

Run: `pnpm --filter @dezin/web test -- AgentComposerContext.test.tsx`

Expected: FAIL with a module resolution error for `./AgentComposerContext.tsx`.

- [ ] **Step 3: Implement the shared model and cards**

Create `apps/web/src/components/AgentComposerContext.tsx` with these exports:

```tsx
import type { ReactNode } from "react";
import { FileText, FolderOpen, GripVertical, Images, Layers, MousePointerClick, Paperclip, X } from "lucide-react";
import { cn } from "../lib/utils.ts";

export type AgentComposerContextItem<PreviewTarget = unknown> =
  | { id: string; type: "file"; title: string; subtitle?: string; name: string; path: string }
  | { id: string; type: "local-path"; title: string; subtitle?: string; path: string }
  | { id: string; type: "project"; title: string; subtitle?: string; projectId: string; name: string; referencePath?: string }
  | { id: string; type: "moodboard"; title: string; subtitle?: string; moodboardId: string; name?: string }
  | { id: string; type: "preview-target"; title: string; subtitle?: string; selector: string; note?: string; target: PreviewTarget }
  | { id: string; type: "canvas-node"; title: string; subtitle?: string; nodeId: string; nodeType: string; body: string }
  | { id: string; type: "text-context"; title: string; subtitle?: string; body: string };

export function upsertContextItems<T extends AgentComposerContextItem>(items: T[], incoming: T[]): T[] {
  const next = [...items];
  for (const item of incoming) {
    const index = next.findIndex((existing) => existing.id === item.id);
    if (index === -1) next.push(item);
    else next[index] = item;
  }
  return next;
}

export function removeContextItem<T extends AgentComposerContextItem>(items: T[], id: string): T[] {
  return items.filter((item) => item.id !== id);
}

export function moveContextItem<T extends AgentComposerContextItem>(items: T[], activeId: string, overId: string): T[] {
  if (activeId === overId) return items;
  const from = items.findIndex((item) => item.id === activeId);
  const to = items.findIndex((item) => item.id === overId);
  if (from < 0 || to < 0) return items;
  const next = [...items];
  const [item] = next.splice(from, 1);
  if (!item) return items;
  next.splice(to, 0, item);
  return next;
}

function contextIcon(type: AgentComposerContextItem["type"]): ReactNode {
  switch (type) {
    case "file":
      return <Paperclip size={12} strokeWidth={1.75} />;
    case "local-path":
      return <FolderOpen size={12} strokeWidth={1.75} />;
    case "project":
      return <Layers size={12} strokeWidth={1.75} />;
    case "moodboard":
      return <Images size={12} strokeWidth={1.75} />;
    case "preview-target":
      return <MousePointerClick size={12} strokeWidth={1.75} />;
    case "canvas-node":
      return <Images size={12} strokeWidth={1.75} />;
    case "text-context":
      return <FileText size={12} strokeWidth={1.75} />;
  }
}

export function AgentComposerContextCards<T extends AgentComposerContextItem>({
  items,
  onChange,
  onRemove,
  className,
}: {
  items: T[];
  onChange: (items: T[]) => void;
  onRemove: (id: string) => void;
  className?: string;
}) {
  if (!items.length) return null;

  return (
    <div aria-label="Agent context cards" className={cn("mb-2 flex flex-wrap gap-1.5", className)}>
      {items.map((item) => (
        <div
          key={item.id}
          data-testid={`agent-context-card-${item.id}`}
          onDragOver={(event) => {
            event.preventDefault();
            event.stopPropagation();
            event.dataTransfer.dropEffect = "move";
          }}
          onDrop={(event) => {
            event.preventDefault();
            event.stopPropagation();
            const activeId = event.dataTransfer.getData("application/x-dezin-agent-context-id") || event.dataTransfer.getData("text/plain");
            if (activeId) onChange(moveContextItem(items, activeId, item.id));
          }}
          className="group flex max-w-full items-center gap-1 rounded-md border border-border bg-surface-2 px-1 py-1 text-xs text-foreground-2"
          title={item.subtitle ? `${item.title}: ${item.subtitle}` : item.title}
        >
          <button
            type="button"
            aria-label={`Drag ${item.title}`}
            draggable
            onDragStart={(event) => {
              event.stopPropagation();
              event.dataTransfer.effectAllowed = "move";
              event.dataTransfer.setData("application/x-dezin-agent-context-id", item.id);
              event.dataTransfer.setData("text/plain", item.id);
            }}
            className="grid h-5 w-4 shrink-0 cursor-grab place-items-center rounded text-muted-foreground transition-colors hover:bg-surface hover:text-foreground active:cursor-grabbing"
          >
            <GripVertical size={12} strokeWidth={1.75} />
          </button>
          <span className="shrink-0 text-brand">{contextIcon(item.type)}</span>
          <span className="min-w-0 truncate font-medium">{item.title}</span>
          {item.subtitle ? <span className="min-w-0 truncate text-muted-foreground">· {item.subtitle}</span> : null}
          <button
            type="button"
            aria-label={`Remove ${item.title}`}
            onClick={() => onRemove(item.id)}
            className="grid h-5 w-5 shrink-0 place-items-center rounded text-muted-foreground transition-colors hover:bg-surface hover:text-foreground"
          >
            <X size={11} strokeWidth={2} />
          </button>
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 4: Run shared test to verify it passes**

Run: `pnpm --filter @dezin/web test -- AgentComposerContext.test.tsx`

Expected: PASS.

- [ ] **Step 5: Commit Task 1**

Run:

```bash
git add apps/web/src/components/AgentComposerContext.tsx apps/web/src/components/AgentComposerContext.test.tsx
git commit -m "Add shared agent composer context cards"
```

Expected: commit succeeds on `feature/agent-composer-context-cards`.

---

### Task 2: Project Agent Composer Integration

**Files:**
- Modify: `apps/web/src/screens/WorkspaceScreen.tsx`
- Modify: `apps/web/src/screens/workspace.test.tsx`
- Test: `apps/web/src/components/AgentComposerContext.test.tsx`

**Interfaces:**
- Consumes: `AgentComposerContextItem<MarkupTarget>`
- Consumes: `AgentComposerContextCards`
- Produces: card-backed Project Agent send serialization that preserves `brief` text and `moodboardRefs`.

- [ ] **Step 1: Write the failing Project Agent integration test**

Add this test near the existing send tests in `apps/web/src/screens/workspace.test.tsx`:

```tsx
test("project agent composer cards serialize context at send time", async () => {
  const streamRun = vi.fn((input: { brief: string; moodboardRefs?: Array<{ id: string; name?: string }> }) =>
    (async function* (): AsyncGenerator<RunEvent> {
      yield { type: "run-start", runId: "r-context", conversationId: "c1" };
      yield { type: "run-done", runId: "r-context", passed: true, rounds: 0, previewUrl: "/projects/p1/preview/", findings: [] };
    })(),
  );
  const fake = makeFakeApi({
    streamRun: streamRun as never,
    listMoodboards: async () => [{ id: "mood-1", name: "Warm references", createdAt: 1, updatedAt: 1 }],
  });

  render(
    <ApiProvider client={fake}>
      <WorkspaceScreen projectId="p1" />
    </ApiProvider>,
  );

  await screen.findByLabelText("Message");
  dispatchPreviewMessage({
    type: "selected",
    selector: ".hero-title",
    tag: "h1",
    text: "Old title",
    rect: { x: 10, y: 20, w: 200, h: 80 },
  });
  fireEvent.change(await screen.findByPlaceholderText(/Describe the change to this element/), { target: { value: "Make this sharper" } });
  fireEvent.click(screen.getByRole("button", { name: "Add" }));

  expect(await screen.findByText(".hero-title")).toBeInTheDocument();
  expect(screen.getByLabelText("Agent context cards")).toBeInTheDocument();

  fireEvent.change(screen.getByLabelText("Message"), { target: { value: "Use the selected references" } });
  fireEvent.click(screen.getByLabelText("Send"));

  await waitFor(() => expect(streamRun).toHaveBeenCalled());
  const input = streamRun.mock.calls[0][0] as { brief: string; moodboardRefs?: Array<{ id: string; name?: string }> };
  expect(input.brief).toContain("Use the selected references");
  expect(input.brief).toContain("Scoped edit");
  expect(input.brief).toContain("selector: `.hero-title`");
  expect(input.brief).toContain("Make this sharper");
  expect(screen.queryByText(".hero-title")).toBeNull();
});
```

- [ ] **Step 2: Run Project Agent test to verify it fails**

Run: `pnpm --filter @dezin/web test -- workspace.test.tsx -t "project agent composer cards serialize context at send time"`

Expected: FAIL because selected preview elements still render through old scoped edit chips and not the shared card list.

- [ ] **Step 3: Replace Project Agent ad hoc context state with card state**

In `WorkspaceScreen.tsx`, import shared helpers:

```tsx
import {
  AgentComposerContextCards,
  removeContextItem,
  upsertContextItems,
  type AgentComposerContextItem,
} from "../components/AgentComposerContext.tsx";
```

Add local aliases near existing `MoodboardRunRef`:

```tsx
type WorkspaceContextItem = AgentComposerContextItem<MarkupTarget>;
```

Replace the three context states with one:

```tsx
const [contextItems, setContextItems] = useState<WorkspaceContextItem[]>([]);
```

Add helpers inside `WorkspaceScreen`:

```tsx
const addContextItems = (items: WorkspaceContextItem[]): void => {
  setContextItems((current) => upsertContextItems(current, items));
};

const selectedTargetItems = contextItems.filter((item): item is Extract<WorkspaceContextItem, { type: "preview-target" }> => item.type === "preview-target");
const selectedTargets = selectedTargetItems.map((item) => item.target);
const selectedMoodboardRefs = contextItems
  .filter((item): item is Extract<WorkspaceContextItem, { type: "moodboard" }> => item.type === "moodboard")
  .map((item) => ({ id: item.moodboardId, name: item.name }));
const hasComposerContext = contextItems.length > 0;
```

Update `addMark` to call `addContextItems`:

```tsx
const target: MarkupTarget = {
  selector: pendingMark.selector,
  tag: pendingMark.tag,
  text: pendingMark.text,
  rect: pendingMark.rect,
  styles: pendingMark.styles,
  note: note.trim() || undefined,
};
addContextItems([
  {
    id: `preview-target:${target.selector}:${target.note ?? ""}`,
    type: "preview-target",
    title: target.selector,
    subtitle: target.note || target.tag || "Preview element",
    selector: target.selector,
    note: target.note,
    target,
  },
]);
```

- [ ] **Step 4: Serialize Project Agent cards at send time**

Replace `send` context construction with:

```tsx
const fileReferencePaths = contextItems.flatMap((item) => {
  if (item.type === "file") return [item.path];
  if (item.type === "project" && item.referencePath) return [item.referencePath];
  return [];
});
const localPathItems = contextItems.filter((item): item is Extract<WorkspaceContextItem, { type: "local-path" }> => item.type === "local-path");
const textContextItems = contextItems.filter((item): item is Extract<WorkspaceContextItem, { type: "text-context" }> => item.type === "text-context");
const fileRefs = fileReferencePaths.length
  ? `\n\nReference files (read them from disk): ${fileReferencePaths.join(", ")}`
  : "";
const localPathRefs = localPathItems.length
  ? `\n\nReference local paths: ${localPathItems.map((item) => item.path).join(", ")}`
  : "";
const textContextRefs = textContextItems.length
  ? `\n\n${textContextItems.map((item) => `${item.title}:\n${item.body}`).join("\n\n")}`
  : "";
const boardRefs = moodboardReferenceLine(selectedMoodboardRefs);
const targets = selectedTargets.length
  ? `\n\nScoped edit - change ONLY the element(s) below and keep the rest of the design byte-for-byte unchanged:\n${selectedTargets
      .map(formatMarkupTarget)
      .join("\n")}`
  : "";
const base = input.trim() || (selectedTargets.length ? "Refine the marked element(s) per the notes." : "");
const text = base + targets + fileRefs + localPathRefs + textContextRefs + boardRefs;
```

After successful send setup, clear with `setContextItems([])`. Keep queued prompt behavior using `selectedMoodboardRefs`.

- [ ] **Step 5: Render Project Agent cards and wire AttachMenu**

Replace the old selected target, attachment, and moodboard chip blocks with:

```tsx
<AgentComposerContextCards items={contextItems} onChange={setContextItems} onRemove={(id) => setContextItems((items) => removeContextItem(items, id))} />
```

Update `AttachMenu` props:

```tsx
onPickPaths={(paths) =>
  addContextItems(
    paths.map((path) => ({
      id: `local-path:${path}`,
      type: "local-path",
      title: path.split("/").filter(Boolean).pop() || path,
      subtitle: path,
      path,
    })),
  )
}
onContext={(text) =>
  addContextItems([
    {
      id: `text-context:${Date.now()}`,
      type: "text-context",
      title: "Imported context",
      subtitle: "Text",
      body: text,
    },
  ])
}
```

Update file upload and project reference handlers to add `file` and `project` cards with `path` or `referencePath`.

Update send/stop disabled conditions to use `hasComposerContext` instead of `selectedTargets.length`.

- [ ] **Step 6: Run Project Agent test to verify it passes**

Run: `pnpm --filter @dezin/web test -- workspace.test.tsx -t "project agent composer cards serialize context at send time"`

Expected: PASS.

- [ ] **Step 7: Run shared and workspace focused tests**

Run:

```bash
pnpm --filter @dezin/web test -- AgentComposerContext.test.tsx workspace.test.tsx
```

Expected: PASS.

- [ ] **Step 8: Commit Task 2**

Run:

```bash
git add apps/web/src/screens/WorkspaceScreen.tsx apps/web/src/screens/workspace.test.tsx
git commit -m "Use context cards in project agent composer"
```

Expected: commit succeeds.

---

### Task 3: Moodboard Agent Composer Integration

**Files:**
- Modify: `apps/web/src/moodboard/MoodboardAgentPanel.tsx`
- Modify: `apps/web/src/screens/MoodboardScreen.tsx`
- Modify: `apps/web/src/moodboard/moodboard-ui.test.tsx`
- Test: `apps/web/src/components/AgentComposerContext.test.tsx`

**Interfaces:**
- Consumes: `AgentComposerContextItem`
- Changes: `MoodboardComposerInsertion` from `{ id: number; text: string }` to `{ id: number; items: AgentComposerContextItem[] }`
- Produces: Moodboard Agent send serialization for `canvas-node`, `local-path`, `project`, and `text-context` cards.

- [ ] **Step 1: Write the failing Moodboard Agent test**

Add this test near other `MoodboardAgentPanel` tests in `apps/web/src/moodboard/moodboard-ui.test.tsx`:

```tsx
test("MoodboardAgentPanel renders canvas insertion as a removable sendable context card", async () => {
  const onSend = vi.fn(async () => {});
  render(
    <ApiProvider client={makeFakeApi()}>
      <MoodboardAgentPanel
        boardName="Canvas QA"
        messages={[]}
        busy={false}
        agents={[]}
        agent=""
        model=""
        onBack={() => {}}
        onAgentChange={() => {}}
        onModelChange={() => {}}
        onRescanAgents={async () => {}}
        onSend={onSend}
        composerInsertion={{
          id: 1,
          items: [
            {
              id: "canvas-node:n1",
              type: "canvas-node",
              title: "Hero image",
              subtitle: "image",
              nodeId: "n1",
              nodeType: "image",
              body: "Hero image [image, id:n1] at x:10, y:20, 200x120",
            },
          ],
        }}
      />
    </ApiProvider>,
  );

  expect(await screen.findByText("Hero image")).toBeInTheDocument();
  expect(screen.getByLabelText("Message")).toHaveValue("");
  fireEvent.click(screen.getByLabelText("Send"));

  await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
  expect(onSend.mock.calls[0][0]).toContain("Selected moodboard node:");
  expect(onSend.mock.calls[0][0]).toContain("Hero image [image, id:n1]");
  expect(screen.queryByText("Hero image")).toBeNull();
});
```

- [ ] **Step 2: Run Moodboard Agent test to verify it fails**

Run: `pnpm --filter @dezin/web test -- moodboard-ui.test.tsx -t "MoodboardAgentPanel renders canvas insertion"`

Expected: FAIL because `composerInsertion` still accepts raw text and appends it to the textarea.

- [ ] **Step 3: Update MoodboardAgentPanel card state and serialization**

In `MoodboardAgentPanel.tsx`, import shared helpers:

```tsx
import {
  AgentComposerContextCards,
  removeContextItem,
  upsertContextItems,
  type AgentComposerContextItem,
} from "../components/AgentComposerContext.tsx";
```

Change the insertion type:

```tsx
export type MoodboardComposerInsertion = {
  id: number;
  items: AgentComposerContextItem[];
};
```

Add state and helpers:

```tsx
const [contextItems, setContextItems] = useState<AgentComposerContextItem[]>([]);
const hasComposerContext = contextItems.length > 0;
const addContextItems = useCallback((items: AgentComposerContextItem[]) => {
  setContextItems((current) => upsertContextItems(current, items));
}, []);
```

Replace raw insertion append:

```tsx
useEffect(() => {
  if (!composerInsertion?.items.length) return;
  addContextItems(composerInsertion.items);
  const frame = window.requestAnimationFrame(focusComposerEnd);
  return () => window.cancelAnimationFrame(frame);
}, [addContextItems, composerInsertion?.id, composerInsertion?.items, focusComposerEnd]);
```

Add serialization:

```tsx
function serializeMoodboardComposerContext(items: AgentComposerContextItem[]): string {
  const parts: string[] = [];
  const canvasNodes = items.filter((item): item is Extract<AgentComposerContextItem, { type: "canvas-node" }> => item.type === "canvas-node");
  if (canvasNodes.length) {
    parts.push([canvasNodes.length === 1 ? "Selected moodboard node:" : `Selected moodboard nodes (${canvasNodes.length}):`, ...canvasNodes.map((item, index) => `${index + 1}. ${item.body}`)].join("\n"));
  }
  const localPaths = items.filter((item): item is Extract<AgentComposerContextItem, { type: "local-path" }> => item.type === "local-path");
  if (localPaths.length) parts.push(`Reference local paths: ${localPaths.map((item) => item.path).join(", ")}`);
  const projects = items.filter((item): item is Extract<AgentComposerContextItem, { type: "project" }> => item.type === "project");
  if (projects.length) parts.push(`Reference Dezin projects: ${projects.map((item) => `${item.name} (${item.projectId})`).join(", ")}`);
  const textContexts = items.filter((item): item is Extract<AgentComposerContextItem, { type: "text-context" }> => item.type === "text-context");
  if (textContexts.length) parts.push(textContexts.map((item) => `${item.title}:\n${item.body}`).join("\n\n"));
  return parts.join("\n\n");
}
```

Use it in `submit`:

```tsx
const base = text.trim();
const context = serializeMoodboardComposerContext(contextItems);
const content = [base, context].filter(Boolean).join("\n\n");
if (!content || busy) return;
setText("");
setContextItems([]);
await onSend(content);
```

Render `<AgentComposerContextCards>` above the textarea and enable Send when `text.trim().length > 0 || hasComposerContext`.

- [ ] **Step 4: Wire MoodboardScreen canvas nodes into cards**

In `MoodboardScreen.tsx`, import the item type:

```tsx
import type { AgentComposerContextItem } from "../components/AgentComposerContext.tsx";
```

Add a card formatter near `formatMoodboardNodeAgentContext`:

```tsx
function formatMoodboardNodeAgentCard(node: MoodboardNode): AgentComposerContextItem {
  const label = layerLabel(node).replace(/\s+/g, " ").trim() || node.type;
  const type = node.type.replace(/-/g, " ");
  return {
    id: `canvas-node:${node.id}`,
    type: "canvas-node",
    title: label,
    subtitle: type,
    nodeId: node.id,
    nodeType: node.type,
    body: `${label} [${type}, id:${node.id}] at x:${Math.round(node.x)}, y:${Math.round(node.y)}, ${Math.round(node.width)}x${Math.round(node.height)}`,
  };
}
```

Change `sendNodesToAgent` to:

```tsx
setComposerInsertion({
  id: composerInsertionSeq.current,
  items: nodes.map(formatMoodboardNodeAgentCard),
});
```

Keep `formatMoodboardNodeAgentContext` exported for existing tests or callers.

- [ ] **Step 5: Run Moodboard Agent test to verify it passes**

Run: `pnpm --filter @dezin/web test -- moodboard-ui.test.tsx -t "MoodboardAgentPanel renders canvas insertion"`

Expected: PASS.

- [ ] **Step 6: Run focused web tests**

Run:

```bash
pnpm --filter @dezin/web test -- AgentComposerContext.test.tsx workspace.test.tsx moodboard-ui.test.tsx
```

Expected: PASS.

- [ ] **Step 7: Commit Task 3**

Run:

```bash
git add apps/web/src/moodboard/MoodboardAgentPanel.tsx apps/web/src/screens/MoodboardScreen.tsx apps/web/src/moodboard/moodboard-ui.test.tsx
git commit -m "Use context cards in moodboard agent composer"
```

Expected: commit succeeds.

---

### Task 4: Final Verification

**Files:**
- Modify only if verification exposes a bug in the changed files.

**Interfaces:**
- Consumes: Task 1-3 commits.
- Produces: verified branch ready for review.

- [ ] **Step 1: Run focused tests**

Run:

```bash
pnpm --filter @dezin/web test -- AgentComposerContext.test.tsx workspace.test.tsx moodboard-ui.test.tsx
```

Expected: PASS.

- [ ] **Step 2: Run web build**

Run: `pnpm --filter @dezin/web build`

Expected: PASS with a Vite production build.

- [ ] **Step 3: Run repo typecheck**

Run: `pnpm typecheck`

Expected: PASS.

- [ ] **Step 4: Inspect diff quality**

Run:

```bash
git status --short
git diff --check HEAD
git log --oneline --decorate -5
```

Expected: no whitespace errors; branch contains the spec commit and task commits.
