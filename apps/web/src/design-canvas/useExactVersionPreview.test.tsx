import { render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { expect, test, vi } from "vitest";

import type { DesignCanvasApi } from "./api.ts";
import type { DesignNode } from "./types.ts";
import { useExactVersionPreview } from "./useExactVersionPreview.ts";

function generatedNode(versionId: string): DesignNode {
  return {
    id: "page-preview",
    kind: "page",
    name: "Preview page",
    geometry: { x: 0, y: 0, width: 480, height: 360 },
    state: "ready",
    currentVersionId: versionId,
    selectedVersionId: null,
    versionCount: 1,
    assetId: null,
    activeJobId: null,
    error: null,
    createdAt: 1,
    updatedAt: 1,
  };
}

function PreviewHarness({ api, node }: { api: DesignCanvasApi; node: DesignNode }) {
  const result = useExactVersionPreview({
    api,
    projectId: "preview-project",
    node,
    enabled: true,
  });
  return (
    <span data-testid="preview-state">
      {result.versionId}:{result.preview?.url ?? (result.loading ? "loading" : result.error ?? "empty")}
    </span>
  );
}

test("StrictMode aborts only its own preview request and the remount still resolves", async () => {
  const getExactVersionPreview = vi.fn((_projectId: string, nodeId: string, versionId: string, signal?: AbortSignal) => (
    new Promise<{ nodeId: string; versionId: string; url: string }>((resolve, reject) => {
      const timer = window.setTimeout(() => resolve({ nodeId, versionId, url: `/preview/${versionId}` }), 0);
      signal?.addEventListener("abort", () => {
        window.clearTimeout(timer);
        reject(new DOMException("Aborted", "AbortError"));
      }, { once: true });
    })
  ));
  const api = { getExactVersionPreview } as unknown as DesignCanvasApi;

  render(<StrictMode><PreviewHarness api={api} node={generatedNode("strict-version")} /></StrictMode>);

  expect(await screen.findByText("strict-version:/preview/strict-version")).toBeInTheDocument();
  expect(getExactVersionPreview).toHaveBeenCalledTimes(2);
});

test("switching versions never exposes the previous preview under the new identity", async () => {
  let resolveSecond!: (value: { nodeId: string; versionId: string; url: string }) => void;
  const getExactVersionPreview = vi.fn(async (_projectId: string, nodeId: string, versionId: string) => {
    if (versionId === "version-one") return { nodeId, versionId, url: "/preview/one" };
    return new Promise<{ nodeId: string; versionId: string; url: string }>((resolve) => {
      resolveSecond = resolve;
    });
  });
  const api = { getExactVersionPreview } as unknown as DesignCanvasApi;
  const { rerender } = render(<PreviewHarness api={api} node={generatedNode("version-one")} />);
  expect(await screen.findByText("version-one:/preview/one")).toBeInTheDocument();

  rerender(<PreviewHarness api={api} node={generatedNode("version-two")} />);
  expect(screen.getByTestId("preview-state")).toHaveTextContent("version-two:loading");
  expect(screen.getByTestId("preview-state")).not.toHaveTextContent("/preview/one");

  resolveSecond({ nodeId: "page-preview", versionId: "version-two", url: "/preview/two" });
  await waitFor(() => expect(screen.getByTestId("preview-state")).toHaveTextContent("version-two:/preview/two"));
});
