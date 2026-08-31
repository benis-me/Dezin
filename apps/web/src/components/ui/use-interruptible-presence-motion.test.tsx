import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { useEffect, useState } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "./context-menu.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./dropdown-menu.tsx";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "./tooltip.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./select.tsx";
import { useInterruptiblePresenceMotion } from "./use-interruptible-presence-motion.ts";

const originalAnimate = HTMLElement.prototype.animate;
let presenceClockStyle: HTMLStyleElement;

beforeEach(() => {
  presenceClockStyle = document.createElement("style");
  presenceClockStyle.dataset.testMenuPresenceClock = "";
  presenceClockStyle.textContent = `
    [data-dezin-menu-presence][data-state="open"] {
      animation-name: dezin-menu-presence-open;
      animation-duration: 250ms;
    }
    [data-dezin-menu-presence][data-state="closed"] {
      animation-name: dezin-menu-presence-closed;
      animation-duration: 150ms;
    }
    @keyframes dezin-menu-presence-open {
      from, to { outline-color: transparent; }
    }
    @keyframes dezin-menu-presence-closed {
      from, to { outline-color: transparent; }
    }
  `;
  document.head.append(presenceClockStyle);
});

afterEach(() => {
  cleanup();
  presenceClockStyle.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  if (originalAnimate) {
    Object.defineProperty(HTMLElement.prototype, "animate", {
      configurable: true,
      value: originalAnimate,
    });
  } else {
    Reflect.deleteProperty(HTMLElement.prototype, "animate");
  }
});

function PresenceHarness({
  attached = true,
  side = "bottom",
  skipAnimationOnInstantOpen = false,
  state,
}: {
  attached?: boolean;
  side?: "top" | "right" | "bottom" | "left";
  skipAnimationOnInstantOpen?: boolean;
  state: "open" | "closed" | "instant-open";
}) {
  const ref = useInterruptiblePresenceMotion<HTMLDivElement>(undefined, {
    openDurationMs: 190,
    closeDurationMs: 130,
    distancePx: 5,
    openScale: 0.97,
    skipAnimationOnInstantOpen,
  });
  return attached ? <div ref={ref} data-side={side} data-state={state} /> : null;
}

function PresenceRefCapture({
  capture,
}: {
  capture: (ref: (node: HTMLDivElement | null) => void) => void;
}) {
  const ref = useInterruptiblePresenceMotion<HTMLDivElement>();
  useEffect(() => capture(ref), [capture, ref]);
  return null;
}

function finishMenuPresence(element: HTMLElement): void {
  const event = new Event("animationend", { bubbles: true });
  Object.defineProperty(event, "animationName", {
    configurable: true,
    value: "dezin-menu-presence-closed",
  });
  fireEvent(element, event);
}

test("presence motion reverses from the current frame with a responsive exit curve", async () => {
  const cancel = vi.fn();
  const animate = vi.fn((
    _keyframes: Keyframe[] | PropertyIndexedKeyframes | null,
    _options?: number | KeyframeAnimationOptions,
  ) => ({
    cancel,
    finished: new Promise<Animation>(() => undefined),
  }) as unknown as Animation);
  Object.defineProperty(HTMLElement.prototype, "animate", {
    configurable: true,
    value: animate,
  });

  const { rerender } = render(<PresenceHarness state="open" />);
  await waitFor(() => expect(animate).toHaveBeenCalledTimes(1));
  expect(animate.mock.calls[0]?.[1]).toMatchObject({
    duration: 190,
    easing: "cubic-bezier(0.22, 1, 0.36, 1)",
    fill: "both",
  });

  rerender(<PresenceHarness state="closed" />);
  await waitFor(() => expect(animate).toHaveBeenCalledTimes(2));
  expect(cancel).toHaveBeenCalledOnce();
  expect(animate.mock.calls[1]?.[1]).toMatchObject({
    duration: 130,
    easing: "cubic-bezier(0.22, 1, 0.36, 1)",
    fill: "both",
  });
  expect(animate.mock.calls[1]?.[0]).toEqual(expect.arrayContaining([
    expect.objectContaining({ opacity: 0 }),
  ]));
});

