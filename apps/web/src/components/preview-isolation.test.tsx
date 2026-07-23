import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { PreviewModal } from "./PreviewModal.tsx";
import { bindFrameScroll, VersionCompare } from "./VersionCompare.tsx";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

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

test("VersionCompare renders and acknowledges the exact declared Frame instead of inheriting the dialog viewport", async () => {
  class ImmediateResizeObserver {
    readonly callback: ResizeObserverCallback;

    constructor(callback: ResizeObserverCallback) {
      this.callback = callback;
    }

    observe(target: Element) {
      this.callback([{
        target,
        contentRect: {
          x: 0,
          y: 0,
          top: 0,
          left: 0,
          right: 640,
          bottom: 400,
          width: 640,
          height: 400,
          toJSON: () => ({}),
        },
      } as ResizeObserverEntry], this as unknown as ResizeObserver);
    }

    unobserve() {}
    disconnect() {}
  }
  vi.stubGlobal("ResizeObserver", ImmediateResizeObserver);

  const comparedNonce = "abcdefghijklmnopqrstuvwxyzABCDEFGH123456789";
  const currentNonce = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefgh123456789";
  const comparedFrame = {
    id: "checkout-desktop",
    name: "Checkout desktop",
    width: 1280,
    height: 800,
    initialState: "checkout-ready",
    fixture: { cart: [{ sku: "sku-1", quantity: 2 }] },
    background: "#f4f1eb",
  };
  const currentFrame = {
    ...comparedFrame,
    fixture: { cart: [{ sku: "sku-1", quantity: 3 }] },
  };
  render(
    <VersionCompare
      open
      onClose={vi.fn()}
      a={{
        status: "ready",
        url: `/old#dezin-bridge=${comparedNonce}`,
        bridgeNonce: comparedNonce,
        label: "Before",
        frame: comparedFrame,
      }}
      b={{
        status: "ready",
        url: `/current#dezin-bridge=${currentNonce}`,
        bridgeNonce: currentNonce,
        label: "After",
        frame: currentFrame,
      }}
    />,
  );

  const beforeViewport = screen.getByTestId("version-compare-frame-Before");
  const afterViewport = screen.getByTestId("version-compare-frame-After");
  await waitFor(() => {
    for (const viewport of [beforeViewport, afterViewport]) {
      expect(viewport).toHaveStyle({
        width: "1280px",
        height: "800px",
        transform: "scale(0.5)",
        visibility: "hidden",
      });
    }
  });

  const connect = async (label: string, nonce: string) => {
    const iframe = screen.getByTitle(label) as HTMLIFrameElement;
    const postMessage = vi.spyOn(iframe.contentWindow!, "postMessage");
    fireEvent.load(iframe);
    const calls = postMessage.mock.calls as unknown as Array<[unknown, unknown, Transferable[]?]>;
    const bootstrap = calls.find(([message]) => (message as { type?: string }).type === "bridge-init");
    const port = bootstrap?.[2]?.[0] as MessagePort | undefined;
    postMessage.mockRestore();
    if (!port) throw new Error("Version compare did not transfer its capability port.");
    const received: Array<Record<string, unknown>> = [];
    port.onmessage = (event) => received.push(event.data as Record<string, unknown>);
    port.start();
    port.postMessage({ source: "dezin", type: "bridge-ready", nonce, protocol: 1 });
    await waitFor(() => expect(received.some((message) => message.type === "set-frame")).toBe(true));
    return { port, received };
  };
  const compared = await connect("Before", comparedNonce);
  const current = await connect("After", currentNonce);
  const comparedCommand = compared.received.find((message) => message.type === "set-frame")!;
  const currentCommand = current.received.find((message) => message.type === "set-frame")!;
  expect(comparedCommand).toEqual(expect.objectContaining({
    type: "set-frame",
    frameId: "checkout-desktop",
    initialState: "checkout-ready",
    fixture: comparedFrame.fixture,
    background: "#f4f1eb",
    frameAttemptId: expect.any(String),
  }));
  expect(currentCommand).toEqual(expect.objectContaining({
    type: "set-frame",
    frameId: "checkout-desktop",
    initialState: "checkout-ready",
    fixture: currentFrame.fixture,
    background: "#f4f1eb",
    frameAttemptId: expect.any(String),
  }));

  compared.port.postMessage({
    source: "dezin",
    type: "frame-applied",
    frameId: "checkout-desktop",
    frameAttemptId: comparedCommand.frameAttemptId,
    nonce: comparedNonce,
    protocol: 1,
  });
  current.port.postMessage({
    source: "dezin",
    type: "frame-applied",
    frameId: "checkout-desktop",
    frameAttemptId: currentCommand.frameAttemptId,
    nonce: currentNonce,
    protocol: 1,
  });

  await waitFor(() => {
    expect(beforeViewport).toHaveAttribute("data-frame-status", "applied");
    expect(afterViewport).toHaveAttribute("data-frame-status", "applied");
  });
  expect(beforeViewport).toHaveStyle({ visibility: "visible" });
  expect(afterViewport).toHaveStyle({ visibility: "visible" });
  compared.port.close();
  current.port.close();
});

