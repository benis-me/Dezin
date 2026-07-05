import { expect, test, vi, afterEach } from "vitest";
import { renderHook, act, cleanup } from "@testing-library/react";
import { useRef } from "react";
import { usePreviewRuntimeErrors } from "./preview-runtime-errors.ts";

afterEach(cleanup);

function harness(previewSrc: string, runActive = false) {
  const iframe = document.createElement("iframe");
  document.body.appendChild(iframe);
  const win = iframe.contentWindow as Window;
  const { result } = renderHook(() => {
    const ref = useRef<HTMLIFrameElement | null>(iframe);
    return usePreviewRuntimeErrors({ iframeRef: ref, previewSrc, runActive, watchdogMs: 100, armed: true });
  });
  return { result, win };
}

function fire(win: Window, data: unknown, origin = "null") {
  window.dispatchEvent(new MessageEvent("message", { data, origin, source: win as MessageEventSource }));
}

test("surfaces a fatal error from a validated message", () => {
  const { result, win } = harness("/projects/p/preview/");
  act(() => fire(win, { source: "dezin", type: "runtime-error", kind: "fatal", errorType: "error", message: "died", count: 1, at: 1 }));
  expect(result.current.fatal?.message).toBe("died");
});

test("ignores messages from a foreign origin", () => {
  const { result, win } = harness("/projects/p/preview/");
  act(() => fire(win, { source: "dezin", type: "runtime-error", kind: "fatal", errorType: "error", message: "x", count: 1, at: 1 }, "https://evil.example"));
  expect(result.current.fatal).toBeNull();
});

test("watchdog raises a blank fatal when no heartbeat arrives", () => {
  vi.useFakeTimers();
  const { result } = harness("/projects/p/preview/");
  act(() => vi.advanceTimersByTime(150));
  expect(result.current.fatal?.errorType).toBe("error");
  expect(result.current.fatal?.message).toMatch(/did not render/i);
  vi.useRealTimers();
});

test("a heartbeat cancels the watchdog", () => {
  vi.useFakeTimers();
  const { result, win } = harness("/projects/p/preview/");
  act(() => fire(win, { source: "dezin", type: "preview-heartbeat", phase: "first-paint", at: 1 }));
  act(() => vi.advanceTimersByTime(150));
  expect(result.current.fatal).toBeNull();
  vi.useRealTimers();
});
