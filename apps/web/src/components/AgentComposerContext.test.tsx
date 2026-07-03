import { useState } from "react";
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

test("AgentComposerContextCards renders typed cards, removes, and reorders without native file drag", () => {
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

  const list = screen.getByLabelText("Agent context cards");
  expect(within(list).getByText("a.png")).toBeInTheDocument();
  expect(within(list).getByText("Warm references")).toBeInTheDocument();
  expect(within(list).getByText("Figma import")).toBeInTheDocument();
  expect(screen.getByTestId("agent-context-card-local-path:/tmp/a.png")).toHaveAttribute("data-context-icon", "image");
  expect(screen.getByLabelText("Drag Figma import")).not.toHaveAttribute("draggable", "true");

  fireEvent.click(screen.getByLabelText("Remove Warm references"));
  expect(onRemove).toHaveBeenCalledWith("moodboard:m1");

  fireEvent.click(screen.getByRole("button", { name: "Move Figma import before previous context card" }));
  expect(onChange).toHaveBeenCalledWith([baseItems[0], baseItems[2], baseItems[1]]);
  fireEvent.click(screen.getByRole("button", { name: "Move Figma import before previous context card" }));
  expect(onChange).toHaveBeenCalledWith([baseItems[2], baseItems[0], baseItems[1]]);
});
