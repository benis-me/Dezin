import { expect, test, vi } from "vitest";
import {
  cacheBustedPreviewUrl,
  createPreviewChannelController,
  previewBridgeAddressForSrc,
  previewBridgeNonceForSrc,
  withPreviewBridgeNonce,
} from "./preview-channel.ts";

const NONCE = "abcdefghijklmnopqrstuvwxyzABCDEFGH123456789";

test("preview bridge addresses distinguish invalid, opaque, and exact-origin frames", () => {
  expect(previewBridgeAddressForSrc(null, "http://app.local")).toEqual({ kind: "invalid" });
  expect(previewBridgeAddressForSrc("not a url", "http://app.local")).toEqual({ kind: "invalid" });
  expect(previewBridgeAddressForSrc("/projects/p1/preview/", "http://app.local")).toEqual({
    kind: "opaque",
    expectedEventOrigin: "null",
    targetOrigin: "*",
  });
  expect(previewBridgeAddressForSrc("http://preview.local/", "http://app.local")).toEqual({
    kind: "origin",
    expectedEventOrigin: "http://preview.local",
    targetOrigin: "http://preview.local",
  });
});

test("nonce and cache-bust helpers preserve URL fragments exactly", () => {
  const bridged = withPreviewBridgeNonce(
    "http://preview.local/path?frame=desktop#stale=value&dezin-bridge=obsolete",
    NONCE,
  );
  expect(bridged).toBe(`http://preview.local/path?frame=desktop#dezin-bridge=${NONCE}`);
  expect(previewBridgeNonceForSrc(bridged)).toBe(NONCE);
  expect(cacheBustedPreviewUrl(bridged, 42)).toBe(
    `http://preview.local/path?frame=desktop&t=42#dezin-bridge=${NONCE}`,
  );
  expect(previewBridgeNonceForSrc(cacheBustedPreviewUrl(bridged, 42))).toBe(NONCE);
  expect(previewBridgeNonceForSrc("http://preview.local/#dezin-bridge=short")).toBeNull();
});

test("cross-origin preview authorization stays on the parent-created MessageChannel", async () => {
  const frame = document.createElement("iframe");
  document.body.append(frame);
  const frameWindow = frame.contentWindow!;
  const postMessage = vi.spyOn(frameWindow, "postMessage");
  const ready: boolean[] = [];
  const received: Array<Record<string, unknown>> = [];
  const controller = createPreviewChannelController({
    iframeRef: { current: frame },
    previewSrc: "http://preview.local/exact-page",
    bridgeNonce: NONCE,
    onMessage: (message) => received.push(message),
    onReadyChange: (value) => ready.push(value),
    onGenerationChange: () => {},
  });

  expect(controller).not.toBeNull();
  expect(controller!.connect()).toBe(true);
  const bootstrap = (postMessage.mock.calls as unknown as Array<[unknown, unknown, Transferable[]?]>).find(
    ([message]) => (message as { type?: string }).type === "bridge-init",
  );
  const childPort = bootstrap?.[2]?.[0] as MessagePort | undefined;
  expect(childPort).toBeDefined();

  window.dispatchEvent(new MessageEvent("message", {
    data: { source: "dezin", type: "bridge-ready", nonce: NONCE, protocol: 1 },
    origin: "http://preview.local",
    source: frameWindow,
  }));
  expect(ready).not.toContain(true);
  expect(controller!.send({ type: "set-prototype-bindings", bindings: [] })).toBe(false);
  expect(postMessage.mock.calls.some(([message]) => (
    (message as { type?: string }).type === "set-prototype-bindings"
  ))).toBe(false);

  const commands: Array<Record<string, unknown>> = [];
  childPort!.onmessage = (event) => commands.push(event.data as Record<string, unknown>);
  childPort!.start();
  childPort!.postMessage({ source: "dezin", type: "bridge-ready", nonce: NONCE, protocol: 1 });
  await vi.waitFor(() => expect(ready).toContain(true));
  expect(commands).toContainEqual(expect.objectContaining({ type: "set-prototype-bindings" }));

  window.dispatchEvent(new MessageEvent("message", {
    data: {
      source: "dezin",
      type: "prototype-binding-activated",
      nonce: NONCE,
      protocol: 1,
      bindingId: "binding-0",
      locator: { designNodeId: "cta" },
      trigger: "click",
    },
    origin: "http://preview.local",
    source: frameWindow,
  }));
  expect(received).toEqual([]);

  controller!.dispose();
  childPort!.close();
  postMessage.mockRestore();
  frame.remove();
});

test("same-origin isolated previews connect without exposing the bridge capability in their URL", async () => {
  const frame = document.createElement("iframe");
  document.body.append(frame);
  const postMessage = vi.spyOn(frame.contentWindow!, "postMessage");
  const ready: boolean[] = [];
  const controller = createPreviewChannelController({
    iframeRef: { current: frame },
    previewSrc: "/projects/project-flow/preview/index.html",
    bridgeNonce: NONCE,
    onMessage: () => {},
    onReadyChange: (value) => ready.push(value),
    onGenerationChange: () => {},
  });

  expect(controller).not.toBeNull();
  expect(controller!.connect()).toBe(true);
  const bootstrap = (postMessage.mock.calls as unknown as Array<[unknown, unknown, Transferable[]?]>).find(
    ([message]) => (message as { type?: string }).type === "bridge-init",
  );
  expect(bootstrap?.[1]).toBe("*");
  const childPort = bootstrap?.[2]?.[0] as MessagePort;
  childPort.start();
  childPort.postMessage({ source: "dezin", type: "bridge-ready", nonce: NONCE, protocol: 1 });
  await vi.waitFor(() => expect(ready).toContain(true));

  controller!.dispose();
  childPort.close();
  postMessage.mockRestore();
  frame.remove();
});
