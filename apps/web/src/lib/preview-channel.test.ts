import { expect, test } from "vitest";
import {
  cacheBustedPreviewUrl,
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
