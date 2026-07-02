import { cleanup, render, screen } from "@testing-library/react";
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
