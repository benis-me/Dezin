import { expect, test, vi } from "vitest";
import {
  cacheBustedPreviewUrl,
  createPreviewChannelController,
  embeddedPreviewDocumentSrc,
  isEmbeddedPreviewContextMenuPortMessage,
  previewBridgeAddressForSrc,
  previewBridgeNonceForSrc,
  type PreviewChannelMessage,
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

test("embedded preview URLs are derived only from exact Design Version preview URLs", () => {
  expect(embeddedPreviewDocumentSrc(
    "/api/projects/project-one/design-canvas/nodes/node-one/versions/version-one/preview/",
    "http://app.local",
  )).toBe(
    "/api/projects/project-one/design-canvas/nodes/node-one/versions/version-one/preview/embed",
  );
  expect(embeddedPreviewDocumentSrc(
    `http://preview.local/api/projects/project%20%2F1/design-canvas/nodes/node%20%2F1/versions/version%20%2F9/preview/?t=42#dezin-bridge=${NONCE}`,
    "http://app.local",
  )).toBe(
    "http://preview.local/api/projects/project%20%2F1/design-canvas/nodes/node%20%2F1/versions/version%20%2F9/preview/embed?t=42",
  );
  expect(() => embeddedPreviewDocumentSrc("https://preview.local/not-a-version/preview"))
    .toThrow(/exact design version preview url/i);
  expect(() => embeddedPreviewDocumentSrc(
    "https://user:secret@preview.local/api/projects/p/design-canvas/nodes/n/versions/v/preview/",
  )).toThrow(/exact design version preview url/i);
  expect(() => embeddedPreviewDocumentSrc(
    "/api/projects/p/design-canvas/nodes/n/versions/v/preview/embed",
  )).toThrow(/exact design version preview url/i);
});

test("embedded preview context-menu guards require the private port capability", () => {
  const message: PreviewChannelMessage = {
    source: "dezin",
    type: "embedded-preview-context-menu",
    protocol: 1,
    nonce: NONCE,
    clientX: 24.5,
    clientY: 48,
  };
  expect(isEmbeddedPreviewContextMenuPortMessage(message, NONCE)).toBe(true);
  expect(isEmbeddedPreviewContextMenuPortMessage({
    source: "dezin",
    type: "embedded-preview-context-menu",
    protocol: 1,
    nonce: "",
    clientX: 24.5,
    clientY: 48,
  }, NONCE)).toBe(false);
  expect(isEmbeddedPreviewContextMenuPortMessage({
    ...message,
    clientX: Number.NaN,
  }, NONCE)).toBe(false);
  expect(isEmbeddedPreviewContextMenuPortMessage(message, "_".repeat(43))).toBe(false);
});

test("cross-origin preview authorization stays on the parent-created MessageChannel", async () => {
  const frame = document.createElement("iframe");
  document.body.append(frame);
  const frameWindow = frame.contentWindow!;
  const postMessage = vi.spyOn(frameWindow, "postMessage");
  const ready: boolean[] = [];
  const received: PreviewChannelMessage[] = [];
  const iframeRef: { current: HTMLIFrameElement | null } = { current: frame };
  const controller = createPreviewChannelController({
    iframeRef,
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
      type: "embedded-preview-context-menu",
      nonce: NONCE,
      protocol: 1,
      clientX: 24,
      clientY: 48,
    },
    origin: "http://preview.local",
    source: frameWindow,
  }));
  expect(received).toEqual([]);

  childPort!.postMessage({
    source: "dezin",
    type: "embedded-preview-context-menu",
    nonce: NONCE,
    protocol: 1,
    clientX: 24,
    clientY: 48,
  });
  await vi.waitFor(() => expect(received).toHaveLength(1));
  expect(isEmbeddedPreviewContextMenuPortMessage(received[0]!, NONCE)).toBe(true);

  const replacementFrame = document.createElement("iframe");
  document.body.append(replacementFrame);
  iframeRef.current = replacementFrame;
  childPort!.postMessage({
    source: "dezin",
    type: "embedded-preview-context-menu",
    nonce: NONCE,
    protocol: 1,
    clientX: 72,
    clientY: 96,
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(received).toHaveLength(1);

  controller!.dispose();
  childPort!.close();
  postMessage.mockRestore();
  replacementFrame.remove();
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
