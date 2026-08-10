import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";

import { NodeGenerationStatus, NodeWorkingPlaceholder } from "./DesignCanvasNode.tsx";

test("a generating Node uses the animated dot field without a generic spinner", () => {
  const { container } = render(<NodeWorkingPlaceholder state="generating" label="Page" />);

  expect(screen.getByRole("status")).toHaveTextContent("Creating a page");
  expect(container.querySelector(".design-canvas-node__generation-field")).not.toBeNull();
  expect(container.querySelector(".design-canvas-node__generation-glow")).not.toBeNull();
  expect(container.querySelector("svg")).toBeNull();
});

test("an in-progress next revision reuses the dot field instead of a spinner badge", () => {
  const { container } = render(<NodeGenerationStatus state="generating" />);

  expect(screen.getByRole("status")).toHaveTextContent("Creating the next version");
  expect(container.querySelector(".design-canvas-node__working-dots")).toBeInTheDocument();
  expect(container.querySelector(".design-canvas-node__generation-field")).toBeInTheDocument();
  expect(container.querySelector(".design-canvas-node__generation-glow")).toBeInTheDocument();
  expect(container.querySelector("svg")).toBeNull();
});