test("presence motion attaches after an initially null Portal ref and remains interruptible", async () => {
  const cancels: Array<ReturnType<typeof vi.fn>> = [];
  const animate = vi.fn((
    _keyframes: Keyframe[] | PropertyIndexedKeyframes | null,
    _options?: number | KeyframeAnimationOptions,
  ) => {
    const cancel = vi.fn();
    cancels.push(cancel);
    return {
      cancel,
      finished: new Promise<Animation>(() => undefined),
    } as unknown as Animation;
  });
  Object.defineProperty(HTMLElement.prototype, "animate", {
    configurable: true,
    value: animate,
  });

  const rendered = render(<PresenceHarness attached={false} state="closed" />);
  expect(animate).not.toHaveBeenCalled();

  rendered.rerender(<PresenceHarness state="open" />);
  await waitFor(() => expect(animate).toHaveBeenCalledTimes(1));
  expect(animate.mock.calls[0]?.[0]).toEqual([
    { opacity: 0, transform: "translate3d(0, -5px, 0) scale(0.97)" },
    { opacity: 1, transform: "translate3d(0, 0, 0) scale(1)" },
  ]);

  rendered.rerender(<PresenceHarness state="closed" />);
  await waitFor(() => expect(animate).toHaveBeenCalledTimes(2));
  expect(cancels[0]).toHaveBeenCalledOnce();

  rendered.rerender(<PresenceHarness state="open" />);
  await waitFor(() => expect(animate).toHaveBeenCalledTimes(3));
  expect(cancels[1]).toHaveBeenCalledOnce();
  expect(animate.mock.calls[2]?.[1]).toMatchObject({ duration: 190 });
});

test("positioning side changes do not restart the current presence animation", async () => {
  const animate = vi.fn(() => ({
    cancel: vi.fn(),
    finished: new Promise<Animation>(() => undefined),
  }) as unknown as Animation);
  Object.defineProperty(HTMLElement.prototype, "animate", {
    configurable: true,
    value: animate,
  });

  const rendered = render(<PresenceHarness side="bottom" state="open" />);
  await waitFor(() => expect(animate).toHaveBeenCalledTimes(1));

  rendered.rerender(<PresenceHarness side="top" state="open" />);
  await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
  expect(animate).toHaveBeenCalledTimes(1);
});

test("same-node callback ref churn preserves the running compositor frame", async () => {
  const cancels: Array<ReturnType<typeof vi.fn>> = [];
  const animate = vi.fn((
    _keyframes: Keyframe[] | PropertyIndexedKeyframes | null,
    _options?: number | KeyframeAnimationOptions,
  ) => {
    const cancel = vi.fn();
    cancels.push(cancel);
    return {
      cancel,
      finished: new Promise<Animation>(() => undefined),
    } as unknown as Animation;
  });
  Object.defineProperty(HTMLElement.prototype, "animate", {
    configurable: true,
    value: animate,
  });

  let presenceRef: ((node: HTMLDivElement | null) => void) | null = null;
  const capture = (ref: (node: HTMLDivElement | null) => void) => {
    presenceRef = ref;
  };
  render(<PresenceRefCapture capture={capture} />);
  await waitFor(() => expect(presenceRef).not.toBeNull());

  const node = document.createElement("div");
  node.dataset.side = "bottom";
  node.dataset.state = "open";
  node.style.opacity = "0.42";
  node.style.transform = "matrix(0.99, 0, 0, 0.99, 0, -2)";
  document.body.append(node);

  act(() => presenceRef!(node));
  await waitFor(() => expect(animate).toHaveBeenCalledOnce());

  // Radix/Popper can replace its composed ref callback during an unrelated
  // Tooltip/provider update, producing null -> the same DOM node in one commit.
  act(() => {
    presenceRef!(null);
    presenceRef!(node);
  });
  await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
  expect(animate).toHaveBeenCalledOnce();
  expect(cancels[0]).not.toHaveBeenCalled();

  // Preserve identity across a microtask boundary as well; this is still ref
  // churn, not a real Portal unmount.
  act(() => presenceRef!(null));
  await Promise.resolve();
  act(() => presenceRef!(node));
  await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
  expect(animate).toHaveBeenCalledOnce();
  expect(cancels[0]).not.toHaveBeenCalled();

  node.dataset.state = "closed";
  await waitFor(() => expect(animate).toHaveBeenCalledTimes(2));
  expect(animate.mock.calls[1]?.[0]).toEqual(expect.arrayContaining([
    expect.objectContaining({
      opacity: 0.42,
      transform: "matrix(0.99, 0, 0, 0.99, 0, -2)",
    }),
  ]));

  act(() => presenceRef!(null));
  await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
  expect(cancels.at(-1)).toHaveBeenCalledOnce();
  node.remove();
});

