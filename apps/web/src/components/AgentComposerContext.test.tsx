import { useState } from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import {
  AgentComposerContextCards,
  moveContextItem,
  removeContextItem,
  serializeLegacyPrototypeComposerContext,
  serializeStructuredComposerContext,
  upsertContextItems,
  type AgentComposerContextItem,
} from "./AgentComposerContext.tsx";

type TestPreviewTarget = { selector: string; note?: string };

const baseItems: AgentComposerContextItem<TestPreviewTarget>[] = [
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

test("context item helpers dedupe, remove, and reorder by id", () => {
  expect(upsertContextItems(baseItems, [{ ...baseItems[1], title: "Warm references updated" }])).toEqual([
    baseItems[0],
    { ...baseItems[1], title: "Warm references updated" },
    baseItems[2],
  ]);
  expect(removeContextItem(baseItems, "moodboard:m1")).toEqual([baseItems[0], baseItems[2]]);
  expect(moveContextItem(baseItems, "text-context:fig", "file:.refs/cloud.png")).toEqual([baseItems[2], baseItems[0], baseItems[1]]);
});

test("structured composer context keeps references and selection out of the visible message", () => {
  const items: AgentComposerContextItem<{ selector: string; note?: string }>[] = [
    ...baseItems,
    { id: "effect:grain", type: "effect", title: "Grain", effectId: "grain", name: "Grain" },
    {
      id: "preview:.hero-title",
      type: "preview-target",
      title: ".hero-title",
      selector: ".hero-title",
      note: "Make it sharper",
      target: { selector: ".hero-title", note: "Make it sharper" },
    },
    {
      id: "canvas:hero",
      type: "canvas-node",
      title: "Hero",
      nodeId: "hero",
      nodeType: "section",
      body: "A trusted server resolver owns the node body.",
    },
  ];

  expect(serializeStructuredComposerContext(items, (item) => ({
    kind: "element",
    id: item.selector,
    locator: item.target,
  }))).toEqual({
    contextRefs: [
      {
        kind: "owned-source",
        id: "file:.refs/cloud.png",
        title: "cloud.png",
        resourceKind: "file",
        source: { type: "uploaded-file", uploadedFileId: ".refs/cloud.png" },
      },
      {
        kind: "owned-source",
        id: "moodboard:m1",
        title: "Warm references",
        resourceKind: "moodboard",
        source: { type: "moodboard", moodboardId: "m1" },
      },
      { kind: "inline", id: "text-context:fig", title: "Figma import", content: "Buttons and cards", trustLevel: "untrusted" },
      {
        kind: "owned-source",
        id: "effect:grain",
        title: "Grain",
        resourceKind: "effect",
        source: { type: "effect", effectId: "grain" },
      },
      {
        kind: "inline",
        id: "canvas:hero",
        title: "Hero",
        content: "A trusted server resolver owns the node body.",
        trustLevel: "untrusted",
      },
    ],
    selection: [
      { kind: "element", id: ".hero-title", locator: { selector: ".hero-title", note: "Make it sharper" } },
      { kind: "node", id: "hero", locator: { nodeType: "section" } },
    ],
  });
});

test("structured composer context blocks unsupported and oversized inline cards", () => {
  expect(() =>
    serializeStructuredComposerContext(
      [{ id: "path:/tmp/reference", type: "local-path", title: "Local folder", path: "/tmp/reference" }],
      () => ({ kind: "element", id: "unused" }),
    ),
  ).toThrow(/cannot safely resolve/);

  expect(() =>
    serializeStructuredComposerContext(
      [{ id: "text:large", type: "text-context", title: "Large import", body: "x".repeat(20_001) }],
      () => ({ kind: "element", id: "unused" }),
    ),
  ).toThrow(/exceeds 20000 characters/);

  expect(() =>
    serializeStructuredComposerContext(
      [{
        id: "preview:.hero",
        type: "preview-target",
        title: ".hero",
        selector: ".hero",
        target: { selector: ".hero" },
      }],
      (item) => ({ kind: "element", id: item.selector }),
    ),
  ).toThrow(/full stable locator/);
});

test("legacy Prototype serialization remains an explicit compatibility path", () => {
  const preview = {
    id: "preview:.hero-title",
    type: "preview-target" as const,
    title: ".hero-title",
    selector: ".hero-title",
    note: "Make it sharper",
    target: { selector: ".hero-title" },
  };

  expect(
    serializeLegacyPrototypeComposerContext("Refine the hero", [...baseItems, preview], (target) =>
      `selector: \`${target.selector}\``,
    ),
  ).toEqual({
    brief: expect.stringMatching(/Refine the hero[\s\S]*Scoped edit[\s\S]*selector: `\.hero-title`[\s\S]*Reference files[\s\S]*Figma import[\s\S]*Moodboard references/),
    moodboardRefs: [{ id: "m1", name: "Warm references" }],
    effectRefs: [],
  });
});

test("AgentComposerContextCards renders typed cards, removes, and reorders without native file drag", async () => {
  const onChange = vi.fn();
  const onRemove = vi.fn();
  function Harness() {
    const [items, setItems] = useState(baseItems);
    return (
      <AgentComposerContextCards
        items={items}
        onChange={(next) => {
          onChange(next);
          setItems(next);
        }}
        onRemove={onRemove}
      />
    );
  }
  render(<Harness />);

  const list = screen.getByRole("list", { name: "Attached context" });
  expect(list).toHaveAttribute("data-context-layout", "top-rail");
  expect(list).not.toHaveAttribute("data-context-density");
  expect(screen.getAllByRole("listitem")).toHaveLength(3);
  expect(within(list).getByText("cloud.png")).toBeInTheDocument();
  expect(within(list).getByText("Warm references")).toBeInTheDocument();
  expect(within(list).getByText("Figma import")).toBeInTheDocument();
  const cloudCard = screen.getByTestId("agent-context-card-file:.refs/cloud.png");
  const cloudDragHandle = screen.getByLabelText("Drag cloud.png");
  expect(cloudCard).toHaveClass("h-9", "min-w-28", "max-w-[184px]", "w-fit");
  expect(cloudCard).toHaveAttribute("data-context-icon", "image");
  expect(cloudCard).not.toHaveClass("touch-none");
  expect(cloudDragHandle).toHaveClass("touch-none");
  await waitFor(() => expect(cloudDragHandle).toHaveAttribute("aria-roledescription", "draggable"));
  expect(cloudCard).not.toHaveAttribute("aria-roledescription", "draggable");
  expect(screen.getByRole("img", { name: "cloud.png" })).toHaveAttribute("src", "data:image/png;base64,Y2xvdWQ=");
  expect(screen.getByRole("img", { name: "cloud.png" }).parentElement).toHaveClass("size-6");
  expect(screen.getByRole("button", { name: "Remove cloud.png" })).toHaveClass("size-5");
  expect(within(list).queryByText("Image")).toBeNull();
  expect(cloudCard.getAttribute("title")).toContain("cloud.png: Image · .refs/cloud.png · 2 KB");
  expect(screen.getByRole("button", { name: "Remove cloud.png" })).toHaveClass("focus-visible:ring-2");
  expect(screen.getByLabelText("Drag Figma import")).not.toHaveAttribute("draggable", "true");

  fireEvent.click(screen.getByLabelText("Remove Warm references"));
  expect(onRemove).toHaveBeenCalledWith("moodboard:m1");

  fireEvent.click(screen.getByRole("button", { name: "Move Figma import before previous context card" }));
  expect(onChange).toHaveBeenCalledWith([baseItems[0], baseItems[2], baseItems[1]]);
  fireEvent.click(screen.getByRole("button", { name: "Move Figma import before previous context card" }));
  expect(onChange).toHaveBeenCalledWith([baseItems[2], baseItems[0], baseItems[1]]);
});

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
