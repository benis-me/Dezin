import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { ArtifactNodePreview } from "./ArtifactNodePreview.tsx";

const getArtifactThumbnail = vi.fn();
const thumbnailApi = { getArtifactThumbnail };
const createObjectURL = vi.fn();
const revokeObjectURL = vi.fn();

vi.mock("../../../lib/api-context.tsx", () => ({
  useApi: () => thumbnailApi,
}));

describe("artifact node preview", () => {
  beforeEach(() => {
    getArtifactThumbnail.mockReset();
    getArtifactThumbnail.mockResolvedValue(new Blob(["preview"], { type: "image/png" }));
    createObjectURL.mockReset();
    revokeObjectURL.mockReset();
    let sequence = 0;
    createObjectURL.mockImplementation(() => `blob:thumbnail-${++sequence}`);
    vi.stubGlobal("URL", { ...URL, createObjectURL, revokeObjectURL });
  });

  test("distinguishes empty, loading, ready, and retryable failure states", async () => {
    const { container, rerender } = render(
      <ArtifactNodePreview
        artifactKind="page"
        projectId="project-1"
        artifactId="artifact-1"
        name="Checkout"
        revisionId={null}
      />,
    );
    expect(screen.getByText("Generate to preview")).toBeInTheDocument();
    expect(container.querySelector(".dezin-flow-card__preview")).toHaveAttribute("data-state", "empty");

    rerender(
      <ArtifactNodePreview
        artifactKind="page"
        projectId="project-1"
        artifactId="artifact-1"
        name="Checkout"
        revisionId="revision-1"
      />,
    );
    expect(screen.getByText("Rendering preview…")).toBeInTheDocument();
    expect(container.querySelector(".dezin-flow-card__preview")).toHaveAttribute("data-state", "loading");
    const firstImage = await screen.findByRole("img", { name: "Checkout design preview" });
    expect(getArtifactThumbnail).toHaveBeenCalledWith("project-1", "artifact-1", "revision-1", expect.any(AbortSignal));

    fireEvent.load(firstImage);
    expect(container.querySelector(".dezin-flow-card__preview")).toHaveAttribute("data-state", "ready");
    expect(screen.queryByText("Rendering preview…")).toBeNull();

    rerender(
      <ArtifactNodePreview
        artifactKind="page"
        projectId="project-1"
        artifactId="artifact-1"
        name="Checkout"
        revisionId="revision-2"
      />,
    );
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:thumbnail-1");
    const secondImage = await screen.findByRole("img", { name: "Checkout design preview" });
    expect(secondImage).not.toBe(firstImage);
    fireEvent.error(secondImage);
    expect(container.querySelector(".dezin-flow-card__preview")).toHaveAttribute("data-state", "error");
    expect(screen.getByText("Preview unavailable")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Retry Checkout preview" }));
    expect(container.querySelector(".dezin-flow-card__preview")).toHaveAttribute("data-state", "loading");
    await waitFor(() => expect(getArtifactThumbnail).toHaveBeenCalledTimes(3));
    expect(await screen.findByRole("img", { name: "Checkout design preview" })).not.toBe(secondImage);
  });

  test("deduplicates a revision request across semantic zoom changes and revokes mount-owned object URLs", async () => {
    let resolveThumbnail!: (blob: Blob) => void;
    getArtifactThumbnail.mockReturnValue(new Promise<Blob>((resolve) => {
      resolveThumbnail = resolve;
    }));
    const rendered = render(
      <ArtifactNodePreview
        artifactKind="page"
        projectId="project-cache"
        artifactId="artifact-cache"
        name="Cached checkout"
        revisionId="revision-cache"
      />,
    );
    expect(getArtifactThumbnail).toHaveBeenCalledTimes(1);

    rendered.rerender(
      <ArtifactNodePreview
        artifactKind="page"
        projectId="project-cache"
        artifactId="artifact-cache"
        name="Cached checkout"
        revisionId="revision-cache"
        zoomLevel="overview"
      />,
    );
    expect(rendered.container.querySelector(".dezin-flow-card__preview")).toHaveAttribute("data-state", "overview");
    expect(rendered.container.querySelector(".dezin-flow-card__placeholder")).toBeNull();
    expect(screen.queryByRole("img", { name: "Cached checkout design preview" })).toBeNull();

    rendered.rerender(
      <ArtifactNodePreview
        artifactKind="page"
        projectId="project-cache"
        artifactId="artifact-cache"
        name="Cached checkout"
        revisionId="revision-cache"
        zoomLevel="full"
      />,
    );
    expect(getArtifactThumbnail).toHaveBeenCalledTimes(1);

    resolveThumbnail(new Blob(["cached-preview"], { type: "image/png" }));
    const firstImage = await screen.findByRole("img", { name: "Cached checkout design preview" });
    fireEvent.load(firstImage);

    rendered.rerender(
      <ArtifactNodePreview
        artifactKind="page"
        projectId="project-cache"
        artifactId="artifact-cache"
        name="Cached checkout"
        revisionId="revision-cache"
        zoomLevel="overview"
      />,
    );
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:thumbnail-1");

    rendered.rerender(
      <ArtifactNodePreview
        artifactKind="page"
        projectId="project-cache"
        artifactId="artifact-cache"
        name="Cached checkout"
        revisionId="revision-cache"
        zoomLevel="full"
      />,
    );
    const secondImage = await screen.findByRole("img", { name: "Cached checkout design preview" });
    expect(secondImage).toHaveAttribute("src", "blob:thumbnail-2");
    expect(getArtifactThumbnail).toHaveBeenCalledTimes(1);
    rendered.unmount();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:thumbnail-2");
  });

  test("shares one revision request while keeping object URLs local to each mounted preview", async () => {
    const rendered = render(
      <>
        <ArtifactNodePreview
          artifactKind="page"
          projectId="project-shared"
          artifactId="artifact-shared"
          name="Desktop checkout"
          revisionId="revision-shared"
        />
        <ArtifactNodePreview
          artifactKind="page"
          projectId="project-shared"
          artifactId="artifact-shared"
          name="Mobile checkout"
          revisionId="revision-shared"
        />
      </>,
    );

    const images = await screen.findAllByRole("img");
    expect(images).toHaveLength(2);
    expect(getArtifactThumbnail).toHaveBeenCalledTimes(1);
    expect(images[0]).toHaveAttribute("src", "blob:thumbnail-1");
    expect(images[1]).toHaveAttribute("src", "blob:thumbnail-2");

    rendered.unmount();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:thumbnail-1");
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:thumbnail-2");
  });

  test("keeps a shared pending thumbnail alive until its final preview unmounts", async () => {
    const signals: AbortSignal[] = [];
    getArtifactThumbnail.mockImplementation((
      _projectId: string,
      _artifactId: string,
      _revisionId: string,
      signal: AbortSignal,
    ) => {
      signals.push(signal);
      return new Promise<Blob>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    });
    const rendered = render(
      <>
        <ArtifactNodePreview
          artifactKind="page"
          projectId="project-pending-shared"
          artifactId="artifact-pending-shared"
          name="Desktop pending"
          revisionId="revision-pending-shared"
        />
        <ArtifactNodePreview
          artifactKind="page"
          projectId="project-pending-shared"
          artifactId="artifact-pending-shared"
          name="Mobile pending"
          revisionId="revision-pending-shared"
        />
      </>,
    );

    expect(getArtifactThumbnail).toHaveBeenCalledTimes(1);
    expect(signals[0]).not.toBeUndefined();
    rendered.rerender(
      <ArtifactNodePreview
        artifactKind="page"
        projectId="project-pending-shared"
        artifactId="artifact-pending-shared"
        name="Desktop pending"
        revisionId="revision-pending-shared"
      />,
    );
    expect(signals[0]!.aborted).toBe(false);

    rendered.unmount();
    await waitFor(() => expect(signals[0]!.aborted).toBe(true));
  });

  test("aborts and evicts pending thumbnail work when previews leave the canvas", async () => {
    const signals: AbortSignal[] = [];
    getArtifactThumbnail.mockImplementation((
      _projectId: string,
      _artifactId: string,
      _revisionId: string,
      signal: AbortSignal,
    ) => {
      signals.push(signal);
      return new Promise<Blob>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    });

    for (let index = 0; index < 110; index += 1) {
      const rendered = render(
        <ArtifactNodePreview
          artifactKind="component"
          projectId="project-pending-eviction"
          artifactId={`artifact-${index}`}
          name={`Pending ${index}`}
          revisionId={`revision-${index}`}
        />,
      );
      rendered.unmount();
    }

    expect(getArtifactThumbnail).toHaveBeenCalledTimes(110);
    expect(signals).toHaveLength(110);
    await waitFor(() => expect(signals.every((signal) => signal.aborted)).toBe(true));
  });

  test("shows an authenticated fetch failure as a retryable preview error", async () => {
    getArtifactThumbnail.mockRejectedValueOnce(new Error("thumbnail unavailable"));
    const { container } = render(
      <ArtifactNodePreview
        artifactKind="page"
        projectId="project-failure"
        artifactId="artifact-failure"
        name="Checkout"
        revisionId="revision-failure"
      />,
    );

    expect(await screen.findByText("Preview unavailable")).toBeInTheDocument();
    expect(container.querySelector(".dezin-flow-card__preview")).toHaveAttribute("data-state", "error");
    expect(screen.getByRole("button", { name: "Retry Checkout preview" })).toBeInTheDocument();
  });

  test("overview mode renders only the compact kind rail and does not request hidden previews", () => {
    const { container } = render(
      <ArtifactNodePreview
        artifactKind="component"
        projectId="project-1"
        artifactId="artifact-1"
        name="Order summary"
        revisionId="revision-1"
        zoomLevel="overview"
      />,
    );

    expect(getArtifactThumbnail).not.toHaveBeenCalled();
    expect(container.querySelector(".dezin-flow-card__preview")).toHaveAttribute("data-state", "overview");
    expect(container.querySelector(".dezin-flow-card__placeholder")).toBeNull();
    expect(screen.getByText("Component")).toBeInTheDocument();
    expect(container.querySelector(".dezin-flow-card__preview-spinner")).toBeNull();
  });

  test("keeps full previews unobstructed while preserving a semantic kind label", () => {
    const { container } = render(
      <ArtifactNodePreview
        artifactKind="page"
        projectId="project-1"
        artifactId="artifact-1"
        name="Checkout"
        revisionId={null}
        zoomLevel="full"
      />,
    );

    expect(container.querySelector(".dezin-flow-card__preview")).toHaveAttribute(
      "aria-label",
      "Page preview for Checkout",
    );
    expect(container.querySelector(".dezin-flow-card__preview")).toHaveAttribute("data-artifact-kind", "page");
    expect(screen.queryByText("Page")).toBeNull();
  });

  test("compact loading uses a quiet static placeholder instead of an animated spinner", () => {
    getArtifactThumbnail.mockReturnValue(new Promise<Blob>(() => {}));
    const { container } = render(
      <ArtifactNodePreview
        artifactKind="component"
        projectId="project-compact"
        artifactId="artifact-compact"
        name="Order summary"
        revisionId="revision-compact"
        zoomLevel="compact"
      />,
    );

    expect(container.querySelector(".dezin-flow-card__preview")).toHaveAttribute("data-state", "loading");
    expect(container.querySelector(".dezin-flow-card__placeholder")).toHaveAttribute("data-motion", "quiet");
    expect(container.querySelector(".dezin-flow-card__preview-spinner")).toBeNull();
  });
});
