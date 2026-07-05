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
