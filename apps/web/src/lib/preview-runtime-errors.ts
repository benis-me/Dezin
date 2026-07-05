export type RuntimeErrorKind = "fatal" | "nonfatal";
export type RuntimeErrorType = "error" | "unhandledrejection" | "console" | "resource" | "request";

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

export interface PreviewHeartbeatMessage {
  source: "dezin";
  type: "preview-heartbeat";
  phase: "first-paint";
  at: number;
}

const KINDS = new Set<RuntimeErrorKind>(["fatal", "nonfatal"]);

export function isRuntimeErrorMessage(data: unknown): data is RuntimeErrorMessage {
  const d = data as Partial<RuntimeErrorMessage> | null;
  return Boolean(
    d && typeof d === "object" && d.source === "dezin" && d.type === "runtime-error" &&
      typeof d.message === "string" && typeof d.kind === "string" && KINDS.has(d.kind as RuntimeErrorKind),
  );
}

export function isHeartbeatMessage(data: unknown): data is PreviewHeartbeatMessage {
  const d = data as Partial<PreviewHeartbeatMessage> | null;
  return Boolean(d && typeof d === "object" && d.source === "dezin" && d.type === "preview-heartbeat");
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
