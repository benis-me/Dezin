import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { ArtifactHeader } from "./ArtifactHeader.tsx";

afterEach(cleanup);

const artifact = {
  id: "page-home",
  workspaceId: "workspace-1",
  kind: "page" as const,
  name: "Home",
  sourceRoot: "src/pages/home",
  legacyWrapped: false,
  activeTrackId: "track-main",
  archivedAt: null,
  createdAt: 1,
  updatedAt: 1,
};

function renderHeader(overrides: Partial<ComponentProps<typeof ArtifactHeader>> = {}) {
  const onTogglePresentation = vi.fn();
  render(
    <ArtifactHeader
      artifact={artifact}
      artifactId={artifact.id}
      revisionSequence={3}
      frames={[{
        id: "desktop",
        name: "Desktop",
        width: 1440,
        height: 1000,
      }]}
      activeFrameId="desktop"
      zoom={0.75}
      readOnly={false}
      presentation={false}
      previewReady
      onBack={vi.fn()}
      onFrameChange={vi.fn()}
      onZoomChange={vi.fn()}
      onFitPreview={vi.fn()}
      onTogglePresentation={onTogglePresentation}
      pinnedRevisionId={null}
      onOpenVersions={vi.fn()}
      onOpenCompare={vi.fn()}
      onReturnToHead={vi.fn()}
      {...overrides}
    />,
  );
  return { onTogglePresentation };
}

test("Exit present always remains available when preview readiness changes", async () => {
  const user = userEvent.setup();
  const { onTogglePresentation } = renderHeader({ presentation: true, previewReady: false });

  const exit = screen.getByRole("button", { name: "Exit present" });
  expect(exit).toBeEnabled();
  expect(screen.getByRole("button", { name: "Versions" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Compare" })).toBeDisabled();
  await user.click(exit);
  expect(onTogglePresentation).toHaveBeenCalledTimes(1);
});

test("artifact navigation and zoom controls use accessible Dezin tooltips", async () => {
  const user = userEvent.setup();
  renderHeader();

  const back = screen.getByRole("button", { name: "Back to workspace canvas" });
  await user.hover(back);
  expect(await screen.findByRole("tooltip")).toHaveTextContent("Back to workspace");

  await user.unhover(back);
  const zoomOut = screen.getByRole("button", { name: "Zoom out" });
  await user.hover(zoomOut);
  expect(await screen.findByRole("tooltip")).toHaveTextContent("Zoom out");
  expect(screen.getByRole("combobox", { name: "Preview frame" })).toHaveTextContent("Desktop");
});

test("responsive artifact actions keep accessible names and tooltips when their labels collapse", async () => {
  const user = userEvent.setup();
  renderHeader();

  const versions = screen.getByRole("button", { name: "Versions" });
  const compare = screen.getByRole("button", { name: "Compare" });
  const present = screen.getByRole("button", { name: "Present" });

  expect(versions.querySelector(".artifact-action__label")).toHaveTextContent("Versions");
  expect(compare.querySelector(".artifact-action__label")).toHaveTextContent("Compare");
  expect(present.querySelector(".artifact-action__label")).toHaveTextContent("Present");

  await user.hover(compare);
  expect(await screen.findByRole("tooltip")).toHaveTextContent("Compare");
});

test("compact More menu keeps lower-priority controls keyboard reachable", async () => {
  const user = userEvent.setup();
  const onZoomChange = vi.fn();
  const onFitPreview = vi.fn();
  const onOpenVersions = vi.fn();
  const onOpenCompare = vi.fn();
  renderHeader({
    onZoomChange,
    onFitPreview,
    onOpenVersions,
    onOpenCompare,
  });

  const more = screen.getByRole("button", { name: "More artifact controls" });
  more.focus();
  await user.keyboard("{Enter}");
  expect(await screen.findByRole("menuitem", { name: "Zoom out" })).toBeInTheDocument();
  expect(screen.getByRole("menuitem", { name: "Zoom in" })).toBeInTheDocument();
  expect(screen.getByRole("menuitem", { name: "Fit preview" })).toBeInTheDocument();
  expect(screen.getByRole("menuitem", { name: "Versions" })).toBeInTheDocument();
  expect(screen.getByRole("menuitem", { name: "Compare" })).toBeInTheDocument();

  await user.click(screen.getByRole("menuitem", { name: "Zoom out" }));
  expect(onZoomChange).toHaveBeenCalledWith(0.65);

  await user.click(more);
  await user.click(await screen.findByRole("menuitem", { name: "Versions" }));
  expect(onOpenVersions).toHaveBeenCalledTimes(1);

  await user.click(more);
  await user.click(await screen.findByRole("menuitem", { name: "Compare" }));
  expect(onOpenCompare).toHaveBeenCalledTimes(1);
});

test("presentation frame menus render above the full-screen editor layer", async () => {
  const user = userEvent.setup();
  renderHeader({ presentation: true });

  await user.click(screen.getByRole("combobox", { name: "Preview frame" }));
  expect(await screen.findByRole("option", { name: "Desktop" })).toBeInTheDocument();
  expect(document.querySelector('[data-slot="select-content"]')).toHaveClass("z-[90]");
});
