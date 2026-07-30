import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { ApiError } from "../../../lib/api.ts";
import { ArtifactNodePreview } from "./ArtifactNodePreview.tsx";

const getArtifactThumbnail = vi.fn();
const thumbnailApi = { getArtifactThumbnail };
const createObjectURL = vi.fn();
const revokeObjectURL = vi.fn();

vi.mock("../../../lib/api-context.tsx", () => ({
  useApi: () => thumbnailApi,
}));

function installControllableIntersectionObserver() {
  const observers: FakeIntersectionObserver[] = [];

  class FakeIntersectionObserver {
    readonly root: Element | Document | null;
    readonly rootMargin: string;
    readonly thresholds: readonly number[];
    readonly targets = new Set<Element>();

    constructor(
      readonly callback: IntersectionObserverCallback,
      options: IntersectionObserverInit = {},
    ) {
      this.root = options.root ?? null;
      this.rootMargin = options.rootMargin ?? "0px";
      this.thresholds = Array.isArray(options.threshold)
        ? options.threshold
        : [options.threshold ?? 0];
      observers.push(this);
    }

    observe(target: Element) {
      this.targets.add(target);
    }

    unobserve(target: Element) {
      this.targets.delete(target);
    }

    disconnect() {
      this.targets.clear();
    }

    takeRecords(): IntersectionObserverEntry[] {
      return [];
    }

    emit(isIntersecting: boolean) {
      this.callback([...this.targets].map((target) => ({
        isIntersecting,
        intersectionRatio: isIntersecting ? 1 : 0,
        target,
      } as IntersectionObserverEntry)), this as unknown as IntersectionObserver);
    }
  }

  vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
  return observers;
}

