import { expect, test } from "vitest";
import { isRuntimeErrorMessage, isHeartbeatMessage, signatureOf } from "./preview-runtime-errors.ts";

const base = { source: "dezin", type: "runtime-error", kind: "fatal", errorType: "error", message: "boom", count: 1, at: 1 };

test("isRuntimeErrorMessage accepts a valid message", () => {
  expect(isRuntimeErrorMessage(base)).toBe(true);
});

test("isRuntimeErrorMessage rejects foreign / malformed data", () => {
  expect(isRuntimeErrorMessage({ ...base, source: "other" })).toBe(false);
  expect(isRuntimeErrorMessage({ ...base, type: "selected" })).toBe(false);
  expect(isRuntimeErrorMessage({ ...base, kind: "meh" })).toBe(false);
  expect(isRuntimeErrorMessage(null)).toBe(false);
});

test("isHeartbeatMessage accepts a valid heartbeat", () => {
  expect(isHeartbeatMessage({ source: "dezin", type: "preview-heartbeat", phase: "first-paint", at: 2 })).toBe(true);
  expect(isHeartbeatMessage(base)).toBe(false);
});

test("signatureOf is stable across identical errors", () => {
  expect(signatureOf({ errorType: "error", message: "x", src: "a.js", line: 3 })).toBe(
    signatureOf({ errorType: "error", message: "x", src: "a.js", line: 3 }),
  );
  expect(signatureOf({ errorType: "error", message: "x" })).not.toBe(signatureOf({ errorType: "error", message: "y" }));
});
