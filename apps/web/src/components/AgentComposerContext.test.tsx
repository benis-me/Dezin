import { useState } from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import {
  AgentComposerContextCards,
  moveContextItem,
  removeContextItem,
  upsertContextItems,
  type AgentComposerContextItem,
} from "./AgentComposerContext.tsx";

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

test("context item helpers dedupe, remove, and reorder by id", () => {
  expect(upsertContextItems(baseItems, [{ ...baseItems[1], title: "Warm references updated" }])).toEqual([
    baseItems[0],
    { ...baseItems[1], title: "Warm references updated" },
    baseItems[2],
  ]);
  expect(removeContextItem(baseItems, "moodboard:m1")).toEqual([baseItems[0], baseItems[2]]);
  expect(moveContextItem(baseItems, "text-context:fig", "file:.refs/cloud.png")).toEqual([baseItems[2], baseItems[0], baseItems[1]]);
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
  expect(list).toHaveAttribute("data-context-layout", "rail");
  expect(list).toHaveAttribute("data-context-density", "panel");
  expect(screen.getAllByRole("listitem")).toHaveLength(3);
  expect(within(list).getByText("cloud.png")).toBeInTheDocument();
  expect(within(list).getByText("Warm references")).toBeInTheDocument();
  expect(within(list).getByText("Figma import")).toBeInTheDocument();
  const cloudCard = screen.getByTestId("agent-context-card-file:.refs/cloud.png");
  const cloudDragHandle = screen.getByLabelText("Drag cloud.png");
  expect(cloudCard).toHaveAttribute("data-context-icon", "image");
  expect(cloudCard).not.toHaveClass("touch-none");
  expect(cloudDragHandle).toHaveClass("touch-none");
  await waitFor(() => expect(cloudDragHandle).toHaveAttribute("aria-roledescription", "draggable"));
  expect(cloudCard).not.toHaveAttribute("aria-roledescription", "draggable");
  expect(screen.getByRole("img", { name: "cloud.png" })).toHaveAttribute("src", "data:image/png;base64,Y2xvdWQ=");
  expect(screen.getByText("Image")).toBeInTheDocument();
  expect(screen.getByText("Moodboard")).toBeInTheDocument();
  expect(screen.getByText("Imported context")).toBeInTheDocument();
  expect(screen.getByLabelText("Remove cloud.png")).toHaveClass("focus-visible:ring-2");
  expect(screen.getByLabelText("Drag Figma import")).not.toHaveAttribute("draggable", "true");

  fireEvent.click(screen.getByLabelText("Remove Warm references"));
  expect(onRemove).toHaveBeenCalledWith("moodboard:m1");

  fireEvent.click(screen.getByRole("button", { name: "Move Figma import before previous context card" }));
  expect(onChange).toHaveBeenCalledWith([baseItems[0], baseItems[2], baseItems[1]]);
  fireEvent.click(screen.getByRole("button", { name: "Move Figma import before previous context card" }));
  expect(onChange).toHaveBeenCalledWith([baseItems[2], baseItems[0], baseItems[1]]);
});

test("AgentComposerContextCards keeps a single panel card and its remove control enabled", async () => {
  render(
    <AgentComposerContextCards
      items={[baseItems[0]!]}
      onChange={vi.fn()}
      onRemove={vi.fn()}
    />,
  );

  const panelCard = screen.getByRole("listitem");
  const removeButton = screen.getByRole("button", { name: "Remove cloud.png" });
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  await waitFor(() => expect(panelCard).not.toHaveAttribute("aria-disabled", "true"));
  expect(removeButton.closest('[aria-disabled="true"]')).toBeNull();
  expect(panelCard).toHaveClass("h-10", "w-52", "basis-52");
  expect(removeButton).toHaveClass("size-7");
  expect(removeButton).not.toHaveClass("size-8");
});

test("AgentComposerContextCards supports a preview-led hero rail without sorting", async () => {
  render(
    <AgentComposerContextCards
      items={baseItems}
      onChange={vi.fn()}
      onRemove={vi.fn()}
      density="hero"
      sortable={false}
    />,
  );

  expect(screen.getByRole("list", { name: "Attached context" })).toHaveAttribute("data-context-density", "hero");
  expect(screen.queryByLabelText("Agent context cards")).not.toBeInTheDocument();
  expect(screen.queryByLabelText("Drag cloud.png")).not.toBeInTheDocument();
  const heroCard = screen.getByTestId("agent-context-card-file:.refs/cloud.png");
  const removeButton = screen.getByRole("button", { name: "Remove cloud.png" });
  const previewRegion = screen.getByRole("img", { name: "cloud.png" }).parentElement;
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  await waitFor(() => expect(heroCard).not.toHaveAttribute("aria-disabled", "true"));
  expect(removeButton.closest('[aria-disabled="true"]')).toBeNull();
  expect(heroCard).toHaveClass("flex-col", "h-28", "w-44", "basis-44", "items-stretch");
  expect(previewRegion).toHaveClass("h-16", "w-full");
  expect(removeButton).toHaveClass("absolute", "right-1.5", "top-1.5", "size-8");
  expect(removeButton).not.toHaveClass("size-7");
});
