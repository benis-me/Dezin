import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import type { WorkspaceDesignNodeLocator, WorkspaceRenderFrameSpec } from "../../lib/api.ts";
import { usePreviewChannel, type PreviewChannelMessage } from "../../lib/preview-channel.ts";
import {
  buildRuntimeErrorRepairPrompt,
  dismissFatal as dismissRuntimeFatal,
  dismissNonFatal as dismissRuntimeNonFatal,
  ingestRuntimeError,
  isRuntimeErrorMessage,
  resetRuntimeErrors,
  type RuntimeError,
  type RuntimeErrorMessage,
  type RuntimeErrorState,
} from "../../lib/preview-runtime-errors.ts";

interface PreviewSelectionMessage {
  source: "dezin";
  type: "element-selected" | "element-cleared" | "selected" | "cancel";
  locator?: Partial<WorkspaceDesignNodeLocator>;
  selector?: string;
  tag?: string;
  text?: string;
  textPreview?: string;
  textComplete?: boolean;
  rect?: { x: number; y: number; w: number; h: number };
  instanceId?: string;
  attrs?: { id?: string; screenLabel?: string };
}

type NormalizedPreviewMessage =
  | { type: "cleared" }
  | {
      type: "selected";
      locator: WorkspaceDesignNodeLocator;
      tag: string | null;
      text: string | null;
      textPreview: string | null;
      textMutationCapable: boolean;
      textMutationUnavailableReason: string | null;
      rect: ArtifactElementContext["rect"];
      instanceId: string | null;
      mutationCapable: boolean;
    };

export interface ArtifactElementContext {
  type: "design-element";
  id: string;
  projectId: string;
  artifactId: string;
  revisionId: string;
  targetKey: string;
  assemblyHash: string;
  frameId: string;
  label: string;
  locator: WorkspaceDesignNodeLocator;
  tag: string | null;
  text: string | null;
  rect: { x: number; y: number; width: number; height: number } | null;
  instanceId: string | null;
  mutationCapable: boolean;
  mutationUnavailableReason: string | null;
  textMutationCapable: boolean;
  textMutationUnavailableReason: string | null;
}

export interface PreviewBridgeIdentity {
  revisionId: string;
  targetKey: string;
  assemblyHash: string;
  leaseId: string;
  bridgeNonce: string;
}

export interface ArtifactRuntimeErrorIdentity {
  projectId: string;
  artifactId: string;
  revisionId: string;
  targetKey: string;
  assemblyHash: string;
  frameId: string;
}

export function buildArtifactRuntimeRepairContext(
  errors: RuntimeError[],
  identity: ArtifactRuntimeErrorIdentity,
): string {
  return [
    "Immutable artifact preview:",
    `Project: ${identity.projectId}`,
    `Artifact: ${identity.artifactId}`,
    `Revision: ${identity.revisionId}`,
    `Target: ${identity.targetKey}`,
    `Assembly: ${identity.assemblyHash}`,
    `Frame: ${identity.frameId}`,
    "",
    buildRuntimeErrorRepairPrompt(errors, { mode: "standard" }),
  ].join("\n");
}

export type PreviewFrameState =
  | { status: "idle"; frameId: null }
  | { status: "pending"; frameId: string; reconnecting?: boolean }
  | { status: "applying"; frameId: string; attempt: 0 | 1 | 2 }
  | { status: "applied"; frameId: string }
  | { status: "rejected"; frameId: string; message: string; retryable?: boolean };

export interface PreviewFrameCommand extends Record<string, unknown> {
  type: "set-frame";
  frameId: string;
  frameAttemptId?: string;
  initialState?: string;
  fixture?: Record<string, unknown>;
  background?: string;
}

