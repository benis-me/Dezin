import { act, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import type { DesignCanvasApi } from "./api.ts";
import { DesignCanvasNode, type DesignFlowNode } from "./DesignCanvasNode.tsx";
import type { NodeFocusMotion } from "./node-focus-motion.ts";
import type { DesignNode } from "./types.ts";

vi.mock("@xyflow/react", async () => {
  const actual = await vi.importActual<typeof import("@xyflow/react")>("@xyflow/react");
  const React = await import("react");
  return {
    ...actual,
    Handle: () => React.createElement("div"),
    NodeResizeControl: ({ children }: { children?: React.ReactNode }) => React.createElement("div", null, children),
    useViewport: () => ({ x: 0, y: 0, zoom: 1 }),
  };
});

const mediaListeners = new Set<(event: MediaQueryListEvent) => void>();
let reducedMotion = false;
let animateMock: ReturnType<typeof vi.fn>;
let runningAnimation: Animation & { cancel: ReturnType<typeof vi.fn> };
const originalAnimate = HTMLElement.prototype.animate;

const mediaQueryList = {
  get matches() {
    return reducedMotion;
  },
  media: "(prefers-reduced-motion: reduce)",
  onchange: null,
  addEventListener: (type: string, listener: EventListenerOrEventListenerObject) => {
    if (type === "change") mediaListeners.add(listener as (event: MediaQueryListEvent) => void);
  },
  removeEventListener: (type: string, listener: EventListenerOrEventListenerObject) => {
    if (type === "change") mediaListeners.delete(listener as (event: MediaQueryListEvent) => void);
  },
  addListener: vi.fn(),
  removeListener: vi.fn(),
  dispatchEvent: () => true,
} as unknown as MediaQueryList;

function setReducedMotion(next: boolean): void {
  reducedMotion = next;
  const event = { matches: next, media: mediaQueryList.media } as MediaQueryListEvent;
  for (const listener of mediaListeners) listener(event);
}

function node(): DesignNode {
  return {
    id: "page-1",
    kind: "page",
    name: "Page",
    geometry: { x: 40, y: 60, width: 480, height: 360 },
    state: "empty",
    currentVersionId: null,
    selectedVersionId: null,
    versionCount: 0,
    assetId: null,
    activeJobId: null,
    error: null,
    createdAt: 1,
    updatedAt: 1,
  };
}

function focusMotion(): NodeFocusMotion {
  return {
    phase: "opening",
    role: "source",
    startX: 0,
    startY: 0,
    shiftX: 220,
    shiftY: 120,
    arcX: 34,
    arcY: -28,
    startScaleX: 1,
    startScaleY: 1,
    scaleX: 1.6,
    scaleY: 1.45,
    scale: 1.45,
    startWidth: 480,
    startHeight: 360,
    layoutWidth: 760,
    layoutHeight: 520,
    durationMs: 460,
    delayMs: 0,
    fadeDurationMs: 330,
  };
}

function renderFocusedNode(callbacks: {
  onStart: ReturnType<typeof vi.fn>;
  onComplete: ReturnType<typeof vi.fn>;
}) {
  const item = node();
  const flowNode = {
    id: item.id,
    type: "design",
    position: { x: item.geometry.x, y: item.geometry.y },
    data: {
      node: item,
      projectId: "project-1",
      api: {} as DesignCanvasApi,
      onResize: vi.fn(),
      onFocusAnimationStart: callbacks.onStart,
      onFocusAnimationComplete: callbacks.onComplete,
      focusMotion: focusMotion(),
    },
  } as DesignFlowNode;
  const props = { id: item.id, data: flowNode.data, selected: true } as unknown as Parameters<typeof DesignCanvasNode>[0];
  return render(<DesignCanvasNode {...props} />);
}

beforeEach(() => {
  reducedMotion = false;
  mediaListeners.clear();
  vi.stubGlobal("matchMedia", vi.fn(() => mediaQueryList));
  runningAnimation = {
    cancel: vi.fn(),
    finished: new Promise<Animation>(() => undefined),
  } as unknown as Animation & { cancel: ReturnType<typeof vi.fn> };
  animateMock = vi.fn(() => runningAnimation);
  Object.defineProperty(HTMLElement.prototype, "animate", {
    configurable: true,
    value: animateMock,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (originalAnimate) {
    Object.defineProperty(HTMLElement.prototype, "animate", {
      configurable: true,
      value: originalAnimate,
    });
  } else {
    delete (HTMLElement.prototype as Partial<HTMLElement>).animate;
  }
});

test("reduced motion settles focused Node state without starting spatial WAAPI", async () => {
  setReducedMotion(true);
  const onStart = vi.fn();
  const onComplete = vi.fn();
  renderFocusedNode({ onStart, onComplete });

  expect(animateMock).not.toHaveBeenCalled();
  expect(onStart).toHaveBeenCalledWith("page-1", "opening", 0);
  await waitFor(() => expect(onComplete).toHaveBeenCalledWith("page-1", "opening"));
});

test("switching reduced motion on cancels a running Node flight and settles it without restarting", async () => {
  const onStart = vi.fn();
  const onComplete = vi.fn();
  renderFocusedNode({ onStart, onComplete });
  expect(animateMock).toHaveBeenCalledTimes(1);

  act(() => setReducedMotion(true));

  expect(runningAnimation.cancel).toHaveBeenCalledTimes(1);
  expect(animateMock).toHaveBeenCalledTimes(1);
  expect(onStart).toHaveBeenLastCalledWith("page-1", "opening", 0);
  await waitFor(() => expect(onComplete).toHaveBeenCalledWith("page-1", "opening"));
});
