import { expect, test } from "vitest";
import {
  isRuntimeErrorMessage,
  signatureOf,
  initialRuntimeErrorState,
  ingestRuntimeError,
  dismissFatal,
  dismissNonFatal,
  buildRuntimeErrorRepairPrompt,
  type RuntimeErrorMessage,
} from "./preview-runtime-errors.ts";

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

test("signatureOf is stable across identical errors", () => {
  expect(signatureOf({ errorType: "error", message: "x", src: "a.js", line: 3 })).toBe(
    signatureOf({ errorType: "error", message: "x", src: "a.js", line: 3 }),
  );
  expect(signatureOf({ errorType: "error", message: "x" })).not.toBe(signatureOf({ errorType: "error", message: "y" }));
});

const msg = (over: Partial<RuntimeErrorMessage> = {}): RuntimeErrorMessage => ({
  source: "dezin", type: "runtime-error", kind: "nonfatal", errorType: "console", message: "m", count: 1, at: 1, ...over,
});

test("ingest routes fatal and non-fatal into separate buckets", () => {
  let s = initialRuntimeErrorState;
  s = ingestRuntimeError(s, msg({ kind: "fatal", errorType: "error", message: "died" }), { runActive: false });
  s = ingestRuntimeError(s, msg({ message: "warn" }), { runActive: false });
  expect(s.fatal?.message).toBe("died");
  expect(s.nonFatal.map((e) => e.message)).toEqual(["warn"]);
});

test("ingest dedupes non-fatal by signature and keeps latest count", () => {
  let s = initialRuntimeErrorState;
  s = ingestRuntimeError(s, msg({ message: "dup", count: 1 }), { runActive: false });
  s = ingestRuntimeError(s, msg({ message: "dup", count: 4 }), { runActive: false });
  expect(s.nonFatal).toHaveLength(1);
  expect(s.nonFatal[0].count).toBe(4);
});

test("runActive suppresses fatal (buffers nothing visible)", () => {
  const s = ingestRuntimeError(initialRuntimeErrorState, msg({ kind: "fatal", message: "x" }), { runActive: true });
  expect(s.fatal).toBeNull();
});

test("a dismissed fatal signature does not re-open until it changes", () => {
  let s = ingestRuntimeError(initialRuntimeErrorState, msg({ kind: "fatal", errorType: "error", message: "z" }), { runActive: false });
  s = dismissFatal(s);
  expect(s.fatal).toBeNull();
  s = ingestRuntimeError(s, msg({ kind: "fatal", errorType: "error", message: "z" }), { runActive: false });
  expect(s.fatal).toBeNull();
});

test("dismissNonFatal removes one entry by signature", () => {
  let s = ingestRuntimeError(initialRuntimeErrorState, msg({ message: "a" }), { runActive: false });
  s = dismissNonFatal(s, s.nonFatal[0].sig);
  expect(s.nonFatal).toHaveLength(0);
});

test("repair prompt includes message, stack, source and asks to fix + verify", () => {
  const p = buildRuntimeErrorRepairPrompt(
    [{ source: "dezin", type: "runtime-error", kind: "fatal", errorType: "error", message: "x is not a function", stack: "at App (App.tsx:10)", src: "App.tsx", line: 10, count: 2, at: 1, sig: "s" }],
    { mode: "standard", projectPath: "/p" },
  );
  expect(p).toMatch(/x is not a function/);
  expect(p).toMatch(/App\.tsx/);
  expect(p).toMatch(/at App/);
  expect(p.toLowerCase()).toMatch(/fix/);
  expect(p.toLowerCase()).toMatch(/preview|render/);
});