test("VersionCompare slider binds its divider and clip to the rendered exact Frame bounds", async () => {
  class WideStageResizeObserver {
    readonly callback: ResizeObserverCallback;

    constructor(callback: ResizeObserverCallback) {
      this.callback = callback;
    }

    observe(target: Element) {
      this.callback([{
        target,
        contentRect: {
          x: 0,
          y: 0,
          top: 0,
          left: 0,
          right: 1_000,
          bottom: 422,
          width: 1_000,
          height: 422,
          toJSON: () => ({}),
        },
      } as ResizeObserverEntry], this as unknown as ResizeObserver);
    }

    unobserve() {}
    disconnect() {}
  }
  vi.stubGlobal("ResizeObserver", WideStageResizeObserver);
  const mobileFrame = { id: "mobile", name: "Mobile", width: 390, height: 844 };

  render(
    <VersionCompare
      open
      onClose={vi.fn()}
      a={{ status: "ready", url: "/old", label: "Before", frame: mobileFrame }}
      b={{ status: "ready", url: "/current", label: "After", frame: mobileFrame }}
    />,
  );

  const frameBounds = await screen.findByTestId("compare-slider-frame-bounds");
  const beforeViewport = screen.getByTestId("version-compare-frame-Before");
  const divider = screen.getByRole("slider", { name: "Drag to compare" });
  await waitFor(() => {
    expect(frameBounds).toHaveStyle({ width: "195px", height: "422px" });
    expect(beforeViewport).toHaveStyle({
      transform: "scale(0.5)",
      clipPath: "inset(0 50% 0 0)",
    });
  });
  expect(divider.parentElement).toBe(frameBounds);

  vi.spyOn(frameBounds, "getBoundingClientRect").mockReturnValue({
    x: 402.5,
    y: 0,
    top: 0,
    left: 402.5,
    right: 597.5,
    bottom: 422,
    width: 195,
    height: 422,
    toJSON: () => ({}),
  });
  fireEvent.pointerDown(divider, { pointerId: 17, clientX: 500 });
  const pointerMove = new MouseEvent("pointermove", { bubbles: true, clientX: 451.25 });
  Object.defineProperty(pointerMove, "pointerId", { value: 17 });
  fireEvent(window, pointerMove);

  expect(divider).toHaveAttribute("aria-valuenow", "25");
  expect(divider).toHaveStyle({ left: "25%" });
  expect(beforeViewport).toHaveStyle({ clipPath: "inset(0 75% 0 0)" });

  const pointerUp = new MouseEvent("pointerup", { bubbles: true, clientX: 451.25 });
  Object.defineProperty(pointerUp, "pointerId", { value: 17 });
  fireEvent(window, pointerUp);
});

test("VersionCompare reports effective split mode when exact Frame sizes cannot be overlaid", () => {
  render(
    <VersionCompare
      open
      onClose={vi.fn()}
      a={{
        status: "ready",
        url: "/old",
        label: "Before",
        frame: { id: "desktop-old", name: "Desktop old", width: 1280, height: 800 },
      }}
      b={{
        status: "ready",
        url: "/current",
        label: "After",
        frame: { id: "desktop-new", name: "Desktop new", width: 1440, height: 900 },
      }}
    />,
  );

  expect(screen.queryByRole("button", { name: "Before / after slider" })).toBeNull();
  expect(screen.getByRole("button", { name: "Side by side" })).toHaveAttribute("aria-pressed", "true");
  expect(screen.getByText("Frame sizes differ; shown side by side.")).toBeInTheDocument();
  expect(screen.queryByRole("slider", { name: "Drag to compare" })).toBeNull();
});

test("VersionCompare slider keeps compared on the left and current on the right", () => {
  render(
    <VersionCompare open onClose={vi.fn()} a={{ url: "/old", label: "Main v1" }} b={{ url: "/current", label: "Main current" }} />,
  );

  const frames = screen.getAllByTitle(/Main/) as HTMLIFrameElement[];
  expect(frames.map((frame) => frame.title)).toEqual(["Main current", "Main v1"]);
  expect(frames[0]).toHaveAttribute("src", "/current");
  expect(frames[1]).toHaveAttribute("src", "/old");
  expect(screen.getByRole("slider", { name: "Drag to compare" })).toHaveClass("w-9", "-translate-x-1/2");
  expect(screen.getByTestId("compare-divider-line")).toHaveClass("left-1/2", "-translate-x-1/2");
});

