import { ArrowLeft, CircleAlert, Play, RotateCw, X } from "lucide-react";
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { useApi } from "../../lib/api-context.tsx";
import type { PreviewTarget, ResolvedPreviewTarget, WorkspaceRenderFrameSpec } from "../../lib/api.ts";
import {
  generatePreviewBridgeNonce,
  previewDocumentSrc,
  usePreviewChannel,
  type PreviewChannelMessage,
} from "../../lib/preview-channel.ts";
import { previewSandboxForSrc } from "../../lib/preview-sandbox.ts";
import { buildPreviewFrameCommand, PREVIEW_FRAME_ACK_TIMEOUT_MS } from "../artifact/usePreviewBridge.ts";
import { useArtifactPreview } from "../artifact/useArtifactPreview.ts";
import {
  buildPrototypeModeCommand,
  parsePrototypeActivation,
  prototypeFlowHealth,
  resolvePrototypeActivation,
  type PrototypeActivationResult,
  type PrototypeFlowSession,
} from "./prototype-flow.ts";
import "./prototype-flow-viewer.css";

const PROTOTYPE_PREPARATION_DEADLINE_MS = 5_000;
const PROTOTYPE_PREPARATION_TIMEOUT_MESSAGE = "The exact Page did not become ready within 5 seconds.";

interface FlowLocation {
  artifactId: string;
  stateKey: string | null;
}

interface FlowSlot {
  id: number;
  location: FlowLocation;
  deadlineAt: number | null;
}

interface NavigationRequest {
  location: FlowLocation;
  history: FlowLocation[];
  transition: { type: "none" | "fade" | "slide"; durationMs: number; easing: string };
}

interface PendingNavigation extends NavigationRequest {
  slotId: number | null;
}

interface FailedNavigation {
  request: NavigationRequest;
  error: string;
}

interface PrototypeFlowFrameHandle {
  applyFrame(
    frame: Readonly<WorkspaceRenderFrameSpec>,
    stateKey: string | null,
    deadlineAt?: number | null,
  ): Promise<void>;
  focus(): void;
}

function reducedMotion(): boolean {
  return typeof window !== "undefined"
    && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim()
    ? error.message
    : "The exact prototype destination could not be prepared.";
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, nested: unknown) => {
    if (nested === null || Array.isArray(nested) || typeof nested !== "object") return nested;
    return Object.fromEntries(
      Object.entries(nested as Record<string, unknown>)
        .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0),
    );
  }) ?? "";
}

function exactFlowTarget(projectId: string, session: PrototypeFlowSession, location: FlowLocation): PreviewTarget {
  return {
    kind: "workspace-flow",
    projectId,
    snapshotId: session.snapshotId,
    startArtifactId: location.artifactId,
    ...(location.stateKey === null ? {} : { stateKey: location.stateKey }),
  };
}

function verifyExactFlowResolution(
  projectId: string,
  session: PrototypeFlowSession,
  location: FlowLocation,
  resolved: ResolvedPreviewTarget,
): void {
  const page = session.pages.find((candidate) => candidate.artifactId === location.artifactId);
  if (page === undefined
    || resolved.requestedKind !== "workspace-flow"
    || resolved.projectId !== projectId
    || resolved.workspaceId !== session.workspaceId
    || resolved.snapshotId !== session.snapshotId
    || resolved.artifactId !== location.artifactId
    || resolved.revisionId !== page.revisionId
    || resolved.stateKey !== location.stateKey
    || (page.renderSpec !== null && canonicalJson(resolved.renderSpec) !== canonicalJson(page.renderSpec))) {
    throw new Error("Resolved preview does not match the exact frozen Page, Revision, state, and RenderSpec.");
  }
}