describe("artifact node preview", () => {
  beforeEach(() => {
    getArtifactThumbnail.mockReset();
    getArtifactThumbnail.mockResolvedValue(new Blob(["preview"], { type: "image/png" }));
    createObjectURL.mockReset();
    revokeObjectURL.mockReset();
    let sequence = 0;
    createObjectURL.mockImplementation(() => `blob:thumbnail-${++sequence}`);
    vi.stubGlobal("URL", { ...URL, createObjectURL, revokeObjectURL });
    vi.stubGlobal("IntersectionObserver", undefined);
  });

  test("does not request a published thumbnail while its preview is outside the preload margin", () => {
    const observers = installControllableIntersectionObserver();
    render(
      <ArtifactNodePreview
        artifactKind="page"
        projectId="project-lazy-offscreen"
        artifactId="artifact-lazy-offscreen"
        name="Offscreen checkout"
        revisionId="revision-lazy-offscreen"
      />,
    );

    expect(observers).toHaveLength(1);
    expect(observers[0]!.rootMargin).not.toBe("0px");
    expect(getArtifactThumbnail).not.toHaveBeenCalled();
    expect(screen.queryByRole("img", { name: "Offscreen checkout design preview" })).toBeNull();
  });

  test("requests a published thumbnail when its preview enters the preload margin", async () => {
    const observers = installControllableIntersectionObserver();
    render(
      <ArtifactNodePreview
        artifactKind="component"
        projectId="project-lazy-enter"
        artifactId="artifact-lazy-enter"
        name="Nearby summary"
        revisionId="revision-lazy-enter"
      />,
    );
    expect(getArtifactThumbnail).not.toHaveBeenCalled();

    act(() => observers[0]!.emit(true));

    expect(await screen.findByRole("img", { name: "Nearby summary design preview" })).toBeInTheDocument();
    expect(getArtifactThumbnail).toHaveBeenCalledWith(
      "project-lazy-enter",
      "artifact-lazy-enter",
      "revision-lazy-enter",
      expect.any(AbortSignal),
    );
  });

  test("keeps a loaded thumbnail mounted after its preview leaves the preload margin", async () => {
    const observers = installControllableIntersectionObserver();
    const { container } = render(
      <ArtifactNodePreview
        artifactKind="page"
        projectId="project-lazy-retained"
        artifactId="artifact-lazy-retained"
        name="Retained checkout"
        revisionId="revision-lazy-retained"
      />,
    );
    act(() => observers[0]!.emit(true));
    const image = await screen.findByRole("img", { name: "Retained checkout design preview" });
    fireEvent.load(image);
    expect(container.querySelector(".dezin-flow-card__preview")).toHaveAttribute("data-state", "ready");

    act(() => observers[0]!.emit(false));

    expect(screen.getByRole("img", { name: "Retained checkout design preview" })).toBe(image);
    expect(container.querySelector(".dezin-flow-card__preview")).toHaveAttribute("data-state", "ready");
    expect(screen.queryByText("Rendering preview…")).toBeNull();
    expect(revokeObjectURL).not.toHaveBeenCalled();
    expect(getArtifactThumbnail).toHaveBeenCalledTimes(1);
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
    expect(screen.getByText("Not generated")).toBeInTheDocument();
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

  test("bounds automatic retries while a published thumbnail catches up", async () => {
    vi.useFakeTimers();
    getArtifactThumbnail.mockRejectedValue(new ApiError(503, "Thumbnail is not ready"));
    render(
      <ArtifactNodePreview
        artifactKind="page"
        projectId="project-retry"
        artifactId="artifact-retry"
        name="Retry checkout"
        revisionId="revision-retry"
      />,
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(getArtifactThumbnail).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(300);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(getArtifactThumbnail).toHaveBeenCalledTimes(2);

    await act(async () => {
      vi.advanceTimersByTime(1_000);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(getArtifactThumbnail).toHaveBeenCalledTimes(3);
    expect(screen.getByRole("button", { name: "Retry Retry checkout preview" })).toBeInTheDocument();

    await act(async () => {
      vi.advanceTimersByTime(10_000);
      await Promise.resolve();
    });
    expect(getArtifactThumbnail).toHaveBeenCalledTimes(3);
    vi.useRealTimers();
  });

  test("projects a failed or blocked generation task without requesting a fake thumbnail", () => {
    const { container, rerender } = render(
      <ArtifactNodePreview
        artifactKind="page"
        projectId="project-1"
        artifactId="artifact-1"
        name="Checkout"
        revisionId={null}
        generationState="failed"
        generationMessage="CodeBuddy quota is exhausted."
      />,
    );

    expect(screen.getByText("Generation failed")).toBeInTheDocument();
    expect(screen.getByText("CodeBuddy quota is exhausted.")).toBeInTheDocument();
    expect(container.querySelector(".dezin-flow-card__preview")).toHaveAttribute("data-state", "failed");
    expect(getArtifactThumbnail).not.toHaveBeenCalled();

    rerender(
      <ArtifactNodePreview
        artifactKind="page"
        projectId="project-1"
        artifactId="artifact-1"
        name="Checkout"
        revisionId={null}
        generationState="blocked"
        generationMessage="Blocked by failed prerequisite Session Metadata"
      />,
    );
    expect(screen.getByText("Blocked by dependency")).toBeInTheDocument();
    expect(screen.queryByText("Blocked by failed prerequisite Session Metadata")).toBeNull();
    expect(container.querySelector(".dezin-flow-card__placeholder")).toHaveAttribute(
      "title",
      "Blocked by failed prerequisite Session Metadata",
    );
    expect(container.querySelector(".dezin-flow-card__preview")).toHaveAttribute("data-state", "blocked");
    expect(getArtifactThumbnail).not.toHaveBeenCalled();
  });

  test("bounds root failure detail on the canvas while retaining the exact reason as a title", () => {
    const failure = "Artifact generation failed after the provider returned a long diagnostic that belongs in the Plan timeline rather than taking over every canvas card.";
    const { container } = render(
      <ArtifactNodePreview
        artifactKind="page"
        projectId="project-1"
        artifactId="artifact-1"
        name="Checkout"
        revisionId={null}
        generationState="failed"
        generationMessage={failure}
      />,
    );

    const detail = container.querySelector(".dezin-flow-card__placeholder small");
    expect(detail?.textContent?.length).toBeLessThanOrEqual(96);
    expect(detail).not.toHaveTextContent(failure);
    expect(detail).toHaveAttribute("title", failure);
    expect(container.querySelector(".dezin-flow-card__placeholder")).toHaveAttribute("title", failure);
  });

  test("shows a settled sync state without an infinite generation spinner when publication has completed", () => {
    const { container } = render(
      <ArtifactNodePreview
        artifactKind="page"
        projectId="project-1"
        artifactId="artifact-1"
        name="Checkout"
        revisionId={null}
        generationState="complete"
      />,
    );

    expect(screen.getByText("Generated · syncing revision")).toBeInTheDocument();
    expect(container.querySelector(".dezin-flow-card__preview")).toHaveAttribute("data-state", "complete");
    expect(container.querySelector(".dezin-flow-card__preview")).not.toHaveAttribute("aria-busy");
    expect(container.querySelector(".dezin-flow-card__preview-spinner")).toBeNull();
    expect(getArtifactThumbnail).not.toHaveBeenCalled();
  });

  test("deduplicates a revision request and retains its loaded image across semantic zoom changes", async () => {
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
    expect(rendered.container.querySelector(".dezin-flow-card__preview")).toHaveAttribute("data-state", "loading");
    expect(rendered.container.querySelector(".dezin-flow-card__placeholder")).toHaveAttribute("data-motion", "quiet");
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
    expect(screen.getByRole("img", { name: "Cached checkout design preview" })).toBe(firstImage);
    expect(revokeObjectURL).not.toHaveBeenCalled();

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
    expect(secondImage).toBe(firstImage);
    expect(secondImage).toHaveAttribute("src", "blob:thumbnail-1");
    expect(getArtifactThumbnail).toHaveBeenCalledTimes(1);
    rendered.unmount();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:thumbnail-1");
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

  test("times out a stalled thumbnail and aborts it before retrying with a fresh request", async () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    getArtifactThumbnail.mockImplementation((
      _projectId: string,
      _artifactId: string,
      _revisionId: string,
      signal: AbortSignal,
    ) => {
      signals.push(signal);
      return new Promise<Blob>(() => {});
    });
    const { container } = render(
      <ArtifactNodePreview
        artifactKind="page"
        projectId="project-timeout"
        artifactId="artifact-timeout"
        name="Timeout checkout"
        revisionId="revision-timeout"
      />,
    );

    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });

    expect(container.querySelector(".dezin-flow-card__preview")).toHaveAttribute("data-state", "error");
    expect(screen.getByRole("button", { name: "Retry Timeout checkout preview" })).toBeInTheDocument();
    expect(signals[0]?.aborted).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Retry Timeout checkout preview" }));
    await act(async () => { await Promise.resolve(); });

    expect(getArtifactThumbnail).toHaveBeenCalledTimes(2);
    expect(signals[1]).not.toBe(signals[0]);
    expect(signals[1]?.aborted).toBe(false);
    vi.useRealTimers();
  });

  test("overview mode keeps a real thumbnail so zooming out never turns published work into a blank rail", async () => {
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

    expect(getArtifactThumbnail).toHaveBeenCalledWith(
      "project-1",
      "artifact-1",
      "revision-1",
      expect.any(AbortSignal),
    );
    expect(container.querySelector(".dezin-flow-card__preview")).toHaveAttribute("data-state", "loading");
    expect(screen.getByText("Component")).toHaveClass("dezin-flow-card__overview-kind");
    const image = await screen.findByRole("img", { name: "Order summary design preview" });
    fireEvent.load(image);
    expect(container.querySelector(".dezin-flow-card__preview")).toHaveAttribute("data-state", "ready");
  });

  test("semantic zoom changes retain the loaded thumbnail and its object URL", async () => {
    const rendered = render(
      <ArtifactNodePreview
        artifactKind="page"
        projectId="project-retained"
        artifactId="artifact-retained"
        name="Checkout"
        revisionId="revision-retained"
        zoomLevel="full"
      />,
    );
    const image = await screen.findByRole("img", { name: "Checkout design preview" });
    fireEvent.load(image);

    rendered.rerender(
      <ArtifactNodePreview
        artifactKind="page"
        projectId="project-retained"
        artifactId="artifact-retained"
        name="Checkout"
        revisionId="revision-retained"
        zoomLevel="overview"
      />,
    );

    expect(screen.getByRole("img", { name: "Checkout design preview" })).toBe(image);
    expect(getArtifactThumbnail).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).not.toHaveBeenCalled();
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
