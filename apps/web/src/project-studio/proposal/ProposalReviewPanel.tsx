import "./proposal-review-panel.css";

import {
  AlertTriangle,
  Check,
  GitCompareArrows,
  LocateFixed,
  Minus,
  PencilLine,
  Plus,
  Undo2,
  WandSparkles,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type {
  GenerationPlan,
  WorkspaceGraphCommand,
  WorkspaceProposal,
  WorkspaceProposalApprovalMode,
} from "../../lib/api.ts";
import type { ProposalChange, ProposalDiff } from "./proposal-diff.ts";

export interface ProposalIssue {
  code?: string;
  message: string;
  objectId?: string;
}

export interface ProposalConflictSummary {
  expectedGraphRevision: number;
  actualGraphRevision: number;
  expectedSnapshotId: string;
  actualSnapshotId: string;
  expectedLayoutChecksum: string;
  actualLayoutChecksum: string;
  graphChanged: boolean;
  snapshotChanged: boolean;
  layoutChanged: boolean;
}

type ReviewableProposalState = {
  proposal: WorkspaceProposal;
  diff: ProposalDiff;
};

export type ProposalEditPatch = Partial<Pick<
  WorkspaceProposal,
  "operations" | "layoutOperations" | "generation" | "rationale" | "assumptions"
>>;

export type ProposalEditField = keyof ProposalEditPatch;

export type ProposalReviewState =
  | { status: "idle" | "loading" }
  | ({ status: "draft" } & ReviewableProposalState)
  | ({ status: "saving"; intent: "edit" | "approve" | "reject" } & ReviewableProposalState)
  | ({
      status: "validation-error";
      source: "edit" | "approve";
      message: string;
      issues: ProposalIssue[];
      resetEditFields?: readonly ProposalEditField[];
      invalidEditFields?: readonly ProposalEditField[];
      invalidChangeKeys?: readonly string[];
    } & ReviewableProposalState)
  | ({ status: "conflicted"; conflict: ProposalConflictSummary } & ReviewableProposalState)
  | { status: "approved" | "rejected" | "superseded"; proposal: WorkspaceProposal; plan: GenerationPlan | null }
  | { status: "error"; message: string };

export interface ProposalReviewPanelProps {
  review: ProposalReviewState;
  focusedChangeKey: string | null;
  onEdit: (patch: ProposalEditPatch) => Promise<unknown>;
  onRenameNode?: (change: ProposalChange<unknown>, name: string) => Promise<unknown>;
  onRevert: (change: ProposalChange<unknown>) => Promise<unknown>;
  onFocusItem: (changeKey: string) => void;
  onApprove: (mode: WorkspaceProposalApprovalMode) => Promise<unknown>;
  onReject: () => Promise<unknown>;
  onClose: () => void;
}

const STATUS = {
  addition: { label: "Added", action: "added", Icon: Plus },
  modification: { label: "Changed", action: "changed", Icon: PencilLine },
  removal: { label: "Removed", action: "removed", Icon: Minus },
} as const;

function subjectLabel(change: ProposalChange<unknown>): string {
  const separator = change.accessibleLabel.indexOf(": ");
  return separator >= 0 ? change.accessibleLabel.slice(separator + 2) : change.objectId;
}

function reviewActionLabel(change: ProposalChange<unknown>, verb: "Review" | "Revert"): string {
  const subject = subjectLabel(change);
  const spokenSubject = `${subject.slice(0, 1).toLowerCase()}${subject.slice(1)}`;
  return `${verb} ${STATUS[change.changeKind].action} ${spokenSubject}`;
}

function isReviewable(review: ProposalReviewState): review is ProposalReviewState & ReviewableProposalState {
  return review.status === "draft"
    || review.status === "saving"
    || review.status === "validation-error"
    || review.status === "conflicted";
}

interface ProposalNodeNameEditorProps {
  change: ProposalChange<unknown>;
  proposalId: string;
  proposalRevision: number;
  operations: readonly WorkspaceGraphCommand[];
  editable: boolean;
  resetKey: string | null;
  forceCommit: boolean;
  onRenameNode?: (change: ProposalChange<unknown>, name: string) => Promise<unknown>;
  onEdit: (patch: ProposalEditPatch) => Promise<unknown>;
}

function proposedNodeName(change: ProposalChange<unknown>): string | null {
  if (change.objectKind !== "node" || change.after === null || typeof change.after !== "object") return null;
  const node = change.after as { id?: unknown; name?: unknown };
  return node.id === change.objectId && typeof node.name === "string" ? node.name : null;
}

function isReferencedNodeNameCommand(
  change: ProposalChange<unknown>,
  command: WorkspaceGraphCommand,
): boolean {
  const referenced = change.operationRefs.some(
    (reference) => reference.kind === "graph" && reference.commandId === command.id,
  );
  if (!referenced) return false;
  if (command.type === "add-node") return command.node.id === change.objectId;
  return command.type === "rename-node" && command.nodeId === change.objectId;
}

function ProposalNodeNameEditor({
  change,
  proposalId,
  proposalRevision,
  operations,
  editable,
  resetKey,
  forceCommit,
  onRenameNode,
  onEdit,
}: ProposalNodeNameEditorProps) {
  const authoritativeName = proposedNodeName(change) ?? "";
  const identity = `${proposalId}:${change.key}`;
  const [name, setName] = useState(authoritativeName);
  const identityRef = useRef(identity);
  const valueRef = useRef(name);
  const dirtyRef = useRef(false);
  const handledResetKeyRef = useRef<string | null>(null);
  const hasEditableCommand = operations.some((command) => isReferencedNodeNameCommand(change, command));

  useEffect(() => {
    if (identityRef.current !== identity) {
      identityRef.current = identity;
      dirtyRef.current = false;
      valueRef.current = authoritativeName;
      setName(authoritativeName);
      return;
    }
    if (resetKey && handledResetKeyRef.current !== resetKey) {
      handledResetKeyRef.current = resetKey;
      dirtyRef.current = false;
      valueRef.current = authoritativeName;
      setName(authoritativeName);
      return;
    }
    if (!dirtyRef.current || valueRef.current === authoritativeName) {
      dirtyRef.current = false;
      valueRef.current = authoritativeName;
      setName(authoritativeName);
    }
  }, [authoritativeName, identity, proposalRevision, resetKey]);

  if (!authoritativeName || !hasEditableCommand) return null;

  const commit = () => {
    const nextName = name.trim();
    if (!editable || !nextName || (!forceCommit && nextName === authoritativeName)) return;
    if (nextName !== name) {
      valueRef.current = nextName;
      setName(nextName);
    }
    let changed = false;
    const nextOperations = operations.map((command): WorkspaceGraphCommand => {
      if (!isReferencedNodeNameCommand(change, command)) return command;
      changed = true;
      if (command.type === "add-node") {
        return { ...command, node: { ...command.node, name: nextName } };
      }
      if (command.type === "rename-node") return { ...command, name: nextName };
      return command;
    });
    if (changed) {
      if (onRenameNode) void onRenameNode(change, nextName);
      else void onEdit({ operations: nextOperations });
    }
  };

  return (
    <label className="dezin-proposal-review__name-editor">
      <span>Name</span>
      <input
        aria-label={`Proposal name for ${authoritativeName}`}
        autoComplete="off"
        value={name}
        readOnly={!editable}
        onChange={(event) => {
          const next = event.target.value;
          valueRef.current = next;
          dirtyRef.current = next !== authoritativeName;
          setName(next);
        }}
        onBlur={commit}
      />
    </label>
  );
}

export function ProposalReviewPanel({
  review,
  focusedChangeKey,
  onEdit,
  onRenameNode,
  onRevert,
  onFocusItem,
  onApprove,
  onReject,
  onClose,
}: ProposalReviewPanelProps) {
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const alertHeadingRef = useRef<HTMLHeadingElement | null>(null);
  const listRef = useRef<HTMLOListElement | null>(null);
  const proposal = isReviewable(review) ? review.proposal : "proposal" in review ? review.proposal : null;
  const [rationale, setRationale] = useState(proposal?.rationale ?? "");
  const [assumptions, setAssumptions] = useState(proposal?.assumptions.join("\n") ?? "");
  const proposalIdRef = useRef(proposal?.id ?? null);
  const rationaleValueRef = useRef(rationale);
  const assumptionsValueRef = useRef(assumptions);
  const rationaleDirtyRef = useRef(false);
  const assumptionsDirtyRef = useRef(false);
  const handledRationaleResetKeyRef = useRef<string | null>(null);
  const handledAssumptionsResetKeyRef = useRef<string | null>(null);
  const busy = review.status === "saving";
  const editable = review.status === "draft"
    || review.status === "validation-error"
    || (review.status === "saving" && review.intent === "edit");
  const canCommitFields = editable;
  const approvalBlocked = review.status === "validation-error" && review.source === "edit";
  const editConflictRevision = review.status === "validation-error" && review.source === "edit"
    ? `${review.proposal.id}:${review.proposal.revision}`
    : null;
  const rationaleResetKey = editConflictRevision && review.status === "validation-error"
    && review.resetEditFields?.includes("rationale")
    ? `${editConflictRevision}:rationale`
    : null;
  const assumptionsResetKey = editConflictRevision && review.status === "validation-error"
    && review.resetEditFields?.includes("assumptions")
    ? `${editConflictRevision}:assumptions`
    : null;
  const operationsResetKey = editConflictRevision && review.status === "validation-error"
    && review.resetEditFields?.includes("operations")
    ? `${editConflictRevision}:operations`
    : null;
  const rationaleInvalid = review.status === "validation-error"
    && review.source === "edit"
    && review.invalidEditFields?.includes("rationale") === true;
  const assumptionsInvalid = review.status === "validation-error"
    && review.source === "edit"
    && review.invalidEditFields?.includes("assumptions") === true;
  const qualityContract = proposal?.generation.kind === "workspace-generation"
    && proposal.generation.artifactPlans.length > 0
    ? proposal.generation
    : null;

  useEffect(() => {
    const nextProposalId = proposal?.id ?? null;
    const nextRationale = proposal?.rationale ?? "";
    const nextAssumptions = proposal?.assumptions.join("\n") ?? "";
    if (proposalIdRef.current !== nextProposalId) {
      proposalIdRef.current = nextProposalId;
      rationaleDirtyRef.current = false;
      assumptionsDirtyRef.current = false;
      rationaleValueRef.current = nextRationale;
      assumptionsValueRef.current = nextAssumptions;
      setRationale(nextRationale);
      setAssumptions(nextAssumptions);
      return;
    }
    if (rationaleResetKey && handledRationaleResetKeyRef.current !== rationaleResetKey) {
      handledRationaleResetKeyRef.current = rationaleResetKey;
      rationaleDirtyRef.current = false;
      rationaleValueRef.current = nextRationale;
      setRationale(nextRationale);
    } else if (!rationaleDirtyRef.current || rationaleValueRef.current === nextRationale) {
      rationaleDirtyRef.current = false;
      rationaleValueRef.current = nextRationale;
      setRationale(nextRationale);
    }
    if (assumptionsResetKey && handledAssumptionsResetKeyRef.current !== assumptionsResetKey) {
      handledAssumptionsResetKeyRef.current = assumptionsResetKey;
      assumptionsDirtyRef.current = false;
      assumptionsValueRef.current = nextAssumptions;
      setAssumptions(nextAssumptions);
    } else if (!assumptionsDirtyRef.current || assumptionsValueRef.current === nextAssumptions) {
      assumptionsDirtyRef.current = false;
      assumptionsValueRef.current = nextAssumptions;
      setAssumptions(nextAssumptions);
    }
  }, [
    assumptionsResetKey,
    proposal?.assumptions,
    proposal?.id,
    proposal?.rationale,
    proposal?.revision,
    rationaleResetKey,
  ]);

  useEffect(() => {
    if (review.status === "conflicted" || review.status === "validation-error") {
      alertHeadingRef.current?.focus();
    } else if (review.status === "approved" || review.status === "rejected" || review.status === "superseded") {
      headingRef.current?.focus();
    }
  }, [review.status]);

  if (review.status === "idle") return null;
  if (review.status === "loading") {
    return (
      <section className="dezin-proposal-review" role="region" aria-label="Proposal review">
        <p className="dezin-proposal-review__loading" role="status" aria-live="polite">Loading proposal review…</p>
      </section>
    );
  }
  if (review.status === "error") {
    return (
      <section className="dezin-proposal-review" role="region" aria-label="Proposal review">
        <div className="dezin-proposal-review__notice" role="alert">
          <AlertTriangle size={15} aria-hidden />
          <div><h2 tabIndex={-1}>Proposal unavailable</h2><p>{review.message}</p></div>
        </div>
        <footer className="dezin-proposal-review__footer">
          <button type="button" className="dezin-proposal-review__secondary" onClick={onClose}>Close review</button>
        </footer>
      </section>
    );
  }
  if (review.status === "approved" || review.status === "rejected" || review.status === "superseded") {
    const result = review.status === "approved"
      ? {
          label: "Proposal approved",
          message: review.plan
            ? `Generation plan ${review.plan.id} is approved for compilation.`
            : "Workspace structure was applied.",
          Icon: Check,
        }
      : review.status === "rejected"
        ? { label: "Proposal rejected", message: "No workspace changes were applied.", Icon: X }
        : { label: "Proposal superseded", message: "A newer proposal replaced this review.", Icon: GitCompareArrows };
    return (
      <section className="dezin-proposal-review" role="region" aria-label="Proposal review">
        <div className="dezin-proposal-review__result" data-result-state={review.status} role="status" aria-live="polite">
          <result.Icon size={16} aria-hidden />
          <h2 ref={headingRef} tabIndex={-1}>{result.label}</h2>
          <p>{result.message}</p>
          <button type="button" onClick={onClose}>
            {review.status === "approved" && review.plan ? "View build plan" : "Close review"}
          </button>
        </div>
      </section>
    );
  }
  if (!isReviewable(review)) return null;

  const reviewItems = review.diff.reviewItems;
  const commitRationale = () => {
    if (canCommitFields && (rationaleInvalid || rationale !== review.proposal.rationale)) {
      void onEdit({ rationale });
    }
  };
  const commitAssumptions = () => {
    const next = assumptions.split("\n").map((value) => value.trim()).filter(Boolean);
    if (canCommitFields && (assumptionsInvalid || JSON.stringify(next) !== JSON.stringify(review.proposal.assumptions))) {
      void onEdit({ assumptions: next });
    }
  };
  const revert = async (change: ProposalChange<unknown>, index: number) => {
    await onRevert(change);
    requestAnimationFrame(() => {
      const controls = listRef.current?.querySelectorAll<HTMLButtonElement>("button[data-review-control]");
      const next = controls?.item(Math.min(index, Math.max(0, (controls?.length ?? 1) - 1)));
      if (next) next.focus();
      else headingRef.current?.focus();
    });
  };

  return (
    <section
      className="dezin-proposal-review"
      role="region"
      aria-label="Proposal review"
      aria-busy={busy || undefined}
    >
      <header className="dezin-proposal-review__header">
        <div>
          <span>Review queue</span>
          <h2 ref={headingRef} tabIndex={-1}>Workspace proposal</h2>
        </div>
        <span className="dezin-proposal-review__revision">r{review.proposal.revision}</span>
      </header>

      {review.status === "validation-error" ? (
        <div className="dezin-proposal-review__notice" role="alert">
          <AlertTriangle size={15} aria-hidden />
          <div>
            <h3 ref={alertHeadingRef} tabIndex={-1}>Proposal needs attention</h3>
            <p>{review.message}</p>
            {review.issues.length ? <ul>{review.issues.map((issue, index) => <li key={`${issue.code ?? "issue"}-${index}`}>{issue.message}</li>)}</ul> : null}
          </div>
        </div>
      ) : null}

      {review.status === "conflicted" ? (
        <div className="dezin-proposal-review__notice" role="alert">
          <GitCompareArrows size={15} aria-hidden />
          <div>
            <h3 ref={alertHeadingRef} tabIndex={-1}>Proposal base changed</h3>
            <p>This proposal is read-only. Review it against the current workspace before creating a replacement.</p>
            <dl>
              <div><dt>Graph</dt><dd>{review.conflict.expectedGraphRevision} → {review.conflict.actualGraphRevision}</dd></div>
              <div><dt>Snapshot</dt><dd>{review.conflict.expectedSnapshotId} → {review.conflict.actualSnapshotId}</dd></div>
              {review.conflict.layoutChanged ? (
                <div><dt>Layout</dt><dd>{review.conflict.expectedLayoutChecksum} → {review.conflict.actualLayoutChecksum}</dd></div>
              ) : null}
            </dl>
          </div>
        </div>
      ) : null}

      <div className="dezin-proposal-review__fields">
        <label>
          <span>Rationale</span>
          <textarea
            aria-label="Proposal rationale"
            value={rationale}
            readOnly={!editable}
            onChange={(event) => {
              const next = event.target.value;
              rationaleValueRef.current = next;
              rationaleDirtyRef.current = next !== review.proposal.rationale;
              setRationale(next);
            }}
            onBlur={commitRationale}
          />
        </label>
        <label>
          <span>Assumptions <small>one per line</small></span>
          <textarea
            aria-label="Proposal assumptions"
            value={assumptions}
            readOnly={!editable}
            onChange={(event) => {
              const next = event.target.value;
              assumptionsValueRef.current = next;
              assumptionsDirtyRef.current = next !== review.proposal.assumptions.join("\n");
              setAssumptions(next);
            }}
            onBlur={commitAssumptions}
          />
        </label>
      </div>

      {qualityContract ? (
        <section className="dezin-proposal-review__quality" aria-label="Effective quality contract">
          <div className="dezin-proposal-review__quality-heading">
            <h3>Quality contract</h3>
            <span>Enforced</span>
          </div>
          <div className="dezin-proposal-review__quality-frames" aria-label="Required review frames">
            {qualityContract.responsiveFrames
              .filter((frame) => qualityContract.qualityProfile.requiredFrameIds.includes(frame.id))
              .map((frame) => (
                <span key={frame.id}>
                  <strong>{frame.name}</strong>
                  <small>{frame.width} × {frame.height}</small>
                </span>
              ))}
          </div>
          <dl>
            <div>
              <dt>Runtime</dt>
              <dd>{qualityContract.qualityProfile.requireRuntimeChecks ? "Required" : "Optional"}</dd>
            </div>
            <div>
              <dt>Visual review</dt>
              <dd>{qualityContract.qualityProfile.requireVisualReview ? "Required" : "Optional"}</dd>
            </div>
            <div>
              <dt>Blocks on</dt>
              <dd>{qualityContract.qualityProfile.blockingSeverities.join(" · ") || "None"}</dd>
            </div>
          </dl>
        </section>
      ) : null}

      <div className="dezin-proposal-review__changes">
        <div className="dezin-proposal-review__section-heading">
          <h3>Proposed changes</h3>
          <span>{reviewItems.length}</span>
        </div>
        {reviewItems.length === 0 ? (
          <p className="dezin-proposal-review__empty">No structural changes remain.</p>
        ) : (
          <ol ref={listRef} aria-label="Proposal change review list">
            {reviewItems.map((change, index) => {
              const status = STATUS[change.changeKind];
              const active = focusedChangeKey === change.key;
              return (
                <li key={change.key}>
                  <button
                    type="button"
                    data-review-control
                    aria-label={reviewActionLabel(change, "Review")}
                    aria-current={active ? "true" : undefined}
                    onClick={() => onFocusItem(change.key)}
                  >
                    <span className="dezin-proposal-review__shape" data-status-shape={change.changeKind} aria-hidden>
                      <status.Icon size={10} strokeWidth={2} />
                    </span>
                    <span><strong>{status.label}</strong><small>{subjectLabel(change)}</small></span>
                    <LocateFixed size={12} aria-hidden />
                  </button>
                  {editable ? (
                    <button
                      type="button"
                      className="dezin-proposal-review__revert"
                      aria-label={reviewActionLabel(change, "Revert")}
                      disabled={busy}
                      onClick={() => void revert(change, index)}
                    >
                      <Undo2 size={11} aria-hidden />
                    </button>
                  ) : null}
                  <ProposalNodeNameEditor
                    change={change}
                    proposalId={review.proposal.id}
                    proposalRevision={review.proposal.revision}
                    operations={review.proposal.operations}
                    editable={editable}
                    resetKey={operationsResetKey}
                    forceCommit={review.status === "validation-error"
                      && review.source === "edit"
                      && review.invalidChangeKeys?.includes(change.key) === true}
                    onRenameNode={onRenameNode}
                    onEdit={onEdit}
                  />
                </li>
              );
            })}
          </ol>
        )}
      </div>

      {busy ? (
        <p className="dezin-proposal-review__live" role="status" aria-live="polite">
          {review.intent === "edit" ? "Saving proposal…" : review.intent === "reject" ? "Rejecting proposal…" : "Applying proposal…"}
        </p>
      ) : null}

      {review.status === "conflicted" ? (
        <footer className="dezin-proposal-review__footer">
          <button type="button" className="dezin-proposal-review__secondary" onClick={onClose}>Close review</button>
        </footer>
      ) : (
        <footer className="dezin-proposal-review__footer">
          <button
            type="button"
            className="dezin-proposal-review__secondary"
            disabled={busy || approvalBlocked}
            onClick={() => void onApprove("structure-only")}
          >
            <Check size={12} aria-hidden /> Apply structure only
          </button>
          <button
            type="button"
            className="dezin-proposal-review__primary"
            disabled={busy || approvalBlocked}
            onClick={() => void onApprove("generate")}
          >
            <WandSparkles size={12} aria-hidden /> Approve and generate
          </button>
          <button
            type="button"
            className="dezin-proposal-review__reject"
            disabled={busy}
            onClick={() => void onReject()}
          >
            <X size={12} aria-hidden /> Reject proposal
          </button>
        </footer>
      )}
    </section>
  );
}
