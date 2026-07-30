import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vitest";

import { TooltipProvider } from "./ui/index.ts";
import {
  ProjectActionsMenu,
  ProjectExportMenu,
  ProjectPanelToggleButton,
  ProjectSettingsButton,
} from "./ProjectHeaderActions.tsx";

function renderActions(open: boolean, onToggle = vi.fn(), onOpenSettings = vi.fn()) {
  return render(
    <TooltipProvider>
      <ProjectPanelToggleButton
        open={open}
        onToggle={onToggle}
        controls="project-studio-inspector"
      />
      <ProjectExportMenu
        sourceUrl="/api/projects/project-1/export"
        fullUrl="/api/projects/project-1/export?scope=full"
      />
      <ProjectSettingsButton onOpen={onOpenSettings} />
    </TooltipProvider>,
  );
}

test("exposes the build plan as a stable controlled header toggle", () => {
  const onToggle = vi.fn();
  const rendered = renderActions(false, onToggle);

  const toggle = screen.getByRole("button", { name: "Show build plan" });
  expect(toggle).toHaveAttribute("aria-controls", "project-studio-inspector");
  expect(toggle).toHaveAttribute("aria-expanded", "false");
  expect(toggle).toHaveAttribute("aria-pressed", "false");
  fireEvent.click(toggle);
  expect(onToggle).toHaveBeenCalledTimes(1);

  rendered.rerender(
    <TooltipProvider>
      <ProjectPanelToggleButton
        open
        onToggle={onToggle}
        controls="project-studio-inspector"
      />
    </TooltipProvider>,
  );
  expect(screen.getByRole("button", { name: "Hide build plan" })).toHaveAttribute("aria-expanded", "true");
});

test("keeps Export and Settings in the shared project action cluster", async () => {
  const onOpenSettings = vi.fn();
  renderActions(false, vi.fn(), onOpenSettings);

  fireEvent.click(screen.getByRole("button", { name: "Export project" }));
  expect(await screen.findByRole("menuitem", { name: "Source ZIP" }))
    .toHaveAttribute("href", "/api/projects/project-1/export");
  expect(screen.getByRole("menuitem", { name: "Full project ZIP" }))
    .toHaveAttribute("href", "/api/projects/project-1/export?scope=full");

  fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());
  fireEvent.click(screen.getByRole("button", { name: "Settings" }));
  expect(onOpenSettings).toHaveBeenCalledTimes(1);
});

test("exposes the original project actions through the shared accessible menu", async () => {
  const onRename = vi.fn();
  const onOpenInFinder = vi.fn();
  const onDelete = vi.fn();
  const onCopyAnalysisPrompt = vi.fn();
  render(
    <TooltipProvider>
      <ProjectActionsMenu
        canOpenInFinder
        onRename={onRename}
        onOpenInFinder={onOpenInFinder}
        onDelete={onDelete}
        onCopyAnalysisPrompt={onCopyAnalysisPrompt}
      />
    </TooltipProvider>,
  );

  const trigger = screen.getByRole("button", { name: "Project actions" });
  fireEvent.click(trigger);
  fireEvent.click(await screen.findByRole("menuitem", { name: "Rename project" }));
  expect(onRename).toHaveBeenCalledTimes(1);

  fireEvent.click(trigger);
  fireEvent.click(await screen.findByRole("menuitem", { name: "Open in Finder" }));
  expect(onOpenInFinder).toHaveBeenCalledTimes(1);

  fireEvent.click(trigger);
  const deleteItem = await screen.findByRole("menuitem", { name: "Delete project" });
  expect(deleteItem).toHaveAttribute("data-variant", "destructive");
  fireEvent.click(deleteItem);
  expect(onDelete).toHaveBeenCalledTimes(1);

  fireEvent.click(trigger);
  fireEvent.click(await screen.findByRole("menuitem", { name: "Copy Analysis Prompt" }));
  expect(onCopyAnalysisPrompt).toHaveBeenCalledTimes(1);
});

test("keeps Open in Finder visible but unavailable without a project path", async () => {
  const onOpenInFinder = vi.fn();
  render(
    <TooltipProvider>
      <ProjectActionsMenu
        canOpenInFinder={false}
        onRename={vi.fn()}
        onOpenInFinder={onOpenInFinder}
        onDelete={vi.fn()}
        onCopyAnalysisPrompt={vi.fn()}
      />
    </TooltipProvider>,
  );

  fireEvent.click(screen.getByRole("button", { name: "Project actions" }));
  const finderItem = await screen.findByRole("menuitem", { name: "Open in Finder" });
  expect(finderItem).toHaveAttribute("data-disabled");
  fireEvent.click(finderItem);
  expect(onOpenInFinder).not.toHaveBeenCalled();
});
