import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";

import { AgentCollapsible } from "./AgentCollapsible.tsx";

afterEach(() => {
  vi.unstubAllGlobals();
});

function rect(height: number, top = 0): DOMRect {
  return {
    bottom: top + height,
    height,
    left: 0,
    right: 100,
    top,
    width: 100,
    x: 0,
    y: top,
    toJSON: () => ({}),
  };
}

test("AgentCollapsible keeps an exiting body aria-hidden and inert until flow motion settles", () => {
  const { container, rerender } = render(
    <>
      <AgentCollapsible className="subject" open>
        <button type="button">History action</button>
      </AgentCollapsible>
      <button type="button">Following action</button>
    </>,
  );
  const shell = container.querySelector(".subject");
  expect(shell).toHaveAttribute("aria-hidden", "false");
  expect(shell).not.toHaveAttribute("inert");

  rerender(
    <>
      <AgentCollapsible className="subject" open={false}>
        <button type="button">History action</button>
      </AgentCollapsible>
      <button type="button">Following action</button>
    </>,
  );
  expect(shell).toHaveAttribute("aria-hidden", "true");
  expect(shell).toHaveAttribute("inert");
  expect(screen.queryByRole("button", { name: "History action" })).not.toBeInTheDocument();
  const exiting = container.querySelector("[data-agent-collapsible-content]");
  expect(exiting).toBeInTheDocument();
  fireEvent.transitionEnd(shell!, { propertyName: "block-size" });
  expect(container.querySelector("[data-agent-collapsible-content]")).not.toBeInTheDocument();
});

test("AgentCollapsible reverses a closing transition without remounting its body", () => {
  const { container, rerender } = render(
    <AgentCollapsible className="subject" open>
      <span>Details</span>
    </AgentCollapsible>,
  );
  const body = container.querySelector("[data-agent-collapsible-content]");

  rerender(
    <AgentCollapsible className="subject" open={false}>
      <span>Details</span>
    </AgentCollapsible>,
  );
  rerender(
    <AgentCollapsible className="subject" open>
      <span>Details</span>
    </AgentCollapsible>,
  );

  expect(container.querySelector("[data-agent-collapsible-content]")).toBe(body);
  expect(screen.getByText("Details")).toBeInTheDocument();
  fireEvent.transitionEnd(body!);
  expect(container.querySelector("[data-agent-collapsible-content]")).toBe(body);
});

test("AgentCollapsible holds the measured flow size through the disclosure commit before moving the following message", () => {
  const frames: FrameRequestCallback[] = [];
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.push(callback);
    return frames.length;
  });
  vi.stubGlobal("cancelAnimationFrame", vi.fn());

  const { container, rerender } = render(
    <>
      <AgentCollapsible className="subject" open>
        <div>Three lines of detail</div>
      </AgentCollapsible>
      <div data-following-message>Next message</div>
    </>,
  );
  const shell = container.querySelector<HTMLElement>(".subject")!;
  const body = container.querySelector<HTMLElement>("[data-agent-collapsible-content]")!;
  const following = container.querySelector<HTMLElement>("[data-following-message]")!;
  vi.spyOn(shell, "getBoundingClientRect").mockImplementation(() => rect(
    shell.style.blockSize ? Number.parseFloat(shell.style.blockSize) : 84,
  ));
  vi.spyOn(body, "getBoundingClientRect").mockReturnValue(rect(84));
  vi.spyOn(following, "getBoundingClientRect").mockImplementation(() => rect(
    20,
    24 + (shell.style.blockSize ? Number.parseFloat(shell.style.blockSize) : 84),
  ));

  const topBefore = following.getBoundingClientRect().top;
  rerender(
    <>
      <AgentCollapsible className="subject" open={false}>
        <div>Three lines of detail</div>
      </AgentCollapsible>
      <div data-following-message>Next message</div>
    </>,
  );

  expect(shell.style.blockSize).toBe("84px");
  expect(following.getBoundingClientRect().top - topBefore).toBe(0);
  expect(frames).toHaveLength(1);

  act(() => frames.shift()?.(16));
  expect(shell.style.blockSize).toBe("0px");
  fireEvent.transitionEnd(shell, { propertyName: "block-size" });
  expect(shell.style.blockSize).toBe("0px");
});