const PrototypeFlowFrame = forwardRef<PrototypeFlowFrameHandle, {
  projectId: string;
  session: PrototypeFlowSession;
  slot: FlowSlot;
  active: boolean;
  desiredStateKey: string | null;
  transition: NavigationRequest["transition"];
  onActivation: (result: PrototypeActivationResult) => void;
  onPrepared: (slotId: number) => void;
  onPreparationError: (slotId: number, error: string) => void;
}>(function PrototypeFlowFrame({
  projectId,
  session,
  slot,
  active,
  desiredStateKey,
  transition,
  onActivation,
  onPrepared,
  onPreparationError,
}, ref) {
  const page = session.pages.find((candidate) => candidate.artifactId === slot.location.artifactId) ?? session.pages[0]!;
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const mountedRef = useRef(true);
  const attemptRef = useRef<{
    id: string;
    frameId: string;
    command: Record<string, unknown> & { type: string };
    generation: number;
    stateKey: string | null;
    resolve: () => void;
    reject: (error: Error) => void;
    timer: number;
    preparationKey: string;
  } | null>(null);
  const preparedKeyRef = useRef<string | null>(null);
  const target = useMemo(
    () => exactFlowTarget(projectId, session, slot.location),
    [projectId, session, slot.location],
  );
  const preview = useArtifactPreview({
    projectId,
    target,
    expectedArtifactId: page.artifactId,
    expectedRevisionId: page.revisionId,
    expectedWorkspaceId: session.workspaceId,
    ...(page.renderSpec === null ? {} : { expectedRenderSpec: page.renderSpec }),
  });
  const previewSrc = preview.status === "ready" ? previewDocumentSrc(preview.lease.url) : null;
  const bridgeNonce = preview.status === "ready" ? preview.lease.bridgeNonce : null;
  const previewLeaseId = preview.status === "ready" ? preview.lease.leaseId : null;
  const commandState = useMemo(() => {
    try {
      return { command: buildPrototypeModeCommand(session, page.artifactId), error: null };
    } catch (error) {
      return { command: null, error: errorMessage(error) };
    }
  }, [page.artifactId, session]);

  const onBridgeMessage = useCallback((message: PreviewChannelMessage): void => {
    const attempt = attemptRef.current;
    if (attempt !== null
      && message.frameId === attempt.frameId
      && message.frameAttemptId === attempt.id
      && (message.type === "frame-applied" || message.type === "frame-rejected")) {
      window.clearTimeout(attempt.timer);
      attemptRef.current = null;
      if (message.type === "frame-applied") {
        preparedKeyRef.current = attempt.preparationKey;
        attempt.resolve();
      }
      else attempt.reject(new Error(
        typeof message.reason === "string" && message.reason.trim()
          ? message.reason
          : typeof message.error === "string" && message.error.trim()
            ? message.error
          : `Prototype state ${attempt.frameId} was rejected by the exact Page.`,
      ));
      return;
    }
    if (!active || bridgeNonce === null || commandState.error !== null) return;
    const activation = parsePrototypeActivation(message, bridgeNonce);
    if (activation === null) return;
    onActivation(resolvePrototypeActivation(session, page.artifactId, activation));
  }, [active, bridgeNonce, commandState.error, onActivation, page.artifactId, session]);

  const channel = usePreviewChannel({
    iframeRef,
    previewSrc,
    bridgeNonce,
    enabled: preview.status === "ready",
    onMessage: onBridgeMessage,
  });

  const applyFrame = useCallback((
    frame: Readonly<WorkspaceRenderFrameSpec>,
    stateKey: string | null,
    deadlineAt: number | null = null,
  ): Promise<void> => {
    const command = buildPreviewFrameCommand(frame);
    if (!command.ok) return Promise.reject(new Error(command.message));
    if (previewLeaseId === null) return Promise.reject(new Error("The exact Page lease is not ready to apply prototype state."));
    if (!channel.ready) return Promise.reject(new Error("The exact Page bridge is not ready to apply prototype state."));
    if (attemptRef.current !== null) return Promise.reject(new Error("Another prototype state is still being applied."));
    const timeoutMs = deadlineAt === null
      ? PREVIEW_FRAME_ACK_TIMEOUT_MS
      : Math.min(PREVIEW_FRAME_ACK_TIMEOUT_MS, deadlineAt - Date.now());
    if (timeoutMs <= 0) return Promise.reject(new Error(PROTOTYPE_PREPARATION_TIMEOUT_MESSAGE));
    const id = generatePreviewBridgeNonce();
    const preparationKey = `${previewLeaseId}:${channel.generation}:${stateKey ?? "default"}`;
    return new Promise<void>((resolve, reject) => {
      const attempt = {
        id,
        frameId: frame.id,
        command: command.command,
        generation: channel.generation,
        stateKey,
        resolve,
        reject,
        timer: 0,
        preparationKey,
      };
      const timer = window.setTimeout(() => {
        if (attemptRef.current !== attempt) return;
        attemptRef.current = null;
        reject(new Error(`Prototype state ${frame.initialState ?? frame.id} was not acknowledged.`));
      }, timeoutMs);
      attempt.timer = timer;
      attemptRef.current = attempt;
      if (!channel.send({ ...command.command, frameAttemptId: id })) {
        window.clearTimeout(timer);
        attemptRef.current = null;
        reject(new Error("The exact Page bridge could not receive prototype state."));
      }
    });
  }, [channel.generation, channel.ready, channel.send, previewLeaseId]);

  const focus = useCallback(() => {
    try {
      iframeRef.current?.focus({ preventScroll: true });
    } catch {
      iframeRef.current?.focus();
    }
  }, []);

  useImperativeHandle(ref, () => ({ applyFrame, focus }), [applyFrame, focus]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      const attempt = attemptRef.current;
      if (attempt === null) return;
      window.clearTimeout(attempt.timer);
      attemptRef.current = null;
      attempt.reject(new Error("Prototype state application was cancelled."));
    };
  }, []);

  useEffect(() => {
    if (!channel.ready || commandState.command === null) return;
    channel.send({ type: "set-prototype-bindings", bindings: commandState.command.bindings });
  }, [channel.generation, channel.ready, channel.send, commandState]);

  useEffect(() => {
    const attempt = attemptRef.current;
    if (!channel.ready || attempt === null || attempt.generation === channel.generation) return;
    const nextAttemptId = generatePreviewBridgeNonce();
    attempt.id = nextAttemptId;
    attempt.generation = channel.generation;
    attempt.preparationKey = `${previewLeaseId}:${channel.generation}:${attempt.stateKey ?? "default"}`;
    if (channel.send({ ...attempt.command, frameAttemptId: nextAttemptId })) return;
    window.clearTimeout(attempt.timer);
    attemptRef.current = null;
    attempt.reject(new Error("The exact Page bridge could not replay prototype state."));
  }, [channel.generation, channel.ready, channel.send, previewLeaseId]);

  const previewError = preview.status === "error" ? preview.error : null;
  useEffect(() => {
    if (previewError === null) return;
    onPreparationError(slot.id, previewError);
  }, [onPreparationError, previewError, slot.id]);

  useEffect(() => {
    if (slot.deadlineAt === null) return;
    const remaining = Math.max(0, slot.deadlineAt - Date.now());
    const timer = window.setTimeout(() => {
      onPreparationError(slot.id, PROTOTYPE_PREPARATION_TIMEOUT_MESSAGE);
    }, remaining);
    return () => window.clearTimeout(timer);
  }, [onPreparationError, slot.deadlineAt, slot.id]);

  useEffect(() => {
    if (preview.status !== "ready") return;
    const preparationKey = `${preview.lease.leaseId}:${channel.generation}:${desiredStateKey ?? "default"}`;
    if (preparedKeyRef.current === preparationKey) return;
    if (!channel.ready) return;
    const matches = desiredStateKey === null
      ? page.frames?.slice(0, 1) ?? []
      : page.frames?.filter((frame) => frame.initialState === desiredStateKey) ?? [];
    if (desiredStateKey === null && matches.length === 0) {
      preparedKeyRef.current = preparationKey;
      onPrepared(slot.id);
      return;
    }
    if (matches.length !== 1) {
      preparedKeyRef.current = preparationKey;
      onPreparationError(slot.id, `Frozen RenderSpec state ${desiredStateKey} is unavailable.`);
      return;
    }
    // An imperative same-Page navigation owns the bridge until it settles. On
    // reconnect that attempt is replayed above; trying to restore the last
    // committed state at the same time would race it and surface a false
    // "Another prototype state" failure.
    if (attemptRef.current !== null) return;
    void applyFrame(matches[0]!, desiredStateKey, slot.deadlineAt).then(
      () => { if (mountedRef.current) onPrepared(slot.id); },
      (error: unknown) => { if (mountedRef.current) onPreparationError(slot.id, errorMessage(error)); },
    );
  }, [applyFrame, channel.generation, channel.ready, desiredStateKey, onPreparationError, onPrepared, page.frames, preview, slot.deadlineAt, slot.id]);

  const loading = preview.status === "idle" || preview.status === "loading";
  return (
    <div
      className="prototype-flow-viewer__frame-slot"
      data-active={active ? "true" : "false"}
      data-transition={active ? transition.type : "none"}
      aria-hidden={active ? undefined : true}
      style={{
        "--prototype-transition-ms": `${transition.durationMs}ms`,
        "--prototype-transition-easing": transition.easing,
      } as React.CSSProperties}
    >
      {loading ? (
        <div className="prototype-flow-viewer__message" role={active ? "status" : undefined} aria-label={active ? "Preparing prototype flow" : undefined}>
          <span className="prototype-flow-viewer__spinner" aria-hidden />
          <strong>Preparing exact Page</strong>
          <p>Resolving {page.revisionId} inside {session.snapshotId}.</p>
        </div>
      ) : preview.status === "error" ? (
        <div className="prototype-flow-viewer__message prototype-flow-viewer__message--error" role={active ? "status" : undefined}>
          <CircleAlert aria-hidden size={18} />
          <strong>Flow preview unavailable</strong>
          <p>{preview.error}</p>
        </div>
      ) : (
        <iframe
          ref={iframeRef}
          title={`${page.name} flow preview`}
          src={previewSrc!}
          sandbox={previewSandboxForSrc(previewSrc)}
          onLoad={channel.connect}
        />
      )}
    </div>
  );
});