const FRAME_FIXTURE_MAX_JSON_CHARS = 64 * 1024;
export const PREVIEW_FRAME_ACK_TIMEOUT_MS = 1_500;
const PICKER_TEXT_VALUE_LIMIT = 100_000;
const PICKER_TEXT_PREVIEW_LIMIT = 160;
const FRAME_FIXTURE_MAX_DEPTH = 16;
const FRAME_FIXTURE_MAX_NODES = 4_096;
const FRAME_FIXTURE_MAX_MEMBERS = 256;
const FRAME_FIXTURE_MAX_STRING = 8_192;
const UNSAFE_FRAME_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const RESOURCE_BACKGROUND = /(?:url|image|image-set|cross-fade|element|paint|var|attr)\s*\(/i;
const UNSAFE_FRAME_CONTROL = /[\u0000-\u001f\u007f]/;
const FRAME_REJECTION_MESSAGES: Readonly<Record<string, string>> = {
  "invalid-frame-id": "The selected preview frame has an invalid identifier.",
  "invalid-frame-attempt": "The preview rejected an invalid frame attempt identifier.",
  "invalid-initial-state": "The selected preview frame has an invalid initial state.",
  "invalid-fixture": "The selected preview frame has invalid fixture data.",
  "unsafe-background": "The selected preview frame uses an unsupported background.",
  "frame-too-large": "The selected preview frame exceeds the supported size limits.",
  "render-frame-unavailable": "This preview cannot apply design frame state.",
  "frame-event-unavailable": "This preview cannot notify the design about frame changes.",
  "invalid-frame": "The preview could not apply the selected design frame.",
};

export function safePreviewFrameBackground(value: string | undefined): string | null {
  if (value === undefined) return null;
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > 4_096 || UNSAFE_FRAME_CONTROL.test(normalized)
    || normalized.includes("\\") || normalized.includes("/*") || RESOURCE_BACKGROUND.test(normalized)) return null;
  return normalized;
}

function validateFrameFixture(root: Record<string, unknown>): string | null {
  if (Array.isArray(root)) return "Frame fixture root must be an object.";
  const stack: Array<{ value: unknown; depth: number }> = [{ value: root, depth: 0 }];
  const seen = new Set<object>();
  let nodes = 0;
  while (stack.length > 0) {
    const current = stack.pop()!;
    nodes += 1;
    if (nodes > FRAME_FIXTURE_MAX_NODES) return "Frame fixture is too complex.";
    if (current.depth > FRAME_FIXTURE_MAX_DEPTH) return "Frame fixture is nested too deeply.";
    if (current.value === null || typeof current.value === "boolean") continue;
    if (typeof current.value === "string") {
      if (current.value.length > FRAME_FIXTURE_MAX_STRING) return "Frame fixture contains an oversized string.";
      continue;
    }
    if (typeof current.value === "number") {
      if (!Number.isFinite(current.value)) return "Frame fixture contains a non-finite number.";
      continue;
    }
    if (typeof current.value !== "object") return "Frame fixture must contain JSON values only.";
    if (seen.has(current.value)) return "Frame fixture must not contain cycles.";
    seen.add(current.value);
    if (!Array.isArray(current.value)) {
      const prototype = Object.getPrototypeOf(current.value);
      if (prototype !== Object.prototype && prototype !== null) return "Frame fixture must contain plain objects only.";
    }
    const entries = Object.entries(current.value);
    if (entries.length > FRAME_FIXTURE_MAX_MEMBERS) return "Frame fixture container has too many members.";
    for (const [key, value] of entries) {
      if (UNSAFE_FRAME_KEYS.has(key)) return "Frame fixture contains an unsafe object key.";
      stack.push({ value, depth: current.depth + 1 });
    }
  }
  try {
    const encoded = JSON.stringify(root);
    return encoded.length <= FRAME_FIXTURE_MAX_JSON_CHARS ? null : "Frame fixture exceeds the 64 KiB limit.";
  } catch {
    return "Frame fixture must be serializable JSON.";
  }
}

export function buildPreviewFrameCommand(
  frame: WorkspaceRenderFrameSpec,
): { ok: true; command: PreviewFrameCommand } | { ok: false; message: string } {
  if (frame.id.length === 0 || frame.id.length > 256 || frame.id !== frame.id.trim()
    || UNSAFE_FRAME_CONTROL.test(frame.id)) {
    return { ok: false, message: "Frame id must be 1–256 characters without surrounding whitespace." };
  }
  if (frame.initialState !== undefined
    && (frame.initialState.length > 256 || UNSAFE_FRAME_CONTROL.test(frame.initialState))) {
    return { ok: false, message: "Frame initial state exceeds the 256-character limit." };
  }
  let background: string | undefined;
  if (frame.background !== undefined) {
    background = safePreviewFrameBackground(frame.background) ?? undefined;
    if (background === undefined) {
      return { ok: false, message: "Frame background cannot load or reference external resources." };
    }
  }
  if (frame.fixture !== undefined) {
    const fixtureError = validateFrameFixture(frame.fixture);
    if (fixtureError !== null) return { ok: false, message: fixtureError };
  }
  return {
    ok: true,
    command: {
      type: "set-frame",
      frameId: frame.id,
      ...(frame.initialState !== undefined ? { initialState: frame.initialState } : {}),
      ...(frame.fixture !== undefined ? { fixture: frame.fixture } : {}),
      ...(background !== undefined ? { background } : {}),
    },
  };
}

function isInteractiveTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement
    && Boolean(target.closest("input, textarea, select, button, a, [contenteditable='true'], [role='textbox']"));
}

function trimmed(value: unknown, maxLength = 512): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= maxLength ? normalized : undefined;
}

function isWellFormedUtf16(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function exactPickerText(message: Partial<PreviewSelectionMessage>): string | null {
  if (message.textComplete !== true || typeof message.text !== "string"
    || message.text.length > PICKER_TEXT_VALUE_LIMIT || !isWellFormedUtf16(message.text)) return null;
  return message.text;
}

function pickerTextPreview(message: Partial<PreviewSelectionMessage>, exactText: string | null): string | null {
  const supplied = trimmed(message.textPreview, PICKER_TEXT_PREVIEW_LIMIT);
  if (supplied !== undefined) return supplied;
  const previewSource = exactText ?? (typeof message.text === "string" && message.text.length <= 512
    && isWellFormedUtf16(message.text) ? message.text : null);
  if (previewSource === null) return null;
  const compact = previewSource.replace(/\s+/g, " ").trim().slice(0, PICKER_TEXT_PREVIEW_LIMIT);
  return compact.length > 0 ? compact : null;
}

function frameRejectionMessage(message: PreviewChannelMessage): string {
  const reason = trimmed(message.reason, 64);
  if (reason !== undefined && FRAME_REJECTION_MESSAGES[reason] !== undefined) {
    return FRAME_REJECTION_MESSAGES[reason];
  }
  return trimmed(message.error, 256) ?? "The preview rejected this frame state.";
}

function stableDomNodeId(seed: string, hint?: string): string {
  let hash = 2166136261;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  const readable = hint?.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-|-$/g, "").slice(0, 36);
  return `dom-${readable ? `${readable}-` : ""}${(hash >>> 0).toString(36)}`;
}

