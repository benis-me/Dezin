import "./research-resource-viewer.css";

import {
  ArrowLeft,
  ArrowUpRight,
  BookOpenText,
  Check,
  CircleAlert,
  CircleCheck,
  ExternalLink,
  Lightbulb,
  LoaderCircle,
  ShieldCheck,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";

import { useApi } from "../../lib/api-context.tsx";
import type {
  ReadyProjectWorkspacePayload,
  ResearchResourceRevisionView,
} from "../../lib/api.ts";
import { ResourceRevisionHistory } from "../resource/ResourceRevisionHistory.tsx";

type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | {
      status: "ready";
      view: ResearchResourceRevisionView;
      headRevisionId: string | null;
      observationKey: string;
    };

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim()
    ? error.message
    : "This Research Revision could not be opened.";
}

export function ResearchResourceViewer({
  projectId,
  resourceId,
  requestedRevisionId,
  workspace,
  onBack,
  onOpenRevision,
  onReturnToHead,
  onPlanCreated,
  onWorkspaceChanged,
}: {
  projectId: string;
  resourceId: string;
  requestedRevisionId: string | null;
  workspace: ReadyProjectWorkspacePayload;
  onBack: () => void;
  onOpenRevision: (revisionId: string) => void;
  onReturnToHead?: () => void;
  onPlanCreated: (planId: string) => void;
  onWorkspaceChanged: () => void;
}) {
  const api = useApi();
  const activeResourceRevisionId = workspace.activeSnapshot.resourceRevisions[resourceId] ?? null;
  const observationKey = `${workspace.activeSnapshot.id}\0${activeResourceRevisionId ?? ""}`;
  const [load, setLoad] = useState<LoadState>({ status: "loading" });
  const [selectedDirectionId, setSelectedDirectionId] = useState<string | null>(null);
  const [targetArtifactId, setTargetArtifactId] = useState<string>("");
  const [hypothesisConfirmed, setHypothesisConfirmed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [creatingTarget, setCreatingTarget] = useState<"page" | "component" | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [loadRetryEpoch, setLoadRetryEpoch] = useState(0);
  const loadEpoch = useRef(0);

  useEffect(() => {
    const epoch = ++loadEpoch.current;
    setLoad({ status: "loading" });
    setSelectedDirectionId(null);
    setHypothesisConfirmed(false);
    setSubmitError(null);
    const readExact = async (attempt = 0): Promise<ResearchResourceRevisionView> => {
      const resource = await api.getResource(projectId, resourceId);
      const revisionId = requestedRevisionId ?? resource.headRevisionId;
      if (resource.id !== resourceId || resource.workspaceId !== workspace.workspace.id || resource.kind !== "research") {
        throw new Error("This Resource is not the active Workspace Research bundle.");
      }
      if (resource.archivedAt !== null && requestedRevisionId === null) {
        throw new Error("Archived Research has no writable Current Head. Open an exact immutable Revision from history.");
      }
      if (revisionId === null) throw new Error("Research is still awaiting its first immutable Revision.");
      const view = await api.getResearchResourceRevision(projectId, resourceId, revisionId);
      if (view.resource.id !== resourceId || view.resource.workspaceId !== resource.workspaceId
        || view.resource.kind !== "research" || view.revision.id !== revisionId
        || view.revision.resourceId !== resourceId) {
        throw new Error("Research Revision identity changed while it was loading.");
      }
      if (requestedRevisionId === null && view.observed.headRevisionId !== revisionId) {
        if (attempt === 0) return readExact(1);
        throw new Error("Current Research Head changed while it was opening. Try again.");
      }
      if (view.resource.headRevisionId !== view.observed.headRevisionId) {
        throw new Error("Research Revision identity changed while it was loading.");
      }
      if (view.observed.snapshotId !== workspace.activeSnapshot.id
        || (activeResourceRevisionId !== null && view.observed.headRevisionId !== activeResourceRevisionId)) {
        throw new Error("Research observation no longer matches the active Workspace.");
      }
      return view;
    };
    void readExact().then((view) => {
      if (epoch !== loadEpoch.current) return;
      setLoad({
        status: "ready",
        view,
        headRevisionId: view.observed.headRevisionId,
        observationKey,
      });
      setSelectedDirectionId(view.directions[0]?.id ?? null);
    }).catch((error: unknown) => {
      if (epoch === loadEpoch.current) setLoad({ status: "error", message: errorMessage(error) });
    });
    return () => {
      if (epoch === loadEpoch.current) loadEpoch.current += 1;
    };
  }, [
    activeResourceRevisionId,
    api,
    loadRetryEpoch,
    observationKey,
    projectId,
    requestedRevisionId,
    resourceId,
    workspace.activeSnapshot.id,
    workspace.workspace.id,
  ]);

  const targetArtifacts = useMemo(() => {
    const resourceNode = workspace.graph.nodes.find((node) => node.kind === "resource" && node.resourceId === resourceId);
    const relatedIds = new Set(workspace.graph.edges.flatMap((edge) => {
      if (edge.kind !== "informs" || edge.sourceNodeId !== resourceNode?.id) return [];
      const target = workspace.graph.nodes.find((node) => node.id === edge.targetNodeId && node.kind !== "resource");
      return target?.kind === "resource" ? [] : target ? [target.artifactId] : [];
    }));
    const related = workspace.artifacts.filter((artifact) => relatedIds.has(artifact.id));
    return related.length > 0 ? related : workspace.artifacts;
  }, [resourceId, workspace.artifacts, workspace.graph.edges, workspace.graph.nodes]);

  useEffect(() => {
    if (targetArtifactId && targetArtifacts.some((artifact) => artifact.id === targetArtifactId)) return;
    const headless = targetArtifacts.find((artifact) => workspace.activeSnapshot.artifactRevisions[artifact.id] === null);
    setTargetArtifactId(headless?.id ?? targetArtifacts[0]?.id ?? "");
  }, [targetArtifactId, targetArtifacts, workspace.activeSnapshot.artifactRevisions]);

  const currentLoad: LoadState = load.status === "ready" && load.observationKey !== observationKey
    ? { status: "loading" }
    : load;

  if (currentLoad.status === "loading") {
    return (
      <section className="dezin-research-viewer dezin-research-viewer--state" aria-label="Research viewer">
        <LoaderCircle aria-hidden className="dezin-research-viewer__spinner" />
        <strong>Opening immutable Research</strong>
        <span>Verifying its exact Revision and evidence receipts…</span>
      </section>
    );
  }
  if (currentLoad.status === "error") {
    return (
      <section className="dezin-research-viewer dezin-research-viewer--state" aria-label="Research viewer">
        <CircleAlert aria-hidden />
        <strong>Research unavailable</strong>
        <span role="alert">{currentLoad.message}</span>
        <button type="button" onClick={() => setLoadRetryEpoch((value) => value + 1)}>Try again</button>
        <button type="button" onClick={onBack}>Back to canvas</button>
      </section>
    );
  }

  const { view, headRevisionId } = currentLoad;
  const archived = view.resource.archivedAt !== null;
  const selectedDirection = view.directions.find((direction) => direction.id === selectedDirectionId) ?? null;
  const requiresConfirmation = selectedDirection?.evidenceStatus === "hypothesis";
  const canCreateIntent = !archived && selectedDirection !== null && targetArtifactId.length > 0
    && activeResourceRevisionId !== null
    && view.observed.headRevisionId === activeResourceRevisionId
    && view.observed.snapshotId === workspace.activeSnapshot.id
    && (!requiresConfirmation || hypothesisConfirmed) && !submitting;

  const selectDirection = (directionId: string): void => {
    setSelectedDirectionId(directionId);
    setHypothesisConfirmed(false);
    setSubmitError(null);
  };

  const handleDirectionKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>, index: number): void => {
    let nextIndex: number | null = null;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      nextIndex = (index + 1) % view.directions.length;
    } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      nextIndex = (index - 1 + view.directions.length) % view.directions.length;
    } else if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = view.directions.length - 1;
    }
    if (nextIndex === null || nextIndex < 0) return;
    event.preventDefault();
    const radios = event.currentTarget.closest('[role="radiogroup"]')
      ?.querySelectorAll<HTMLButtonElement>('[role="radio"]');
    selectDirection(view.directions[nextIndex]!.id);
    radios?.item(nextIndex).focus();
  };

  const createIntent = async (): Promise<void> => {
    if (!canCreateIntent || selectedDirection === null) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const result = await api.createResearchDirectionArtifactIntent(
        projectId,
        view.resource.id,
        view.revision.id,
        selectedDirection.id,
        {
          selectionRequestId: `selection-${globalThis.crypto.randomUUID().toLowerCase()}`,
          artifactId: targetArtifactId,
          expectedResourceHeadRevisionId: activeResourceRevisionId!,
          expectedGraphRevision: workspace.graph.revision,
          expectedSnapshotId: workspace.activeSnapshot.id,
          expectedLayoutChecksum: workspace.layout.checksum,
          confirmHypothesis: requiresConfirmation && hypothesisConfirmed,
        },
      );
      onPlanCreated(result.plan.id);
    } catch (error) {
      setSubmitError(errorMessage(error));
    } finally {
      setSubmitting(false);
    }
  };

  const createArtifactTarget = async (kind: "page" | "component"): Promise<void> => {
    if (creatingTarget !== null) return;
    setCreatingTarget(kind);
    setSubmitError(null);
    try {
      const suffix = globalThis.crypto.randomUUID().toLowerCase();
      const directionName = selectedDirection?.title.trim() || "Research direction";
      await api.applyWorkspaceGraphCommands(projectId, {
        baseGraphRevision: workspace.graph.revision,
        expectedSnapshotId: workspace.activeSnapshot.id,
        commands: [{
          id: `command-${suffix}`,
          type: "add-node",
          node: {
            id: `node-${suffix}`,
            kind,
            name: `${directionName} ${kind === "page" ? "page" : "component"}`,
            artifactId: `artifact-${suffix}`,
            createIdentity: { initialTrackId: `track-${suffix}` },
          },
        }],
      });
      onWorkspaceChanged();
    } catch (error) {
      setSubmitError(errorMessage(error));
    } finally {
      setCreatingTarget(null);
    }
  };

  return (
    <section className="dezin-research-viewer" aria-labelledby="research-viewer-title">
      <header className="dezin-research-viewer__header">
        <button type="button" className="dezin-research-viewer__back" onClick={onBack} aria-label="Back to project canvas">
          <ArrowLeft size={15} aria-hidden />
        </button>
        <div className="dezin-research-viewer__identity">
          <span><BookOpenText size={13} aria-hidden /> Research</span>
          <h1 id="research-viewer-title">{view.resource.title}</h1>
        </div>
        <ResourceRevisionHistory
          className="dezin-research-viewer__history"
          projectId={projectId}
          resourceId={resourceId}
          current={view.revision}
          headRevisionId={archived ? null : headRevisionId}
          pinned={requestedRevisionId !== null}
          onOpenRevision={onOpenRevision}
          onReturnToHead={onReturnToHead ?? onBack}
        />
      </header>

      <div className="dezin-research-viewer__scroll">
        <div className="dezin-research-viewer__document">
          <section className="dezin-research-viewer__summary" aria-labelledby="research-summary-title">
            <div>
              <span className="dezin-research-viewer__eyebrow">Decision brief</span>
              <h2 id="research-summary-title">{view.executiveSummary}</h2>
            </div>
            <div className="dezin-research-viewer__quality" data-quality={view.qualityState}>
              {view.qualityState === "grounded" ? <ShieldCheck aria-hidden /> : <CircleAlert aria-hidden />}
              <span>{view.qualityState === "grounded" ? "Grounded" : "Needs review"}</span>
              <small>{view.evidenceDirectionCount} evidence · {view.hypothesisDirectionCount} hypothesis</small>
            </div>
          </section>

          <section className="dezin-research-viewer__section" aria-labelledby="research-directions-title">
            <div className="dezin-research-viewer__section-heading">
              <div>
                <span>Choose before generation</span>
                <h2 id="research-directions-title">Design directions</h2>
              </div>
              <p>The selection is sealed as an exact Resource, Revision, and direction tuple in a new Artifact plan.</p>
            </div>
            <div className="dezin-research-viewer__directions" role="radiogroup" aria-label="Research design directions">
              {view.directions.map((direction, index) => {
                const active = selectedDirectionId === direction.id;
                const linkedFindings = direction.findingIds.flatMap((findingId) => {
                  const finding = view.findings.find((candidate) => candidate.id === findingId);
                  return finding ? [finding] : [];
                });
                const linkedSourceIds = new Set(linkedFindings.flatMap((finding) => finding.sourceIds));
                const linkedSources = view.sources.filter((source) => linkedSourceIds.has(source.id));
                return (
                  <article className="dezin-research-direction-card" key={direction.id} data-active={active || undefined}>
                    <button
                      type="button"
                      role="radio"
                      aria-checked={active}
                      tabIndex={active ? 0 : -1}
                      className="dezin-research-direction"
                      data-active={active || undefined}
                      data-evidence={direction.evidenceStatus}
                      onClick={() => selectDirection(direction.id)}
                      onKeyDown={(event) => handleDirectionKeyDown(event, index)}
                    >
                      <span className="dezin-research-direction__index">0{index + 1}</span>
                      <span className="dezin-research-direction__status">
                        {direction.evidenceStatus === "evidence" ? <CircleCheck aria-hidden /> : <Lightbulb aria-hidden />}
                        {direction.evidenceStatus}
                      </span>
                      <strong>{direction.title}</strong>
                      <span className="dezin-research-direction__thesis">{direction.thesis}</span>
                      <span className="dezin-research-direction__label">Visual language</span>
                      <span className="dezin-research-direction__tokens">
                        {direction.visualLanguage.map((item) => <i key={item}>{item}</i>)}
                      </span>
                      <span className="dezin-research-direction__risk">Risk · {direction.risks[0]}</span>
                      <span className="dezin-research-direction__select">
                        {active ? <><Check size={13} aria-hidden /> Selected</> : <>Select direction <ArrowUpRight size={13} aria-hidden /></>}
                      </span>
                    </button>
                    <details className="dezin-research-direction__evidence">
                      <summary>
                        Evidence chain · {linkedFindings.length} {linkedFindings.length === 1 ? "finding" : "findings"} · {linkedSources.length} {linkedSources.length === 1 ? "source" : "sources"}
                      </summary>
                      <div>
                        {linkedFindings.map((finding) => (
                          <article key={finding.id} data-evidence={finding.evidenceStatus}>
                            <span>{finding.evidenceStatus}</span>
                            <p>{finding.statement}</p>
                          </article>
                        ))}
                        <p className="dezin-research-direction__source-chips">
                          {linkedSources.map((source) => (
                            <span key={source.id} data-verification={source.verification} title={`Receipt ${source.receiptId}`}>
                              {source.title} · {source.verification}
                            </span>
                          ))}
                        </p>
                      </div>
                    </details>
                  </article>
                );
              })}
            </div>
          </section>

          <section className="dezin-research-viewer__section" aria-labelledby="research-findings-title">
            <div className="dezin-research-viewer__section-heading">
              <div>
                <span>Claim-level provenance</span>
                <h2 id="research-findings-title">Findings</h2>
              </div>
              <p>Evidence and hypotheses remain visibly distinct all the way into the design decision.</p>
            </div>
            <div className="dezin-research-viewer__findings">
              {view.findings.map((finding) => (
                <article key={finding.id} data-evidence={finding.evidenceStatus}>
                  <span>{finding.evidenceStatus} · {finding.confidence} confidence</span>
                  <h3>{finding.statement}</h3>
                  <p>{finding.implication}</p>
                  <small>{finding.groundedness.rationale}</small>
                </article>
              ))}
            </div>
          </section>

          <div className="dezin-research-viewer__lower-grid">
            <section className="dezin-research-viewer__section" aria-labelledby="research-sources-title">
              <div className="dezin-research-viewer__section-heading">
                <div>
                  <span>Verified material</span>
                  <h2 id="research-sources-title">Sources</h2>
                </div>
              </div>
              <div className="dezin-research-viewer__sources">
                {view.sources.map((source) => (
                  <article key={source.id} data-verification={source.verification}>
                    <div>
                      <span>{source.kind}</span>
                      <strong>{source.title}</strong>
                    </div>
                    <span className="dezin-research-viewer__source-state">
                      {source.verification === "verified" ? <CircleCheck aria-hidden /> : <CircleAlert aria-hidden />}
                      {source.verification}
                    </span>
                    <blockquote>{source.excerpt}</blockquote>
                    {source.kind === "web" ? (
                      <a href={source.locator} target="_blank" rel="noreferrer">
                        Open source <ExternalLink size={11} aria-hidden />
                      </a>
                    ) : <small>{source.locator}</small>}
                    <code className="dezin-research-viewer__receipt">Receipt · {source.receiptId}</code>
                  </article>
                ))}
              </div>
            </section>

            <section className="dezin-research-viewer__section" aria-labelledby="research-questions-title">
              <div className="dezin-research-viewer__section-heading">
                <div>
                  <span>Unresolved</span>
                  <h2 id="research-questions-title">Open questions</h2>
                </div>
              </div>
              {view.openQuestions.length > 0 ? (
                <ol className="dezin-research-viewer__questions">
                  {view.openQuestions.map((question) => <li key={question}>{question}</li>)}
                </ol>
              ) : <p className="dezin-research-viewer__empty">No unresolved questions in this Revision.</p>}
            </section>
          </div>
        </div>
      </div>

      {archived ? (
        <footer
          className="dezin-research-viewer__handoff dezin-research-viewer__handoff--readonly"
          aria-label="Archived Research Revision"
        >
          <div>
            <span>Archived Revision</span>
            <strong>Read-only research record</strong>
            <small>Immutable evidence remains available; generation actions are disabled.</small>
          </div>
        </footer>
      ) : (
      <footer className="dezin-research-viewer__handoff" aria-label="Create Artifact generation intent">
        <div>
          <span>Selected direction</span>
          <strong>{selectedDirection?.title ?? "Choose a direction"}</strong>
          {selectedDirection ? <small>{view.resource.id} · Revision {view.revision.sequence} · {selectedDirection.id}</small> : null}
        </div>
        {targetArtifacts.length > 0 ? (
          <label className="dezin-research-viewer__target">
            <span>Apply to artifact</span>
            <select
              aria-label="Artifact target"
              value={targetArtifactId}
              onChange={(event) => setTargetArtifactId(event.target.value)}
            >
              {targetArtifacts.map((artifact) => (
                <option key={artifact.id} value={artifact.id}>
                  {artifact.name} · {workspace.activeSnapshot.artifactRevisions[artifact.id] === null ? "new" : "revise"}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <div className="dezin-research-viewer__create-target" role="group" aria-label="Create an Artifact target">
            <span>No Artifact target yet</span>
            <button type="button" disabled={creatingTarget !== null} onClick={() => void createArtifactTarget("page")}>
              {creatingTarget === "page" ? "Creating…" : "Create Page"}
            </button>
            <button type="button" disabled={creatingTarget !== null} onClick={() => void createArtifactTarget("component")}>
              {creatingTarget === "component" ? "Creating…" : "Create Component"}
            </button>
          </div>
        )}
        {requiresConfirmation ? (
          <label className="dezin-research-viewer__confirm">
            <input
              type="checkbox"
              checked={hypothesisConfirmed}
              onChange={(event) => setHypothesisConfirmed(event.target.checked)}
            />
            <span>I understand this direction depends on {selectedDirection.hypothesisFindingIds.length} unverified {selectedDirection.hypothesisFindingIds.length === 1 ? "hypothesis" : "hypotheses"}.</span>
          </label>
        ) : null}
        <button type="button" className="dezin-research-viewer__generate" disabled={!canCreateIntent} onClick={() => void createIntent()}>
          {submitting ? <LoaderCircle className="dezin-research-viewer__spinner" aria-hidden /> : <ArrowUpRight aria-hidden />}
          {submitting ? "Creating successor plan…" : "Create Artifact plan"}
        </button>
        {submitError ? <p role="alert">{submitError}</p> : null}
      </footer>
      )}
    </section>
  );
}
