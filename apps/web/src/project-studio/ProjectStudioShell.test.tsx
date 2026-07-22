import { fireEvent, render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { ProjectStudioShell } from "./ProjectStudioShell.tsx";

function renderShell(inspectorOpen: boolean) {
  return render(
    <ProjectStudioShell
      agent={<div>Agent content</div>}
      main={<div>Main canvas</div>}
      inspector={<div>Inspector content</div>}
      inspectorOpen={inspectorOpen}
    />,
  );
}

test("a closed inspector leaves a true two-column Studio without mounting hidden inspector work", () => {
  renderShell(false);

  const shell = screen.getByTestId("project-studio-shell");
  expect(shell).toHaveAttribute("data-inspector-layout", "closed");
  expect(shell.className).toContain("xl:grid-cols-[272px_minmax(0,1fr)]");
  expect(screen.queryByRole("complementary", { name: "Inspector" })).not.toBeInTheDocument();
  expect(screen.queryByText("Inspector content")).not.toBeInTheDocument();
});

test("an open inspector docks only when the middle surface can retain its minimum working width", () => {
  renderShell(true);

  const shell = screen.getByTestId("project-studio-shell");
  expect(shell).toHaveAttribute("data-inspector-layout", "open");
  expect(shell.className).toContain("xl:grid-cols-[272px_minmax(640px,1fr)_minmax(224px,18vw)]");
  expect(screen.getByRole("complementary", { name: "Inspector" })).toHaveTextContent("Inspector content");

  fireEvent.click(screen.getByRole("button", { name: "Hide inspector" }));
  expect(screen.getByRole("complementary", { name: "Inspector" })).not.toHaveAttribute("data-narrow-reachable");
  expect(screen.getByRole("button", { name: "Show inspector" })).toBeInTheDocument();
});

test("the narrow Inspector moves focus inside on open and restores the trigger on close", () => {
  renderShell(true);

  const initialHide = screen.getByRole("button", { name: "Hide inspector" });
  initialHide.focus();
  fireEvent.click(initialHide);
  const show = screen.getByRole("button", { name: "Show inspector" });
  expect(show).toHaveFocus();

  fireEvent.click(show);
  const hide = screen.getByRole("button", { name: "Hide inspector" });
  expect(hide).toHaveFocus();

  fireEvent.click(hide);
  expect(screen.getByRole("button", { name: "Show inspector" })).toHaveFocus();
});