test("instant-open tooltips skip repeat motion", async () => {
  const animate = vi.fn((
    _keyframes: Keyframe[] | PropertyIndexedKeyframes | null,
    _options?: number | KeyframeAnimationOptions,
  ) => ({
    cancel: vi.fn(),
    finished: Promise.resolve({} as Animation),
  }) as unknown as Animation);
  Object.defineProperty(HTMLElement.prototype, "animate", {
    configurable: true,
    value: animate,
  });

  render(<PresenceHarness state="instant-open" skipAnimationOnInstantOpen />);
  await waitFor(() => expect(animate).toHaveBeenCalledOnce());
  expect(animate.mock.calls[0]?.[0]).toEqual([
    { opacity: 1, transform: "translate3d(0, 0, 0) scale(1)" },
    { opacity: 1, transform: "translate3d(0, 0, 0) scale(1)" },
  ]);
  expect(animate.mock.calls[0]?.[1]).toMatchObject({ duration: 0, fill: "both" });
});

test("presence motion settles immediately when reduced motion changes while attached", async () => {
  const listeners = new Set<EventListenerOrEventListenerObject>();
  const mediaQuery = {
    matches: false,
    media: "(prefers-reduced-motion: reduce)",
    onchange: null,
    addEventListener: vi.fn((_type: string, listener: EventListenerOrEventListenerObject) => {
      listeners.add(listener);
    }),
    removeEventListener: vi.fn((_type: string, listener: EventListenerOrEventListenerObject) => {
      listeners.delete(listener);
    }),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(() => true),
  } as unknown as MediaQueryList;
  vi.stubGlobal("matchMedia", vi.fn(() => mediaQuery));

  const cancels: Array<ReturnType<typeof vi.fn>> = [];
  const animate = vi.fn((
    _keyframes: Keyframe[] | PropertyIndexedKeyframes | null,
    _options?: number | KeyframeAnimationOptions,
  ) => {
    const cancel = vi.fn();
    cancels.push(cancel);
    return {
      cancel,
      finished: new Promise<Animation>(() => undefined),
    } as unknown as Animation;
  });
  Object.defineProperty(HTMLElement.prototype, "animate", {
    configurable: true,
    value: animate,
  });

  const rendered = render(<PresenceHarness state="open" />);
  await waitFor(() => expect(animate).toHaveBeenCalledTimes(1));

  Object.defineProperty(mediaQuery, "matches", { configurable: true, value: true });
  act(() => {
    for (const listener of listeners) {
      if (typeof listener === "function") listener(new Event("change"));
      else listener.handleEvent(new Event("change"));
    }
  });
  expect(cancels[0]).toHaveBeenCalledOnce();
  expect(animate).toHaveBeenCalledTimes(2);
  expect(animate.mock.calls[1]?.[0]).toEqual([
    { opacity: 1, transform: "translate3d(0, 0, 0) scale(1)" },
    { opacity: 1, transform: "translate3d(0, 0, 0) scale(1)" },
  ]);
  expect(animate.mock.calls[1]?.[1]).toMatchObject({ duration: 0, fill: "both" });

  rendered.unmount();
  await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
  expect(mediaQuery.removeEventListener).toHaveBeenCalledWith("change", expect.any(Function));
});

test("global menu presence clocks leave opacity and transform to WAAPI", () => {
  const globalsCss = readFileSync(resolve(process.cwd(), "src/styles/globals.css"), "utf8");
  expect(globalsCss).toContain('animation-name: dezin-menu-presence-open');
  expect(globalsCss).toContain('animation-name: dezin-menu-presence-closed');
  expect(globalsCss).toMatch(/data-dezin-menu-presence[^}]*:not\(\[data-state="closed"\]\)/);
  expect(globalsCss).toMatch(/dezin-menu-presence-open-duration, 250ms/);
  expect(globalsCss).toMatch(/dezin-menu-presence-close-duration, 150ms/);
  expect(globalsCss).toMatch(/data-slot="context-menu-content"[\s\S]*250ms/);
  for (const name of ["dezin-menu-presence-open", "dezin-menu-presence-closed"]) {
    const body = globalsCss.match(new RegExp(`@keyframes ${name} \\{([\\s\\S]*?)\\n\\}`, "m"))?.[1] ?? "";
    expect(body).not.toMatch(/(?:opacity|transform)\s*:/);
  }
});

