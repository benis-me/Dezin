import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { expect, test, vi } from "vitest";

import type { DesignNode } from "./types.ts";
import {
  activeNodeMention,
  matchingMentionNodes,
  NodeMentionInput,
} from "./NodeMentionInput.tsx";

function nodes(count: number): DesignNode[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `node-${index}`,
    kind: index % 2 === 0 ? "page" : "component",
    name: `Node ${index}`,
    geometry: { x: index * 20, y: 0, width: 320, height: 240 },
    state: "empty",
    currentVersionId: null,
    selectedVersionId: null,
    versionCount: 0,
    assetId: null,
    activeJobId: null,
    error: null,
    createdAt: 1,
    updatedAt: 1,
  }));
}

function Harness({ allNodes }: { allNodes: readonly DesignNode[] }) {
  const [value, setValue] = useState("");
  const [ids, setIds] = useState<string[]>([]);
  return (
    <NodeMentionInput
      nodes={allNodes}
      value={value}
      onChange={setValue}
      priorityNodeIds={ids}
      onPriorityNodeIdsChange={setIds}
      ariaLabel="Agent message"
      placeholder="Type @"
      onSubmitShortcut={vi.fn()}
    />
  );
}

test("Node mentions detect the token at the caret and bound thousand-Node search results", () => {
  const allNodes = nodes(1_000);
  expect(activeNodeMention("Compare @node 99", 16)).toEqual({ start: 8, end: 16, query: "node 99" });
  expect(matchingMentionNodes(allNodes, "")).toHaveLength(8);
  expect(matchingMentionNodes(allNodes, "node 999").map((node) => node.id)).toEqual(["node-999"]);
});

test("typing @ searches a bounded palette and inserts one removable Node reference", async () => {
  const user = userEvent.setup();
  render(<Harness allNodes={nodes(1_000)} />);

  const composer = screen.getByRole("textbox", { name: "Agent message" });
  await user.type(composer, "Compare @node 999");
  expect(screen.getAllByRole("option")).toHaveLength(1);
  await user.keyboard("{Enter}");

  expect(composer).toHaveValue("Compare Node 999 ");
  const remove = screen.getByRole("button", { name: "Remove Node 999 reference" });
  await user.click(remove);
  expect(composer).toHaveValue("Compare Node 999 ");
  expect(screen.queryByLabelText("Referenced Nodes")).not.toBeInTheDocument();
});