function PrototypeFlowViewerSession({
  projectId,
  session,
  onClose,
}: {
  projectId: string;
  session: PrototypeFlowSession;
  onClose: () => void;
}) {
  const api = useApi();
  const rootRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  const frameHandlesRef = useRef(new Map<number, PrototypeFlowFrameHandle>());
  const nextSlotIdRef = useRef(1);
  const samePageAbortRef = useRef<AbortController | null>(null);
  const pendingRef = useRef<PendingNavigation | null>(null);
  const focusAfterCommitSlotRef = useRef<number | null>(null);
  const startLocation = useMemo<FlowLocation>(
    () => ({ artifactId: session.startArtifactId, stateKey: null }),
    [session.startArtifactId],
  );
  const [history, setHistory] = useState<FlowLocation[]>([startLocation]);
  const [slots, setSlots] = useState<FlowSlot[]>(() => [{
    id: 0,
    location: startLocation,
    deadlineAt: Date.now() + PROTOTYPE_PREPARATION_DEADLINE_MS,
  }]);
  const [activeSlotId, setActiveSlotId] = useState(0);
  const [pending, setPending] = useState<PendingNavigation | null>(null);
  const [failedNavigation, setFailedNavigation] = useState<FailedNavigation | null>(null);
  const [activePreparationFailure, setActivePreparationFailure] = useState<{
    slotId: number;
    error: string;
  } | null>(null);
  const [blockedReason, setBlockedReason] = useState<string | null>(null);
  const [transition, setTransition] = useState<NavigationRequest["transition"]>({
    type: "none",
    durationMs: 0,
    easing: "ease",
  });
  pendingRef.current = pending;
  const currentLocation = history.at(-1) ?? startLocation;
  const currentPage = session.pages.find((page) => page.artifactId === currentLocation.artifactId) ?? session.pages[0]!;
  const health = useMemo(
    () => prototypeFlowHealth(session, currentLocation.artifactId),
    [currentLocation.artifactId, session],
  );
  const commandError = useMemo(() => {
    try {
      buildPrototypeModeCommand(session, currentLocation.artifactId);
      return null;
    } catch (error) {
      return `Flow interactions unavailable. ${errorMessage(error)}`;
    }
  }, [currentLocation.artifactId, session]);
  onCloseRef.current = onClose;

  useEffect(() => {
    rootRef.current?.focus();
    const escape = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onCloseRef.current();
    };
    window.addEventListener("keydown", escape, true);
    return () => window.removeEventListener("keydown", escape, true);
  }, []);

  useEffect(() => () => samePageAbortRef.current?.abort(), []);

  useEffect(() => {
    if (focusAfterCommitSlotRef.current !== activeSlotId) return;
    focusAfterCommitSlotRef.current = null;
    frameHandlesRef.current.get(activeSlotId)?.focus();
  }, [activeSlotId, slots]);

  const failNavigation = useCallback((request: NavigationRequest, error: string): void => {
    setPending(null);
    setFailedNavigation({ request, error });
  }, []);

  const prepareSamePage = useCallback(async (request: NavigationRequest): Promise<void> => {
    if (request.location.stateKey === currentLocation.stateKey) {
      setHistory(request.history);
      setTransition(request.transition);
      setPending(null);
      return;
    }
    const page = session.pages.find((candidate) => candidate.artifactId === request.location.artifactId);
    const handle = frameHandlesRef.current.get(activeSlotId);
    if (page === undefined || handle === undefined) {
      failNavigation(request, "The current exact Page is not ready to apply prototype state.");
      return;
    }
    const frame = request.location.stateKey === null
      ? page.frames?.[0] ?? null
      : page.frames?.find((candidate) => candidate.initialState === request.location.stateKey) ?? null;
    if (frame === null) {
      failNavigation(request, `Frozen RenderSpec state ${request.location.stateKey ?? "default"} is unavailable.`);
      return;
    }
    samePageAbortRef.current?.abort();
    const controller = new AbortController();
    samePageAbortRef.current = controller;
    const timeoutError = new Error(PROTOTYPE_PREPARATION_TIMEOUT_MESSAGE);
    const deadlineAt = Date.now() + PROTOTYPE_PREPARATION_DEADLINE_MS;
    let deadlineTimer = 0;
    const deadline = new Promise<never>((_resolve, reject) => {
      deadlineTimer = window.setTimeout(() => {
        controller.abort(timeoutError);
        reject(timeoutError);
      }, PROTOTYPE_PREPARATION_DEADLINE_MS);
    });
    setPending({ ...request, slotId: null });
    setFailedNavigation(null);
    try {
      const resolved = await Promise.race([
        api.resolvePreviewTarget(
          projectId,
          exactFlowTarget(projectId, session, request.location),
          controller.signal,
        ),
        deadline,
      ]);
      controller.signal.throwIfAborted();
      verifyExactFlowResolution(projectId, session, request.location, resolved);
      await Promise.race([
        handle.applyFrame(frame, request.location.stateKey, deadlineAt),
        deadline,
      ]);
      controller.signal.throwIfAborted();
      setHistory(request.history);
      setTransition(request.transition);
      setPending(null);
      setBlockedReason(null);
    } catch (error) {
      if (controller.signal.aborted) {
        if (controller.signal.reason === timeoutError) failNavigation(request, timeoutError.message);
        return;
      }
      failNavigation(request, errorMessage(error));
    } finally {
      window.clearTimeout(deadlineTimer);
      if (samePageAbortRef.current === controller) samePageAbortRef.current = null;
    }
  }, [activeSlotId, api, currentLocation.stateKey, failNavigation, projectId, session]);

  const beginNavigation = useCallback((request: NavigationRequest): void => {
    if (pending !== null) return;
    setBlockedReason(null);
    setFailedNavigation(null);
    if (request.location.artifactId === currentLocation.artifactId) {
      void prepareSamePage(request);
      return;
    }
    const slotId = nextSlotIdRef.current;
    nextSlotIdRef.current += 1;
    const deadlineAt = Date.now() + PROTOTYPE_PREPARATION_DEADLINE_MS;
    setSlots((current) => [
      ...current.filter((slot) => slot.id === activeSlotId),
      {
        id: slotId,
        location: request.location,
        deadlineAt,
      },
    ]);
    setPending({ ...request, slotId });
  }, [activeSlotId, currentLocation.artifactId, pending, prepareSamePage]);

  const onActivation = useCallback((result: PrototypeActivationResult): void => {
    if (pending !== null) return;
    if (result.kind === "blocked") {
      setBlockedReason(result.reason);
      return;
    }
    const motionOff = reducedMotion();
    const location = { artifactId: result.targetArtifactId, stateKey: result.targetState };
    beginNavigation({
      location,
      history: [...history, location],
      transition: {
        type: motionOff ? "none" : result.transition.type,
        durationMs: motionOff ? 0 : result.transition.durationMs,
        easing: result.transition.easing ?? "ease",
      },
    });
  }, [beginNavigation, history, pending]);

  const onPrepared = useCallback((slotId: number): void => {
    const current = pendingRef.current;
    if (current?.slotId !== slotId) {
      if (slotId !== activeSlotId) return;
      setSlots((all) => all.map((slot) => slot.id === slotId ? { ...slot, deadlineAt: null } : slot));
      setActivePreparationFailure((failure) => failure?.slotId === slotId ? null : failure);
      return;
    }
    pendingRef.current = null;
    // React removes the outgoing slot and moves the prepared iframe during the
    // following commit. Chromium drops focus when that DOM move happens, so
    // focus the stable active iframe from the post-commit effect above.
    focusAfterCommitSlotRef.current = slotId;
    setActiveSlotId(slotId);
    setHistory(current.history);
    setTransition(current.transition);
    setSlots((all) => all
      .filter((slot) => slot.id === slotId)
      .map((slot) => ({ ...slot, deadlineAt: null })));
    setActivePreparationFailure(null);
    setFailedNavigation(null);
    setPending(null);
  }, [activeSlotId]);

  const onPreparationError = useCallback((slotId: number, error: string): void => {
    const current = pendingRef.current;
    if (current?.slotId !== slotId) {
      if (slotId !== activeSlotId) return;
      setSlots((all) => all.map((slot) => slot.id === slotId ? { ...slot, deadlineAt: null } : slot));
      setActivePreparationFailure((failure) => (
        failure?.slotId === slotId && failure.error === error ? failure : { slotId, error }
      ));
      return;
    }
    pendingRef.current = null;
    setSlots((all) => all.filter((slot) => slot.id !== slotId));
    setFailedNavigation({ request: current, error });
    setPending(null);
  }, [activeSlotId]);

  const retryActivePreparation = useCallback((): void => {
    if (pendingRef.current !== null) return;
    const slotId = nextSlotIdRef.current;
    nextSlotIdRef.current += 1;
    samePageAbortRef.current?.abort();
    samePageAbortRef.current = null;
    pendingRef.current = null;
    setActiveSlotId(slotId);
    setSlots([{
      id: slotId,
      location: currentLocation,
      deadlineAt: Date.now() + PROTOTYPE_PREPARATION_DEADLINE_MS,
    }]);
    setTransition({ type: "none", durationMs: 0, easing: "ease" });
    setActivePreparationFailure(null);
    setFailedNavigation(null);
    setBlockedReason(null);
  }, [currentLocation]);

  const visibleError = activePreparationFailure?.error ?? failedNavigation?.error ?? commandError ?? blockedReason;

  return (
    <section
      ref={rootRef}
      tabIndex={-1}
      className="prototype-flow-viewer"
      role="region"
      aria-label="Prototype flow viewer"
    >
      <header className="prototype-flow-viewer__header app-drag">
        <div className="prototype-flow-viewer__identity">
          <span className="prototype-flow-viewer__mark" aria-hidden><Play size={12} fill="currentColor" /></span>
          <div>
            <h1>Prototype flow</h1>
            <p>Exact Snapshot playback</p>
          </div>
        </div>
        <div className="prototype-flow-viewer__controls app-no-drag">
          <button
            type="button"
            aria-label="Back in prototype flow"
            disabled={history.length <= 1 || pending !== null}
            onClick={() => {
              const nextHistory = history.slice(0, -1);
              const location = nextHistory.at(-1);
              if (location === undefined) return;
              beginNavigation({
                location,
                history: nextHistory,
                transition: { type: "none", durationMs: 0, easing: "ease" },
              });
            }}
          >
            <ArrowLeft aria-hidden size={14} />
            <span className="prototype-flow-viewer__back-label">Back</span>
          </button>
          <label>
            <span>Start Page</span>
            <select
              aria-label="Prototype flow start Page"
              value={currentPage.artifactId}
              disabled={pending !== null}
              onChange={(event) => {
                const location = { artifactId: event.currentTarget.value, stateKey: null };
                beginNavigation({
                  location,
                  history: [location],
                  transition: { type: "none", durationMs: 0, easing: "ease" },
                });
              }}
            >
              {session.pages.map((page) => <option key={page.artifactId} value={page.artifactId}>{page.name}</option>)}
            </select>
          </label>
          <button type="button" aria-label="Close prototype flow" onClick={onClose}>
            <X aria-hidden size={14} />
          </button>
        </div>
      </header>

      <div className="prototype-flow-viewer__body">
        <main className="prototype-flow-viewer__stage">
          <div className="prototype-flow-viewer__metadata" aria-label="Frozen prototype identity">
            <strong>{currentPage.name}</strong>
            <span title={currentPage.revisionId}>Revision {currentPage.revisionId}</span>
            {currentLocation.stateKey === null ? null : <span title={currentLocation.stateKey}>State {currentLocation.stateKey}</span>}
            <span title={session.snapshotId}>Snapshot {session.snapshotId}</span>
          </div>

          {slots.map((slot) => (
            <PrototypeFlowFrame
              key={slot.id}
              ref={(handle) => {
                if (handle === null) frameHandlesRef.current.delete(slot.id);
                else frameHandlesRef.current.set(slot.id, handle);
              }}
              projectId={projectId}
              session={session}
              slot={slot}
              active={slot.id === activeSlotId}
              desiredStateKey={slot.id === activeSlotId ? currentLocation.stateKey : slot.location.stateKey}
              transition={slot.id === activeSlotId ? transition : { type: "none", durationMs: 0, easing: "ease" }}
              onActivation={onActivation}
              onPrepared={onPrepared}
              onPreparationError={onPreparationError}
            />
          ))}

          {pending !== null ? (
            <div className="prototype-flow-viewer__pending" role="status" aria-label="Preparing prototype navigation">
              <span className="prototype-flow-viewer__spinner" aria-hidden />
              Preparing {session.pages.find((page) => page.artifactId === pending.location.artifactId)?.name ?? "exact Page"}
              {pending.location.stateKey === null ? "" : ` · ${pending.location.stateKey}`}
            </div>
          ) : null}

          {visibleError !== null ? (
            <div className="prototype-flow-viewer__blocked" role="alert">
              <CircleAlert aria-hidden size={14} />
              <span>{visibleError}</span>
              {activePreparationFailure !== null ? (
                <button
                  type="button"
                  aria-label="Retry exact Page preparation"
                  disabled={pending !== null}
                  onClick={retryActivePreparation}
                >
                  <RotateCw aria-hidden size={12} />
                  Retry
                </button>
              ) : failedNavigation !== null ? (
                <button
                  type="button"
                  aria-label="Retry prototype navigation"
                  onClick={() => beginNavigation(failedNavigation.request)}
                >
                  <RotateCw aria-hidden size={12} />
                  Retry
                </button>
              ) : commandError === null ? (
                <button type="button" aria-label="Dismiss blocked prototype navigation" onClick={() => setBlockedReason(null)}>
                  <X aria-hidden size={12} />
                </button>
              ) : null}
            </div>
          ) : null}
        </main>

        <details className="prototype-flow-viewer__health" aria-label="Flow health" open>
          <summary>
            <div>
              <h2>Flow health</h2>
              <p>{health.interactive} live · {health.planned} planned · {health.broken} broken</p>
            </div>
            <span data-state={health.broken > 0 ? "attention" : health.planned > 0 ? "planned" : "healthy"} />
          </summary>
          <div className="prototype-flow-viewer__health-content">
            {health.items.length === 0 ? (
              <p className="prototype-flow-viewer__empty-health">No outgoing flow connections from this Page.</p>
            ) : (
              <ol>
                {health.items.map((item) => (
                  <li key={item.edgeId} data-status={item.status}>
                    <span aria-hidden />
                    <div>
                      <strong>{item.label}</strong>
                      <p>{item.detail}</p>
                    </div>
                  </li>
                ))}
              </ol>
            )}
            <footer>
              <span>Frozen</span>
              <code title={session.snapshotId}>{session.snapshotId}</code>
            </footer>
          </div>
        </details>
      </div>
    </section>
  );
}

export function PrototypeFlowViewer(props: {
  projectId: string;
  session: PrototypeFlowSession;
  onClose: () => void;
}) {
  const identity = `${props.session.snapshotId}\u0000${props.session.graphRevision}\u0000${props.session.startArtifactId}`;
  return <PrototypeFlowViewerSession key={identity} {...props} />;
}
