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