test("VersionCompare exposes an operable keyboard and pointer slider", () => {
  render(
    <VersionCompare open onClose={vi.fn()} a={{ url: "/old", label: "Main v1" }} b={{ url: "/current", label: "Main current" }} />,
  );

  const divider = screen.getByRole("slider", { name: "Drag to compare" });
  expect(divider).toHaveAttribute("aria-valuemin", "1");
  expect(divider).toHaveAttribute("aria-valuemax", "99");
  expect(divider).toHaveAttribute("aria-valuenow", "50");

  fireEvent.keyDown(divider, { key: "ArrowRight" });
  expect(divider).toHaveAttribute("aria-valuenow", "51");
  expect(screen.getByTitle("Main v1")).toHaveStyle({ clipPath: "inset(0 49% 0 0)" });

  const stage = divider.parentElement!;
  vi.spyOn(stage, "getBoundingClientRect").mockReturnValue({
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    right: 200,
    bottom: 100,
    width: 200,
    height: 100,
    toJSON: () => ({}),
  });
  fireEvent.pointerDown(divider, { pointerId: 7, clientX: 102 });
  const pointerMove = new MouseEvent("pointermove", { bubbles: true, clientX: 150 });
  Object.defineProperty(pointerMove, "pointerId", { value: 7 });
  fireEvent(window, pointerMove);
  expect(divider).toHaveAttribute("aria-valuenow", "75");
  const pointerUp = new MouseEvent("pointerup", { bubbles: true, clientX: 150 });
  Object.defineProperty(pointerUp, "pointerId", { value: 7 });
  fireEvent(window, pointerUp);
  expect(divider).toHaveAttribute("aria-valuenow", "75");
});

test("VersionCompare cleans up an active pointer drag when it unmounts", () => {
  const view = render(
    <VersionCompare open onClose={vi.fn()} a={{ url: "/old", label: "Main v1" }} b={{ url: "/current", label: "Main current" }} />,
  );
  const divider = screen.getByRole("slider", { name: "Drag to compare" });
  const compared = screen.getByTitle("Main v1") as HTMLIFrameElement;
  const current = screen.getByTitle("Main current") as HTMLIFrameElement;

  fireEvent.pointerDown(divider, { pointerId: 9, clientX: 100 });
  expect(document.body.style.cursor).toBe("col-resize");
  expect(compared.style.pointerEvents).toBe("none");
  expect(current.style.pointerEvents).toBe("none");

  view.unmount();
  expect(document.body.style.cursor).toBe("");
  expect(compared.style.pointerEvents).toBe("");
  expect(current.style.pointerEvents).toBe("");
});

test("VersionCompare synchronizes iframe scroll bridge messages in both directions", async () => {
  const comparedNonce = "abcdefghijklmnopqrstuvwxyzABCDEFGH123456789";
  const currentNonce = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefgh123456789";
  render(
    <VersionCompare
      open
      onClose={vi.fn()}
      a={{ url: `/old#dezin-bridge=${comparedNonce}`, bridgeNonce: comparedNonce, label: "Main v1" }}
      b={{ url: `/current#dezin-bridge=${currentNonce}`, bridgeNonce: currentNonce, label: "Main current" }}
    />,
  );

  const currentFrame = screen.getByTitle("Main current") as HTMLIFrameElement;
  const comparedFrame = screen.getByTitle("Main v1") as HTMLIFrameElement;
  const connect = (frame: HTMLIFrameElement, nonce: string) => {
    const postMessage = vi.spyOn(frame.contentWindow!, "postMessage");
    fireEvent.load(frame);
    const calls = postMessage.mock.calls as unknown as Array<[unknown, unknown, Transferable[]?]>;
    const bootstrap = calls.find(([message]) => (message as { type?: string }).type === "bridge-init");
    const port = bootstrap?.[2]?.[0] as MessagePort | undefined;
    postMessage.mockRestore();
    if (!port) throw new Error("Version compare did not transfer its capability port.");
    const received: Array<Record<string, unknown>> = [];
    port.onmessage = (event) => received.push(event.data as Record<string, unknown>);
    port.start();
    port.postMessage({ source: "dezin", type: "bridge-ready", nonce, protocol: 1 });
    return { port, received };
  };
  const current = connect(currentFrame, currentNonce);
  const compared = connect(comparedFrame, comparedNonce);

  current.port.postMessage({
    source: "dezin",
    type: "scroll",
    top: 180,
    left: 12,
    nonce: currentNonce,
    protocol: 1,
  });

  await waitFor(() => expect(compared.received).toContainEqual(expect.objectContaining({
    source: "dezin-parent",
    type: "sync-scroll",
    top: 180,
    left: 12,
    nonce: comparedNonce,
    protocol: 1,
  })));
  await new Promise((resolve) => setTimeout(resolve, 0));

  compared.port.postMessage({
    source: "dezin",
    type: "scroll",
    top: 42,
    left: 4,
    nonce: comparedNonce,
    protocol: 1,
  });

  await waitFor(() => expect(current.received).toContainEqual(expect.objectContaining({
    source: "dezin-parent",
    type: "sync-scroll",
    top: 42,
    left: 4,
    nonce: currentNonce,
    protocol: 1,
  })));

  const count = compared.received.length;
  current.port.postMessage({ source: "dezin", type: "scroll", top: 999, left: 0, nonce: comparedNonce, protocol: 1 });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(compared.received).toHaveLength(count);
  current.port.close();
  compared.port.close();
});

