import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { previewBridgeOriginForSrc } from "./preview-sandbox.ts";

export type RuntimeErrorKind = "fatal" | "nonfatal";
export type RuntimeErrorType = "error" | "unhandledrejection" | "console" | "resource" | "request" | "blank";

export interface RuntimeErrorMessage {
  source: "dezin";
  type: "runtime-error";
  kind: RuntimeErrorKind;
  errorType: RuntimeErrorType;
  message: string;
  stack?: string;
  src?: string;
  line?: number;
  col?: number;
  count: number;
  at: number;
}

const KINDS = new Set<RuntimeErrorKind>(["fatal", "nonfatal"]);
const ERROR_TYPES = new Set<RuntimeErrorType>(["error", "unhandledrejection", "console", "resource", "request", "blank"]);

function boundedOptionalString(value: unknown, maxLength: number): boolean {
  return value === undefined || (typeof value === "string" && value.length <= maxLength);
}

function finiteOptionalNumber(value: unknown): boolean {
  return value === undefined || (typeof value === "number" && Number.isFinite(value) && value >= 0);
}

export function isRuntimeErrorMessage(data: unknown): data is RuntimeErrorMessage {
  const d = data as Partial<RuntimeErrorMessage> | null;
  return Boolean(
    d && typeof d === "object" && d.source === "dezin" && d.type === "runtime-error" &&
      typeof d.message === "string" && d.message.length > 0 && d.message.length <= 4_096 &&
      typeof d.kind === "string" && KINDS.has(d.kind as RuntimeErrorKind) &&
      typeof d.errorType === "string" && ERROR_TYPES.has(d.errorType as RuntimeErrorType) &&
      typeof d.count === "number" && Number.isInteger(d.count) && d.count >= 1 && d.count <= 1_000_000 &&
      typeof d.at === "number" && Number.isFinite(d.at) && d.at >= 0 &&
      boundedOptionalString(d.stack, 16_384) && boundedOptionalString(d.src, 2_048) &&
      finiteOptionalNumber(d.line) && finiteOptionalNumber(d.col),
  );
}

export function signatureOf(m: Pick<RuntimeErrorMessage, "errorType" | "message" | "src" | "line">): string {
  return `${m.errorType}|${m.message}|${m.src ?? ""}:${m.line ?? 0}`;
}

export interface RuntimeError extends RuntimeErrorMessage {
  sig: string;
}

export interface RuntimeErrorState {
  fatal: RuntimeError | null;
  nonFatal: RuntimeError[];
  dismissedFatalSig: string | null;
}

export const initialRuntimeErrorState: RuntimeErrorState = {
  fatal: null,
  nonFatal: [],
  dismissedFatalSig: null,
};

export function resetRuntimeErrors(): RuntimeErrorState {
  return { fatal: null, nonFatal: [], dismissedFatalSig: null };
}

const NONFATAL_CAP = 50;

export function ingestRuntimeError(
  state: RuntimeErrorState,
  msg: RuntimeErrorMessage,
  opts: { runActive: boolean },
): RuntimeErrorState {
  const sig = signatureOf(msg);
  const entry: RuntimeError = { ...msg, sig };

  if (msg.kind === "fatal") {
    if (opts.runActive || state.dismissedFatalSig === sig) return state;
    return { ...state, fatal: entry };
  }

  const rest = state.nonFatal.filter((e) => e.sig !== sig);
  return { ...state, nonFatal: [...rest, entry].slice(-NONFATAL_CAP) };
}

export function dismissFatal(state: RuntimeErrorState): RuntimeErrorState {
  return { ...state, fatal: null, dismissedFatalSig: state.fatal?.sig ?? state.dismissedFatalSig };
}

export function dismissNonFatal(state: RuntimeErrorState, sig: string): RuntimeErrorState {
  return { ...state, nonFatal: state.nonFatal.filter((e) => e.sig !== sig) };
}

export function usePreviewRuntimeErrors(args: {
  iframeRef: RefObject<HTMLIFrameElement | null>;
  previewSrc: string | null;
  runActive: boolean;
  listenToWindow?: boolean;
}): {
  fatal: RuntimeError | null;
  nonFatal: RuntimeError[];
  ingestMessage(data: unknown): void;
  reset(): void;
  dismissFatal(): void;
  dismissNonFatal(sig: string): void;
} {
  const { iframeRef, previewSrc, runActive, listenToWindow = true } = args;
  const [state, setState] = useState<RuntimeErrorState>(initialRuntimeErrorState);
  const runActiveRef = useRef(runActive);
  runActiveRef.current = runActive;

  const ingestMessage = useCallback((data: unknown): void => {
    if (isRuntimeErrorMessage(data)) {
      setState((current) => ingestRuntimeError(current, data, { runActive: runActiveRef.current }));
    }
  }, []);
  const reset = useCallback((): void => setState(resetRuntimeErrors()), []);

  useEffect(() => {
    setState(resetRuntimeErrors());
    if (!listenToWindow) return;
    const onMessage = (event: MessageEvent): void => {
      const iframe = iframeRef.current;
      if (!iframe?.contentWindow || event.source !== iframe.contentWindow) return;
      if (event.origin !== previewBridgeOriginForSrc(previewSrc)) return;
      ingestMessage(event.data);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [iframeRef, ingestMessage, listenToWindow, previewSrc]);

  return {
    fatal: state.fatal,
    nonFatal: state.nonFatal,
    ingestMessage,
    reset,
    dismissFatal: () => setState(dismissFatal),
    dismissNonFatal: (sig: string) => setState((s) => dismissNonFatal(s, sig)),
  };
}

export function buildRuntimeErrorRepairPrompt(errors: RuntimeError[], ctx: { mode: string; projectPath?: string }): string {
  const blocks = errors.map((e, i) => {
    const lines = [
      `${i + 1}. [${e.errorType}${e.count > 1 ? ` ×${e.count}` : ""}] ${e.message}`,
      e.src ? `   source: ${e.src}${e.line ? `:${e.line}${e.col ? `:${e.col}` : ""}` : ""}` : "",
      e.stack ? `   stack: ${e.stack}` : "",
    ];
    return lines.filter(Boolean).join("\n");
  });
  return `The live preview reported runtime errors. Find the root cause in this project's source and fix it.

Build mode: ${ctx.mode}${ctx.projectPath ? `\nProject path: ${ctx.projectPath}` : ""}

Runtime errors observed in the rendered preview:
${blocks.join("\n")}

Fix the underlying bug in the project's code (not by hiding the error), then confirm the preview renders without these errors.`;
}
