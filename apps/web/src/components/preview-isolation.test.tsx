import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { PreviewModal } from "./PreviewModal.tsx";
import { VersionCompare } from "./VersionCompare.tsx";

afterEach(cleanup);

test("PreviewModal sandboxes same-origin previews without allow-same-origin", () => {
  render(<PreviewModal open src="/projects/p1/preview/" onClose={() => {}} />);

  const iframe = screen.getByTitle("Artifact preview (full screen)");
  expect(iframe).toHaveAttribute("sandbox");
  expect(iframe.getAttribute("sandbox") ?? "").not.toContain("allow-same-origin");
});

test("VersionCompare sandboxes both version iframes", () => {
  render(
    <VersionCompare
      open
      onClose={vi.fn()}
      a={{ url: "/api/projects/p1/versions/r1", label: "Before" }}
      b={{ url: "/api/projects/p1/versions/r2", label: "After" }}
    />,
  );

  for (const iframe of [screen.getByTitle("Before"), screen.getByTitle("After")]) {
    expect(iframe).toHaveAttribute("sandbox");
    expect(iframe.getAttribute("sandbox") ?? "").not.toContain("allow-same-origin");
  }
});

test("VersionCompare slider keeps compared on the left and current on the right", () => {
  render(
    <VersionCompare open onClose={vi.fn()} a={{ url: "/old", label: "Main v1" }} b={{ url: "/current", label: "Main current" }} />,
  );

  const frames = screen.getAllByTitle(/Main/) as HTMLIFrameElement[];
  expect(frames.map((frame) => frame.title)).toEqual(["Main current", "Main v1"]);
  expect(frames[0]).toHaveAttribute("src", "/current");
  expect(frames[1]).toHaveAttribute("src", "/old");
  expect(screen.getByRole("button", { name: "Drag to compare" })).toHaveClass("w-9", "-translate-x-1/2");
  expect(screen.getByTestId("compare-divider-line")).toHaveClass("left-1/2", "-translate-x-1/2");
});

test("VersionCompare synchronizes iframe scroll bridge messages in both directions", async () => {
  render(
    <VersionCompare open onClose={vi.fn()} a={{ url: "/old", label: "Main v1" }} b={{ url: "/current", label: "Main current" }} />,
  );

  const currentFrame = screen.getByTitle("Main current") as HTMLIFrameElement;
  const comparedFrame = screen.getByTitle("Main v1") as HTMLIFrameElement;
  const currentPostMessage = vi.spyOn(currentFrame.contentWindow!, "postMessage");
  const comparedPostMessage = vi.spyOn(comparedFrame.contentWindow!, "postMessage");

  window.dispatchEvent(
    new MessageEvent("message", {
      data: { source: "dezin", type: "scroll", top: 180, left: 12 },
      source: currentFrame.contentWindow as MessageEventSource,
    }),
  );

  await waitFor(() => expect(comparedPostMessage).toHaveBeenCalledWith({ source: "dezin-parent", type: "sync-scroll", top: 180, left: 12 }, "*"));
  await new Promise((resolve) => setTimeout(resolve, 0));

  window.dispatchEvent(
    new MessageEvent("message", {
      data: { source: "dezin", type: "scroll", top: 42, left: 4 },
      source: comparedFrame.contentWindow as MessageEventSource,
    }),
  );

  await waitFor(() => expect(currentPostMessage).toHaveBeenCalledWith({ source: "dezin-parent", type: "sync-scroll", top: 42, left: 4 }, "*"));
});