test("Tooltip uses one visible presence track and retains its compositor exit", async () => {
  const animate = vi.fn((
    _keyframes: Keyframe[] | PropertyIndexedKeyframes | null,
    _options?: number | KeyframeAnimationOptions,
  ) => ({
    cancel: vi.fn(),
    finished: new Promise<Animation>(() => undefined),
  }) as unknown as Animation);
  Object.defineProperty(HTMLElement.prototype, "animate", {
    configurable: true,
    value: animate,
  });

  render(
    <TooltipProvider delayDuration={0}>
      <Tooltip>
        <TooltipTrigger>Arrange</TooltipTrigger>
        <TooltipContent>Arrange nodes</TooltipContent>
      </Tooltip>
    </TooltipProvider>,
  );

  fireEvent.pointerMove(screen.getByText("Arrange"));
  fireEvent.pointerEnter(screen.getByText("Arrange"));
  let content: HTMLElement | null = null;
  await waitFor(() => {
    content = document.querySelector<HTMLElement>('[data-slot="tooltip-content"]');
    expect(content).not.toBeNull();
  });
  const tooltipContent = content!;
  expect(tooltipContent).toHaveAttribute("data-dezin-menu-presence");
  expect(tooltipContent.className).not.toMatch(/(?:^|\s)(?:animate-in|animate-out)(?:\s|$)/);
  expect(tooltipContent.className).not.toMatch(/(?:^|\s)(?:fade-in-0|fade-out-0|zoom-in-|zoom-out-)/);
  await waitFor(() => expect(animate).toHaveBeenCalled());

  fireEvent.pointerLeave(screen.getByText("Arrange"));
  await waitFor(() => expect(tooltipContent).toHaveAttribute("data-state", "closed"));
  expect(document.querySelector('[data-slot="tooltip-content"]')).toBe(tooltipContent);
  finishMenuPresence(tooltipContent);
  await waitFor(() => {
    expect(document.querySelector('[data-slot="tooltip-content"]')).toBeNull();
  });
});

test("a real Radix Select retains its compositor exit before unmount", async () => {
  const user = userEvent.setup();
  const animate = vi.fn((
    _keyframes: Keyframe[] | PropertyIndexedKeyframes | null,
    _options?: number | KeyframeAnimationOptions,
  ) => ({
    cancel: vi.fn(),
    finished: new Promise<Animation>(() => undefined),
  }) as unknown as Animation);
  Object.defineProperty(HTMLElement.prototype, "animate", {
    configurable: true,
    value: animate,
  });

  render(
    <Select defaultValue="one">
      <SelectTrigger aria-label="Version"><SelectValue /></SelectTrigger>
      <SelectContent aria-label="Versions">
        <SelectItem value="one">V1</SelectItem>
        <SelectItem value="two">V2</SelectItem>
      </SelectContent>
    </Select>,
  );

  await user.click(screen.getByRole("combobox", { name: "Version" }));
  const content = await screen.findByRole("listbox", { name: "Versions" });
  expect(content).toHaveAttribute("data-dezin-menu-presence");
  await waitFor(() => expect(animate).toHaveBeenCalled());
  const openCallCount = animate.mock.calls.length;

  await user.keyboard("{Escape}");
  await waitFor(() => {
    expect(content).toHaveAttribute("data-state", "closed");
    expect(animate.mock.calls.slice(openCallCount).some((call) => (
      (call[1] as KeyframeAnimationOptions | undefined)?.duration === 130
    ))).toBe(true);
  });
  expect(document.querySelector('[data-slot="select-content"]')).toBe(content);
  finishMenuPresence(content);
  await waitFor(() => {
    expect(document.querySelector('[data-slot="select-content"]')).toBeNull();
  });
});