function selectorHasStableMarker(selector: string | undefined, designNodeId: string | undefined): boolean {
  if (!selector || !designNodeId) return false;
  const marker = /data-(?:dezin-id|design-node-id|dezin-node-id)\s*=\s*["']?([^"'\]\s]+)/i.exec(selector);
  return marker?.[1] === designNodeId;
}

function normalizeLocator(message: PreviewSelectionMessage): {
  locator: WorkspaceDesignNodeLocator;
  mutationCapable: boolean;
} | null {
  const selector = trimmed(message.locator?.selector, 4_096) ?? trimmed(message.selector, 4_096);
  const sourcePath = trimmed(message.locator?.sourcePath, 1_024);
  const explicitId = trimmed(message.locator?.designNodeId, 256);
  const hint = trimmed(message.attrs?.screenLabel, 256) ?? trimmed(message.attrs?.id, 256);
  const designNodeId = explicitId ?? (selector ? stableDomNodeId(selector, hint) : undefined);
  if (!designNodeId) return null;
  return {
    locator: {
      designNodeId,
      ...(sourcePath ? { sourcePath } : {}),
      ...(selector ? { selector } : {}),
    },
    mutationCapable: message.type === "element-selected"
      && Boolean(sourcePath && explicitId && selectorHasStableMarker(selector, explicitId)),
  };
}

function normalizeRect(value: PreviewSelectionMessage["rect"]): ArtifactElementContext["rect"] {
  if (!value) return null;
  if (![value.x, value.y, value.w, value.h].every((coordinate) => Number.isFinite(coordinate))) return null;
  if (Math.abs(value.x) > 10_000_000 || Math.abs(value.y) > 10_000_000) return null;
  if (value.w < 0 || value.h < 0 || value.w > 10_000_000 || value.h > 10_000_000) return null;
  return { x: value.x, y: value.y, width: value.w, height: value.h };
}

function messageData(value: unknown): NormalizedPreviewMessage | null {
  if (!value || typeof value !== "object") return null;
  const message = value as Partial<PreviewSelectionMessage>;
  if (message.source !== "dezin") return null;
  if (message.type === "element-cleared" || message.type === "cancel") return { type: "cleared" };
  if (message.type !== "element-selected" && message.type !== "selected") return null;
  const normalizedLocator = normalizeLocator(message as PreviewSelectionMessage);
  if (normalizedLocator === null) return null;
  const text = exactPickerText(message);
  const textPreview = pickerTextPreview(message, text);
  const textMutationCapable = normalizedLocator.mutationCapable && text !== null;
  return {
    type: "selected",
    locator: normalizedLocator.locator,
    tag: trimmed(message.tag, 64)?.toLowerCase() ?? null,
    text,
    textPreview,
    rect: normalizeRect(message.rect),
    instanceId: trimmed(message.instanceId) ?? null,
    mutationCapable: normalizedLocator.mutationCapable,
    textMutationCapable,
    textMutationUnavailableReason: textMutationCapable
      ? null
      : normalizedLocator.mutationCapable
        ? "Text editing requires the picker's complete text value; truncated or invalid text remains Agent Context only."
        : "Text editing requires a source-backed stable marker.",
  };
}

export function usePreviewBridge({
  iframeRef,
  previewSrc,
  projectId,
  artifactId,
  previewIdentity,
  frame,
  enabled,
}: {
  iframeRef: RefObject<HTMLIFrameElement | null>;
  previewSrc: string | null;
  projectId: string;
  artifactId: string | null;
  previewIdentity: PreviewBridgeIdentity | null;
  frame: WorkspaceRenderFrameSpec | null;
  enabled: boolean;
}) {
  const [storedSelection, setStoredSelection] = useState<ArtifactElementContext | null>(null);
  const [pickerActive, setPickerActive] = useState(false);
  const [frameState, setFrameState] = useState<PreviewFrameState>({ status: "idle", frameId: null });
  const [runtimeErrorState, setRuntimeErrorState] = useState<RuntimeErrorState>(resetRuntimeErrors);
  const appliedFrameIdRef = useRef<string | null>(null);
  const appliedFrameAttemptIdRef = useRef<string | null>(null);
  const frameTerminalRef = useRef<{ attemptId: string; status: "applied" | "rejected" } | null>(null);
  const frameAttemptSequenceRef = useRef(0);
  const pendingRuntimeErrorsRef = useRef<RuntimeErrorMessage[]>([]);
  const frameAttemptRef = useRef<{
    key: string;
    command: PreviewFrameCommand;
    retries: number;
    reconnects: number;
    activeAttemptId: string | null;
  } | null>(null);
  const lastIdentityRef = useRef<string | null>(null);
  const identity = enabled && artifactId !== null && previewIdentity !== null
    ? JSON.stringify([
        projectId,
        artifactId,
        previewIdentity.revisionId,
        previewIdentity.targetKey,
        previewIdentity.assemblyHash,
        previewIdentity.leaseId,
        previewIdentity.bridgeNonce,
        frame?.id ?? null,
      ])
    : null;
  const selection = storedSelection !== null
    && identity !== null
    && previewIdentity !== null
    && storedSelection.projectId === projectId
    && storedSelection.artifactId === artifactId
    && storedSelection.revisionId === previewIdentity.revisionId
    && storedSelection.targetKey === previewIdentity.targetKey
    && storedSelection.assemblyHash === previewIdentity.assemblyHash
    && storedSelection.frameId === frame?.id
    && frameState.status === "applied"
    && frameState.frameId === frame?.id
    ? storedSelection
    : null;

  const onBridgeMessage = useCallback((message: PreviewChannelMessage): void => {
    if (artifactId === null || previewIdentity === null) return;
    if (isRuntimeErrorMessage(message)) {
      const messageFrameId = trimmed(message.frameId, 256);
      const messageAttemptId = trimmed(message.frameAttemptId, 128);
      const activeAttemptId = frameAttemptRef.current?.activeAttemptId ?? null;
      if (frame === null || messageFrameId !== frame.id || messageAttemptId === undefined
        || messageAttemptId !== activeAttemptId) return;
      if (frameTerminalRef.current?.attemptId === messageAttemptId
        && frameTerminalRef.current.status === "rejected") return;
      if (appliedFrameIdRef.current === frame.id && appliedFrameAttemptIdRef.current === messageAttemptId) {
        setRuntimeErrorState((current) => ingestRuntimeError(current, message, { runActive: false }));
      } else if (pendingRuntimeErrorsRef.current.length < 16) {
        pendingRuntimeErrorsRef.current.push(message);
      }
      return;
    }
    const messageFrameId = trimmed(message.frameId, 256);
    const messageAttemptId = trimmed(message.frameAttemptId, 128);
    const activeAttemptId = frameAttemptRef.current?.activeAttemptId ?? null;
    if (message.type === "frame-applied") {
      if (messageFrameId !== undefined && messageFrameId === frame?.id
        && messageAttemptId !== undefined && messageAttemptId === activeAttemptId) {
        if (frameTerminalRef.current?.attemptId === messageAttemptId) return;
        frameTerminalRef.current = { attemptId: messageAttemptId, status: "applied" };
        appliedFrameIdRef.current = messageFrameId;
        appliedFrameAttemptIdRef.current = messageAttemptId;
        setFrameState({ status: "applied", frameId: messageFrameId });
        const pending = pendingRuntimeErrorsRef.current;
        pendingRuntimeErrorsRef.current = [];
        if (pending.length > 0) {
          setRuntimeErrorState((current) => pending.reduce(
            (state, error) => ingestRuntimeError(state, error, { runActive: false }),
            current,
          ));
        }
      }
      return;
    }
    if (message.type === "frame-rejected") {
      if (messageFrameId !== undefined && messageFrameId === frame?.id
        && messageAttemptId !== undefined && messageAttemptId === activeAttemptId) {
        if (frameTerminalRef.current?.attemptId === messageAttemptId) return;
        frameTerminalRef.current = { attemptId: messageAttemptId, status: "rejected" };
        appliedFrameIdRef.current = null;
        appliedFrameAttemptIdRef.current = null;
        pendingRuntimeErrorsRef.current = [];
        setFrameState({
          status: "rejected",
          frameId: messageFrameId,
          message: frameRejectionMessage(message),
        });
      }
      return;
    }
    if (frame === null || appliedFrameIdRef.current !== frame.id) return;
    const data = messageData(message);
    if (data === null) return;
    if (data.type === "cleared") {
      setStoredSelection(null);
      setPickerActive(false);
      return;
    }
    setPickerActive(false);
    setStoredSelection({
      type: "design-element",
      id: `${projectId}:${artifactId}:${previewIdentity.targetKey}:${data.locator.designNodeId}`,
      projectId,
      artifactId,
      revisionId: previewIdentity.revisionId,
      targetKey: previewIdentity.targetKey,
      assemblyHash: previewIdentity.assemblyHash,
      frameId: frame?.id ?? "unknown",
      label: data.textPreview ?? data.locator.designNodeId,
      locator: data.locator,
      tag: data.tag,
      text: data.text,
      rect: data.rect,
      instanceId: data.instanceId,
      mutationCapable: data.mutationCapable,
      mutationUnavailableReason: data.mutationCapable
        ? null
        : "Direct edits require a source-backed stable marker. This selection remains available to Artifact Agent Context.",
      textMutationCapable: data.textMutationCapable,
      textMutationUnavailableReason: data.textMutationUnavailableReason,
    });
  }, [artifactId, frame?.id, previewIdentity, projectId]);
  const channel = usePreviewChannel({
    iframeRef,
    previewSrc,
    bridgeNonce: previewIdentity?.bridgeNonce ?? null,
    enabled: enabled && identity !== null,
    onMessage: onBridgeMessage,
  });

  const postBridgeMessage = useCallback((message: Record<string, unknown>): void => {
    if (typeof message.type !== "string") return;
    channel.send(message as { type: string } & Record<string, unknown>);
  }, [channel.send]);

  const postFrameCommand = useCallback((attempt: NonNullable<typeof frameAttemptRef.current>): void => {
    frameAttemptSequenceRef.current += 1;
    const frameAttemptId = `frame-attempt-${frameAttemptSequenceRef.current.toString(36)}`;
    attempt.activeAttemptId = frameAttemptId;
    appliedFrameAttemptIdRef.current = null;
    frameTerminalRef.current = null;
    pendingRuntimeErrorsRef.current = [];
    setRuntimeErrorState(resetRuntimeErrors());
    postBridgeMessage({ ...attempt.command, frameAttemptId });
  }, [postBridgeMessage]);

  useEffect(() => {
    if (!enabled || identity === null || frame === null) {
      appliedFrameIdRef.current = null;
      appliedFrameAttemptIdRef.current = null;
      pendingRuntimeErrorsRef.current = [];
      frameAttemptRef.current = null;
      setFrameState({ status: "idle", frameId: null });
      return;
    }
    const command = buildPreviewFrameCommand(frame);
    if (!command.ok) {
      appliedFrameIdRef.current = null;
      frameAttemptRef.current = null;
      setFrameState({ status: "rejected", frameId: frame.id, message: command.message });
      return;
    }
    if (frameAttemptRef.current?.key !== identity) {
      frameAttemptRef.current = {
        key: identity,
        command: command.command,
        retries: 0,
        reconnects: 0,
        activeAttemptId: null,
      };
    }
    if (!channel.ready) {
      appliedFrameIdRef.current = null;
      setFrameState({
        status: "pending",
        frameId: frame.id,
        ...(frameAttemptRef.current.reconnects > 0 ? { reconnecting: true } : {}),
      });
      return;
    }
    appliedFrameIdRef.current = null;
    appliedFrameAttemptIdRef.current = null;
    const attempt = frameAttemptRef.current.reconnects > 0
      ? 2
      : frameAttemptRef.current.retries > 0
        ? 1
        : 0;
    setFrameState({ status: "applying", frameId: frame.id, attempt });
    postFrameCommand(frameAttemptRef.current);
  }, [channel.generation, channel.ready, enabled, frame, identity, postFrameCommand]);

  useEffect(() => {
    if (identity === null || frame === null) return;
    if (frameState.status === "pending" && frameState.reconnecting) {
      const timer = window.setTimeout(() => {
        const attempt = frameAttemptRef.current;
        if (attempt?.key !== identity || (attempt.activeAttemptId !== null
          && frameTerminalRef.current?.attemptId === attempt.activeAttemptId)) return;
        setFrameState({
          status: "rejected",
          frameId: frame.id,
          message: "The preview bridge did not reconnect in time.",
          retryable: true,
        });
      }, PREVIEW_FRAME_ACK_TIMEOUT_MS);
      return () => window.clearTimeout(timer);
    }
    if (frameState.status !== "applying" || frameState.frameId !== frame.id) return;
    const timer = window.setTimeout(() => {
      const attempt = frameAttemptRef.current;
      if (attempt === null || attempt.key !== identity) return;
      if (attempt.activeAttemptId !== null && frameTerminalRef.current?.attemptId === attempt.activeAttemptId) return;
      if (attempt.retries < 1 && attempt.reconnects === 0) {
        attempt.retries += 1;
        postFrameCommand(attempt);
        setFrameState({ status: "applying", frameId: frame.id, attempt: 1 });
        return;
      }
      if (attempt.reconnects < 1) {
        attempt.reconnects += 1;
        appliedFrameIdRef.current = null;
        appliedFrameAttemptIdRef.current = null;
        pendingRuntimeErrorsRef.current = [];
        setFrameState({ status: "pending", frameId: frame.id, reconnecting: true });
        if (!channel.connect()) {
          setFrameState({
            status: "rejected",
            frameId: frame.id,
            message: "The preview bridge could not reconnect after a missing frame acknowledgement.",
            retryable: true,
          });
        }
        return;
      }
      setFrameState({
        status: "rejected",
        frameId: frame.id,
        message: "The preview did not acknowledge this frame state after retrying.",
        retryable: true,
      });
    }, PREVIEW_FRAME_ACK_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [channel.connect, frame, frameState, identity, postFrameCommand]);

  const retryFrame = useCallback(() => {
    if (!enabled || identity === null || frame === null) return;
    const command = buildPreviewFrameCommand(frame);
    if (!command.ok) {
      setFrameState({ status: "rejected", frameId: frame.id, message: command.message });
      return;
    }
    frameAttemptRef.current = {
      key: identity,
      command: command.command,
      retries: 0,
      reconnects: 0,
      activeAttemptId: null,
    };
    appliedFrameIdRef.current = null;
    appliedFrameAttemptIdRef.current = null;
    pendingRuntimeErrorsRef.current = [];
    setFrameState({ status: "pending", frameId: frame.id, reconnecting: true });
    if (!channel.connect()) {
      setFrameState({
        status: "rejected",
        frameId: frame.id,
        message: "The preview bridge could not reconnect.",
        retryable: true,
      });
    }
  }, [channel.connect, enabled, frame, identity]);

  const clearSelection = useCallback(() => {
    setStoredSelection(null);
    setPickerActive(false);
    postBridgeMessage({ type: "select-mode", on: false });
    postBridgeMessage({ type: "clear" });
  }, [postBridgeMessage]);

  const beginSelection = useCallback(() => {
    if (!enabled || identity === null || frame === null || frameState.status !== "applied"
      || frameState.frameId !== frame.id || appliedFrameIdRef.current !== frame.id) return;
    setStoredSelection(null);
    setPickerActive(true);
    postBridgeMessage({ type: "clear" });
    postBridgeMessage({ type: "select-mode", on: true });
    try {
      iframeRef.current?.focus({ preventScroll: true });
    } catch {
      iframeRef.current?.focus();
    }
  }, [enabled, frame, frameState, identity, iframeRef, postBridgeMessage]);

  const onPreviewLoad = useCallback(() => {
    if (!enabled || identity === null || previewIdentity === null) return;
    appliedFrameIdRef.current = null;
    appliedFrameAttemptIdRef.current = null;
    pendingRuntimeErrorsRef.current = [];
    frameAttemptRef.current = null;
    setStoredSelection(null);
    setRuntimeErrorState(resetRuntimeErrors());
    channel.connect();
    setPickerActive(false);
    postBridgeMessage({ type: "select-mode", on: false });
    postBridgeMessage({ type: "clear" });
  }, [channel.connect, enabled, identity, postBridgeMessage, previewIdentity]);

  useEffect(() => {
    if (!enabled || identity === null || frame === null || frameState.status !== "applied"
      || frameState.frameId !== frame.id || appliedFrameIdRef.current !== frame.id) {
      setStoredSelection(null);
      setPickerActive(false);
      postBridgeMessage({ type: "select-mode", on: false });
      postBridgeMessage({ type: "clear" });
      return;
    }
    setPickerActive(true);
    postBridgeMessage({ type: "clear" });
    postBridgeMessage({ type: "select-mode", on: true });
  }, [enabled, frame, frameState, identity, postBridgeMessage]);

  useEffect(() => {
    if (identity === null) {
      lastIdentityRef.current = null;
      setStoredSelection(null);
      setPickerActive(false);
      appliedFrameIdRef.current = null;
      appliedFrameAttemptIdRef.current = null;
      pendingRuntimeErrorsRef.current = [];
      setFrameState({ status: "idle", frameId: null });
      return;
    }
    if (lastIdentityRef.current !== null && lastIdentityRef.current !== identity) {
      setStoredSelection(null);
      setPickerActive(false);
    }
    lastIdentityRef.current = identity;
  }, [identity]);

  useEffect(() => {
    setRuntimeErrorState(resetRuntimeErrors());
  }, [identity]);

  useEffect(() => {
    if (!enabled) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || isInteractiveTarget(event.target)) return;
      clearSelection();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [clearSelection, enabled]);

  return {
    selection,
    frameState,
    pickerActive: identity !== null
      && channel.ready
      && frame !== null
      && frameState.status === "applied"
      && frameState.frameId === frame.id
      && pickerActive,
    bridgeAvailable: channel.available,
    runtimeErrors: {
      fatal: runtimeErrorState.fatal,
      nonFatal: runtimeErrorState.nonFatal,
    },
    runtimeErrorIdentity: identity !== null && artifactId !== null && previewIdentity !== null && frame !== null
      ? {
          projectId,
          artifactId,
          revisionId: previewIdentity.revisionId,
          targetKey: previewIdentity.targetKey,
          assemblyHash: previewIdentity.assemblyHash,
          frameId: frame.id,
        }
      : null,
    runtimeRepairContext: identity !== null && artifactId !== null && previewIdentity !== null && frame !== null
      ? buildArtifactRuntimeRepairContext(
          [runtimeErrorState.fatal, ...runtimeErrorState.nonFatal].filter(
            (error): error is RuntimeError => error !== null,
          ),
          {
            projectId,
            artifactId,
            revisionId: previewIdentity.revisionId,
            targetKey: previewIdentity.targetKey,
            assemblyHash: previewIdentity.assemblyHash,
            frameId: frame.id,
          },
        )
      : null,
    dismissRuntimeFatal: () => setRuntimeErrorState(dismissRuntimeFatal),
    dismissRuntimeNonFatal: (sig: string) => setRuntimeErrorState((current) => dismissRuntimeNonFatal(current, sig)),
    retryFrame,
    clearSelection,
    beginSelection,
    onPreviewLoad,
  };
}
