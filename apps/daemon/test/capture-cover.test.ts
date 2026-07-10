import { test } from "node:test";
import assert from "node:assert/strict";
import * as coverCapture from "../src/capture-cover.ts";

const { COVER_CAPTURE_SETTLE_MS } = coverCapture;
const captureViaElectron = (coverCapture as typeof coverCapture & {
  captureViaElectron?: (htmlPath: string, outPath: string, signal?: AbortSignal) => Promise<boolean>;
}).captureViaElectron;

test("cover capture waits long enough after network idle for intro animations to settle", () => {
  assert.ok(COVER_CAPTURE_SETTLE_MS >= 2500);
});

test("Electron cover IPC removes abort listeners and sends an exact-id cancel on abort", async () => {
  assert.equal(typeof captureViaElectron, "function", "the Electron IPC boundary must be directly testable");
  if (!captureViaElectron) return;

  const descriptor = Object.getOwnPropertyDescriptor(process, "send");
  const sent: Array<{ type?: string; id?: number }> = [];
  Object.defineProperty(process, "send", {
    configurable: true,
    writable: true,
    value: (message: { type?: string; id?: number }) => {
      sent.push(message);
      return true;
    },
  });

  try {
    const completedController = new AbortController();
    const completed = captureViaElectron("/tmp/completed.html", "/tmp/completed.png", completedController.signal);
    const completedRequest = sent.find((message) => message.type === "capture");
    assert.ok(completedRequest?.id);
    process.emit("message", { type: "capture-result", id: completedRequest.id, ok: true });
    assert.equal(await completed, true);

    completedController.abort();
    await Promise.resolve();
    assert.equal(
      sent.some((message) => message.type === "capture-cancel" && message.id === completedRequest.id),
      false,
      "a settled request must have removed its AbortSignal listener",
    );

    const abortedController = new AbortController();
    const aborted = captureViaElectron("/tmp/aborted.html", "/tmp/aborted.png", abortedController.signal);
    const captureRequests = sent.filter((message) => message.type === "capture");
    const abortedRequest = captureRequests.at(-1);
    assert.ok(abortedRequest?.id && abortedRequest.id !== completedRequest.id);

    abortedController.abort();
    await assert.rejects(aborted, (error: unknown) => error instanceof Error && error.name === "AbortError");
    assert.equal(
      sent.filter((message) => message.type === "capture-cancel" && message.id === abortedRequest.id).length,
      1,
      "abort sends exactly one cancel for the matching desktop capture",
    );

    process.emit("message", { type: "capture-result", id: abortedRequest.id, ok: true });
    await Promise.resolve();
  } finally {
    if (descriptor) Object.defineProperty(process, "send", descriptor);
    else Reflect.deleteProperty(process, "send");
  }
});