test("VersionCompare attributes authenticated runtime errors to the failing pane and offers recovery", async () => {
  const comparedNonce = "abcdefghijklmnopqrstuvwxyzABCDEFGH123456789";
  const currentNonce = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefgh123456789";
  render(
    <VersionCompare
      open
      onClose={vi.fn()}
      a={{ url: `/old#dezin-bridge=${comparedNonce}`, bridgeNonce: comparedNonce, label: "Main v1" }}
      b={{ url: `/current#dezin-bridge=${currentNonce}`, bridgeNonce: currentNonce, label: "Main current" }}
    />,
  );

  const comparedFrame = screen.getByTitle("Main v1") as HTMLIFrameElement;
  const postMessage = vi.spyOn(comparedFrame.contentWindow!, "postMessage");
  fireEvent.load(comparedFrame);
  const calls = postMessage.mock.calls as unknown as Array<[unknown, unknown, Transferable[]?]>;
  const bootstrap = calls.find(([message]) => (message as { type?: string }).type === "bridge-init");
  const port = bootstrap?.[2]?.[0] as MessagePort | undefined;
  postMessage.mockRestore();
  if (!port) throw new Error("Version compare did not transfer its capability port.");
  port.start();
  port.postMessage({ source: "dezin", type: "bridge-ready", nonce: comparedNonce, protocol: 1 });
  port.postMessage({
    source: "dezin",
    type: "runtime-error",
    kind: "fatal",
    errorType: "error",
    message: "Compared render crashed",
    count: 1,
    at: 123,
    nonce: comparedNonce,
    protocol: 1,
  });

  const notice = await screen.findByRole("alert", { name: "Main v1 preview error" });
  expect(notice).toHaveTextContent("Compared render crashed");
  fireEvent.click(screen.getByRole("button", { name: "Reload Main v1 preview" }));
  await waitFor(() => expect(screen.queryByRole("alert", { name: "Main v1 preview error" })).toBeNull());

  port.postMessage({
    source: "dezin",
    type: "runtime-error",
    kind: "fatal",
    errorType: "error",
    message: "Compared render crashed",
    count: 1,
    at: 124,
    nonce: comparedNonce,
    protocol: 1,
  });
  expect(await screen.findByRole("alert", { name: "Main v1 preview error" })).toHaveTextContent("Compared render crashed");
  expect(screen.queryByRole("alert", { name: "Main current preview error" })).toBeNull();
  port.close();
});

test("VersionCompare iframe scroll cleanup tolerates cross-origin WindowProxy errors", () => {
  const sourceWindow = {
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(() => {
      throw new DOMException("Blocked a frame from accessing a cross-origin frame.", "SecurityError");
    }),
  } as unknown as Window;
  const sourceDoc = new EventTarget() as Document;
  Object.defineProperties(sourceDoc, {
    defaultView: { configurable: true, value: sourceWindow },
    scrollingElement: { configurable: true, value: document.createElement("main") },
    documentElement: { configurable: true, value: document.createElement("html") },
    body: { configurable: true, value: document.createElement("body") },
  });

  const cleanupScroll = bindFrameScroll(sourceDoc, null, { current: false });

  expect(sourceWindow.addEventListener).toHaveBeenCalledWith("scroll", expect.any(Function), { passive: true });
  expect(() => cleanupScroll()).not.toThrow();
});
