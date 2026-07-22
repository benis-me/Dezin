import { useCallback, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";

export const PREVIEW_BRIDGE_PROTOCOL = 1 as const;
const NONCE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const MAX_PENDING_MESSAGES = 32;

export type PreviewBridgeAddress =
  | { kind: "invalid" }
  | { kind: "opaque"; expectedEventOrigin: "null"; targetOrigin: "*" }
  | { kind: "origin"; expectedEventOrigin: string; targetOrigin: string };

export type PreviewChannelMessage = {
  source: "dezin";
  type: string;
  nonce: string;
  protocol: typeof PREVIEW_BRIDGE_PROTOCOL;
} & Record<string, unknown>;

function parsePreviewUrl(src: string | null | undefined, baseOrigin: string): URL | null {
  const value = src?.trim();
  if (!value) return null;
  if (!(value.startsWith("/") || value.startsWith("./") || value.startsWith("../") || /^https?:\/\//i.test(value))) {
    return null;
  }
  try {
    const url = new URL(value, baseOrigin);
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

export function previewBridgeAddressForSrc(
  src?: string | null,
  baseOrigin = globalThis.location?.origin ?? "http://localhost",
): PreviewBridgeAddress {
  const url = parsePreviewUrl(src, baseOrigin);
  if (url === null) return { kind: "invalid" };
  return url.origin === baseOrigin
    ? { kind: "opaque", expectedEventOrigin: "null", targetOrigin: "*" }
    : { kind: "origin", expectedEventOrigin: url.origin, targetOrigin: url.origin };
}

export function previewBridgeNonceForSrc(
  src?: string | null,
  baseOrigin = globalThis.location?.origin ?? "http://localhost",
): string | null {
  const url = parsePreviewUrl(src, baseOrigin);
  if (url === null) return null;
  const nonce = new URLSearchParams(url.hash.slice(1)).get("dezin-bridge");
  return nonce !== null && NONCE_PATTERN.test(nonce) ? nonce : null;
}

/**
 * Return the iframe document address without the parent-held bridge capability.
 * The nonce is delivered only in the private MessagePort handshake.
 */
export function previewDocumentSrc(
  src: string,
  baseOrigin = globalThis.location?.origin ?? "http://localhost",
): string {
  const url = parsePreviewUrl(src, baseOrigin);
  if (url === null) throw new Error("Preview bridge URL is invalid.");
  url.hash = "";
  return src.trim().startsWith("/") ? `${url.pathname}${url.search}` : url.href;
}

export function generatePreviewBridgeNonce(): string {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return globalThis.btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function withPreviewBridgeNonce(
  src: string,
  nonce = generatePreviewBridgeNonce(),
  baseOrigin = globalThis.location?.origin ?? "http://localhost",
): string {
  if (!NONCE_PATTERN.test(nonce)) throw new Error("Preview bridge nonce must be a 32-byte base64url capability.");
  const url = parsePreviewUrl(src, baseOrigin);
  if (url === null) throw new Error("Preview bridge URL is invalid.");
  // The daemon treats this fragment as a single-purpose capability envelope.
  // Never carry unrelated or stale fragment data across lease generations.
  url.hash = `dezin-bridge=${nonce}`;
  return src.trim().startsWith("/") ? `${url.pathname}${url.search}${url.hash}` : url.href;
}

export function cacheBustedPreviewUrl(
  src: string,
  timestamp = Date.now(),
  baseOrigin = globalThis.location?.origin ?? "http://localhost",
): string {
  const url = parsePreviewUrl(src, baseOrigin);
  if (url === null) throw new Error("Preview URL is invalid.");
  url.searchParams.set("t", String(timestamp));
  return src.trim().startsWith("/") ? `${url.pathname}${url.search}${url.hash}` : url.href;
}

type PreviewParentCommand = { type: string } & Record<string, unknown>;
type ChannelTransport = { kind: "port"; port: MessagePort };

interface PreviewChannelController {
  connect(): boolean;
  send(command: PreviewParentCommand): boolean;
  dispose(): void;
}

function isBridgeMessage(value: unknown, nonce: string): value is PreviewChannelMessage {
  if (!value || typeof value !== "object") return false;
  const message = value as Partial<PreviewChannelMessage>;
  return message.source === "dezin"
    && message.nonce === nonce
    && message.protocol === PREVIEW_BRIDGE_PROTOCOL
    && typeof message.type === "string"
    && message.type.length > 0
    && message.type.length <= 64;
}

export function createPreviewChannelController({
  iframeRef,
  previewSrc,
  bridgeNonce,
  onMessage,
  onReadyChange,
  onGenerationChange,
}: {
  iframeRef: RefObject<HTMLIFrameElement | null>;
  previewSrc: string;
  bridgeNonce: string;
  onMessage: (message: PreviewChannelMessage) => void;
  onReadyChange: (ready: boolean) => void;
  onGenerationChange: (generation: number) => void;
}): PreviewChannelController | null {
  const address = previewBridgeAddressForSrc(previewSrc);
  if (address.kind === "invalid" || !NONCE_PATTERN.test(bridgeNonce)) return null;

  let disposed = false;
  let generation = 0;
  let ready = false;
  let port: MessagePort | null = null;
  let transport: ChannelTransport | null = null;
  let pending: PreviewParentCommand[] = [];

  const setReady = (value: boolean): void => {
    if (ready === value) return;
    ready = value;
    onReadyChange(value);
  };

  const closeTransport = (clearPending: boolean): void => {
    port?.close();
    port = null;
    transport = null;
    setReady(false);
    if (clearPending) pending = [];
  };

  const encoded = (command: PreviewParentCommand): Record<string, unknown> => ({
    ...command,
    source: "dezin-parent",
    nonce: bridgeNonce,
    protocol: PREVIEW_BRIDGE_PROTOCOL,
  });

  const post = (target: ChannelTransport, command: PreviewParentCommand): void => {
    const message = encoded(command);
    target.port.postMessage(message);
  };

  const accept = (value: unknown, candidate: ChannelTransport, messageGeneration: number): void => {
    if (disposed || messageGeneration !== generation || !isBridgeMessage(value, bridgeNonce)) return;
    if (value.type === "bridge-ready") {
      if (port !== candidate.port || (transport !== null && transport.port !== candidate.port)) return;
      transport = candidate;
      setReady(true);
      const queued = pending;
      pending = [];
      for (const command of queued) post(candidate, command);
      return;
    }
    if (!ready || transport === null || transport.port !== candidate.port) return;
    onMessage(value);
  };

  return {
    connect(): boolean {
      if (disposed) return false;
      const frameWindow = iframeRef.current?.contentWindow;
      if (!frameWindow || typeof MessageChannel === "undefined") return false;
      closeTransport(true);
      generation += 1;
      onGenerationChange(generation);
      const channel = new MessageChannel();
      port = channel.port1;
      const currentGeneration = generation;
      port.onmessage = (event) => accept(event.data, { kind: "port", port: channel.port1 }, currentGeneration);
      port.start();
      try {
        frameWindow.postMessage({
          source: "dezin-parent",
          type: "bridge-init",
          nonce: bridgeNonce,
          protocol: PREVIEW_BRIDGE_PROTOCOL,
        }, address.targetOrigin, [channel.port2]);
        return true;
      } catch {
        closeTransport(true);
        channel.port2.close();
        return false;
      }
    },
    send(command): boolean {
      if (disposed || typeof command.type !== "string" || command.type.length === 0 || command.type.length > 64) return false;
      if (ready && transport !== null) {
        post(transport, command);
        return true;
      }
      pending = [...pending.slice(-(MAX_PENDING_MESSAGES - 1)), command];
      return false;
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      closeTransport(true);
    },
  };
}

export function usePreviewChannel({
  iframeRef,
  previewSrc,
  bridgeNonce,
  enabled,
  onMessage,
}: {
  iframeRef: RefObject<HTMLIFrameElement | null>;
  previewSrc: string | null;
  bridgeNonce: string | null;
  enabled: boolean;
  onMessage: (message: PreviewChannelMessage) => void;
}) {
  const onMessageRef = useRef(onMessage);
  onMessageRef.current = onMessage;
  const [ready, setReady] = useState(false);
  const [generation, setGeneration] = useState(0);
  const controllerRef = useRef<PreviewChannelController | null>(null);
  const available = useMemo(
    () => enabled
      && previewSrc !== null
      && bridgeNonce !== null
      && previewBridgeAddressForSrc(previewSrc).kind !== "invalid"
      && NONCE_PATTERN.test(bridgeNonce)
      && typeof MessageChannel !== "undefined",
    [bridgeNonce, enabled, previewSrc],
  );

  useLayoutEffect(() => {
    setReady(false);
    setGeneration(0);
    if (!available || previewSrc === null || bridgeNonce === null) {
      controllerRef.current = null;
      return;
    }
    const controller = createPreviewChannelController({
      iframeRef,
      previewSrc,
      bridgeNonce,
      onMessage: (message) => onMessageRef.current(message),
      onReadyChange: setReady,
      onGenerationChange: setGeneration,
    });
    controllerRef.current = controller;
    return () => {
      if (controllerRef.current === controller) controllerRef.current = null;
      controller?.dispose();
    };
  }, [available, bridgeNonce, iframeRef, previewSrc]);

  const connect = useCallback(() => controllerRef.current?.connect() ?? false, []);
  const send = useCallback((command: PreviewParentCommand) => controllerRef.current?.send(command) ?? false, []);

  return { available, ready, generation, connect, send };
}