test("a real Radix ContextMenu retains close presence and interrupts into reopen", async () => {
  const animate = vi.fn((
    _keyframes: Keyframe[] | PropertyIndexedKeyframes | null,
    _options?: number | KeyframeAnimationOptions,
  ) => ({
    cancel: vi.fn(),
    finished: new Promise<Animation>(() => undefined),
  }) as unknown as Animation);
  Object.defineProperty(HTMLElement.prototype, "animate", {
    configurable: true,
    value: animate,
  });

  function RadixHarness() {
    return (
      <ContextMenu modal={false}>
        <ContextMenuTrigger>Canvas target</ContextMenuTrigger>
        <ContextMenuContent aria-label="Canvas actions">
          <ContextMenuItem>Inspect</ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    );
  }

  render(<RadixHarness />);
  expect(animate).not.toHaveBeenCalled();

  const trigger = screen.getByText("Canvas target");
  fireEvent.contextMenu(trigger, { clientX: 40, clientY: 30 });
  const firstMenu = await screen.findByRole("menu", { name: "Canvas actions" });
  await waitFor(() => expect(animate).toHaveBeenCalled());
  const firstOpenCallCount = animate.mock.calls.length;
  expect(firstMenu).toHaveClass("origin-(--radix-context-menu-content-transform-origin)");
  expect(animate.mock.calls.at(-1)?.[1]).toMatchObject({
    duration: 250,
    easing: "cubic-bezier(0.22, 1, 0.36, 1)",
  });

  fireEvent.keyDown(document, { key: "Escape" });
  let closingMenu: HTMLElement | null = null;
  await waitFor(() => {
    closingMenu = document.querySelector<HTMLElement>('[data-slot="context-menu-content"]');
    expect(closingMenu).toHaveAttribute("data-state", "closed");
    expect(animate.mock.calls.slice(firstOpenCallCount).some((call) => (
      (call[1] as KeyframeAnimationOptions | undefined)?.duration === 150
    ))).toBe(true);
  });

  const closeCallCount = animate.mock.calls.length;
  fireEvent.contextMenu(trigger, { clientX: 42, clientY: 32 });
  expect(await screen.findByRole("menu", { name: "Canvas actions" })).toBe(closingMenu);
  await waitFor(() => expect(animate.mock.calls.length).toBeGreaterThan(closeCallCount));

  fireEvent.keyDown(document, { key: "Escape" });
  await waitFor(() => expect(closingMenu).toHaveAttribute("data-state", "closed"));
  const finalClosingMenu = document.querySelector<HTMLElement>('[data-slot="context-menu-content"]');
  expect(finalClosingMenu).not.toBeNull();
  finishMenuPresence(finalClosingMenu!);
  await waitFor(() => {
    expect(document.querySelector('[data-slot="context-menu-content"]')).toBeNull();
  }, { timeout: 500 });
});

test("a real Radix DropdownMenu retains its compositor exit before unmount", async () => {
  const user = userEvent.setup();
  const animate = vi.fn((
    _keyframes: Keyframe[] | PropertyIndexedKeyframes | null,
    _options?: number | KeyframeAnimationOptions,
  ) => ({
    cancel: vi.fn(),
    finished: new Promise<Animation>(() => undefined),
  }) as unknown as Animation);
  Object.defineProperty(HTMLElement.prototype, "animate", {
    configurable: true,
    value: animate,
  });

  function DropdownHarness() {
    const [open, setOpen] = useState(false);
    return (
      <DropdownMenu modal={false} open={open} onOpenChange={setOpen}>
        <DropdownMenuTrigger>Open catalog</DropdownMenuTrigger>
        <DropdownMenuContent aria-label="Node catalog">
          <DropdownMenuItem>Add page</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }

  render(<DropdownHarness />);
  const trigger = screen.getByRole("button", { name: "Open catalog" });
  await user.pointer([
    { keys: "[MouseLeft>]", target: trigger },
    { keys: "[/MouseLeft]", target: trigger },
  ]);
  await screen.findByRole("menu");
  expect(trigger).toHaveAttribute("aria-expanded", "true");
  await waitFor(() => expect(animate).toHaveBeenCalled());
  const openCallCount = animate.mock.calls.length;

  await user.keyboard("{Escape}");
  let closingMenu: Element | null = null;
  await waitFor(() => {
    closingMenu = document.querySelector('[data-slot="dropdown-menu-content"]');
    expect(closingMenu).toHaveAttribute("data-state", "closed");
    expect(animate.mock.calls.slice(openCallCount).some((call) => (
      (call[1] as KeyframeAnimationOptions | undefined)?.duration === 150
    ))).toBe(true);
  });

  const closeCallCount = animate.mock.calls.length;
  await user.pointer({ keys: "[MouseLeft>]", target: trigger });
  await waitFor(() => expect(trigger).toHaveAttribute("aria-expanded", "true"));
  expect(await screen.findByRole("menu")).toBe(closingMenu);
  await waitFor(() => expect(animate.mock.calls.length).toBeGreaterThan(closeCallCount));

  // A retained Radix DismissableLayer can issue a stale `false` after the
  // Trigger's pointerdown has already reopened the menu. Escape exercises the
  // same Root callback during that still-active native pointer gesture.
  fireEvent.keyDown(document, { key: "Escape" });
  expect(trigger).toHaveAttribute("aria-expanded", "true");
  await user.pointer({ keys: "[/MouseLeft]", target: trigger });
  await act(async () => {
    await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
  });

  await user.keyboard("{Escape}");
  await waitFor(() => expect(closingMenu).toHaveAttribute("data-state", "closed"));
  const finalClosingMenu = document.querySelector<HTMLElement>('[data-slot="dropdown-menu-content"]');
  expect(finalClosingMenu).not.toBeNull();
  finishMenuPresence(finalClosingMenu!);
  await waitFor(() => {
    expect(document.querySelector('[data-slot="dropdown-menu-content"]')).toBeNull();
  }, { timeout: 500 });
});