test("AgentCollapsible retargets an interrupted close from its current measured frame", () => {
  const frames: FrameRequestCallback[] = [];
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.push(callback);
    return frames.length;
  });
  vi.stubGlobal("cancelAnimationFrame", vi.fn());

  const { container, rerender } = render(
    <AgentCollapsible className="subject" open>
      <span>Details</span>
    </AgentCollapsible>,
  );
  const shell = container.querySelector<HTMLElement>(".subject")!;
  const body = container.querySelector<HTMLElement>("[data-agent-collapsible-content]")!;
  let renderedHeight = 72;
  vi.spyOn(shell, "getBoundingClientRect").mockImplementation(() => rect(renderedHeight));
  vi.spyOn(body, "getBoundingClientRect").mockReturnValue(rect(96));

  rerender(
    <AgentCollapsible className="subject" open={false}>
      <span>Details</span>
    </AgentCollapsible>,
  );
  act(() => frames.shift()?.(16));
  expect(shell.style.blockSize).toBe("0px");

  renderedHeight = 31;
  rerender(
    <AgentCollapsible className="subject" open>
      <span>Details</span>
    </AgentCollapsible>,
  );
  expect(shell.style.blockSize).toBe("31px");
  act(() => frames.shift()?.(32));
  expect(shell.style.blockSize).toBe("96px");
  fireEvent.transitionEnd(shell, { propertyName: "block-size" });
  expect(shell.style.blockSize).toBe("");
});

test("AgentCollapsible uses the direct layout endpoint for reduced motion", () => {
  const requestFrame = vi.fn();
  vi.stubGlobal("requestAnimationFrame", requestFrame);
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: true }));

  const { container, rerender } = render(
    <AgentCollapsible className="subject" open>
      <span>Details</span>
    </AgentCollapsible>,
  );
  const shell = container.querySelector<HTMLElement>(".subject")!;

  rerender(
    <AgentCollapsible className="subject" open={false}>
      <span>Details</span>
    </AgentCollapsible>,
  );

  expect(shell.style.blockSize).toBe("0px");
  expect(requestFrame).not.toHaveBeenCalled();
  expect(container.querySelector("[data-agent-collapsible-content]")).not.toBeInTheDocument();
});

test("AgentCollapsible restarts its fallback settle clock when live content retargets the flow size", () => {
  vi.useFakeTimers();
  const frames: FrameRequestCallback[] = [];
  let resizeCallback: ResizeObserverCallback | null = null;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.push(callback);
    return frames.length;
  });
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  vi.stubGlobal("ResizeObserver", class {
    constructor(callback: ResizeObserverCallback) {
      resizeCallback = callback;
    }
    observe() {}
    disconnect() {}
    unobserve() {}
  });

  const { container, rerender } = render(
    <AgentCollapsible className="subject" open={false}>
      <div>Live details</div>
    </AgentCollapsible>,
  );
  const shell = container.querySelector<HTMLElement>(".subject")!;

  rerender(
    <AgentCollapsible className="subject" open>
      <div>Live details</div>
    </AgentCollapsible>,
  );
  const body = container.querySelector<HTMLElement>("[data-agent-collapsible-content]")!;
  let contentHeight = 64;
  vi.spyOn(body, "getBoundingClientRect").mockImplementation(() => rect(contentHeight));
  Object.defineProperty(body, "scrollHeight", { configurable: true, get: () => contentHeight });

  act(() => frames.shift()?.(16));
  expect(shell.style.blockSize).toBe("64px");

  act(() => vi.advanceTimersByTime(180));
  contentHeight = 112;
  act(() => resizeCallback?.([], {} as ResizeObserver));
  expect(shell.style.blockSize).toBe("112px");

  act(() => vi.advanceTimersByTime(100));
  expect(shell).toHaveAttribute("data-agent-collapsible-moving");
  expect(shell.style.blockSize).toBe("112px");

  act(() => vi.advanceTimersByTime(160));
  expect(shell).not.toHaveAttribute("data-agent-collapsible-moving");
  expect(shell.style.blockSize).toBe("");
  vi.useRealTimers();
});
