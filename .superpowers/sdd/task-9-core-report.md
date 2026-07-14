# Task 9 Core report

## Outcome

Implemented the Core Workspace Proposal domain and persistence boundary:

- immutable, full-payload Proposal audit revisions with `expectedProposalRevision` edit CAS;
- audited `baseGraph` and `baseLayout` state for deterministic review diffs;
- Project-owned Proposal reads and mutations;
- stale graph, Snapshot, and layout conflict detection that commits `conflicted` review state before throwing;
- checksum-CAS layout writes;
- one-transaction approval using an internal graph primitive, with exactly one semantic Snapshot when graph commands exist;
- layout-only and empty-semantic approval without a no-op graph revision or Snapshot;
- immutable, non-executable Generation Plan shells pinned to the exact approved Proposal revision and resulting/base Snapshot;
- strict generation-payload codecs and approval validation;
- explicit rejection of `component-propagation` at the external Core boundary until Task 13.

## TDD evidence

### RED

Command:

```text
pnpm --filter @dezin/core test
```

Initial result: exit 1. Existing tests passed, while the Proposal test module failed to load because the new Proposal/layout conflict surface did not exist yet.

Two additional hardening tests were also observed red before implementation:

```text
tests 155; pass 153; fail 2
```

They proved approval did not yet fail closed on mutable-row/audit divergence and SQLite did not yet enforce Project ownership for a Proposal's creating Run.

### GREEN

Command:

```text
pnpm --filter @dezin/core test
```

Result:

```text
tests 157; pass 157; fail 0; cancelled 0; skipped 0
```

Command:

```text
pnpm exec tsc -p tsconfig.check.json --noEmit
```

Result: exit 0.

## Requirement mapping

- Proposal isolation: create and edit only Proposal/audit rows; the canonical graph and layout remain unchanged until approval.
- Immutable revisions: every draft revision stores the complete discriminated Proposal payload, including immutable base graph/layout state; approval checks the mutable row against that exact audit revision.
- Edit concurrency: edits require `expectedProposalRevision` and increment once atomically.
- Approval concurrency: graph revision, active Snapshot, and layout checksum are guarded in one `BEGIN IMMEDIATE` transaction.
- Conflict durability: the stale branch updates Proposal status/review and returns from the transaction; `WorkspaceProposalConflictError` is thrown only after commit.
- Single Snapshot: semantic approval calls `applyGraphCommandsInTransaction`; layout persistence stays in the same transaction and creates no semantic history.
- Empty semantic batches: guarded base graph/Snapshot are reused; layout-only writes update layout state only.
- Generation shell: `generate` inserts status `approved`, no executable tasks, and exact `(proposalId, proposalRevision, baseSnapshotId)` foreign-key pins.
- Ownership: Project-scoped Proposal APIs reject cross-Project access; creating Run ownership is checked at API and SQLite boundaries.
- Generation dependencies: exact Resource revisions are ownership/existence checked and base-Snapshot policies require an exact Resource pin before approval.
- Compatibility: existing graph mutation behavior remains covered; existing layout tests now provide the required base checksum.

## Files

- `packages/core/src/store-schema.ts`
- `packages/core/src/workspace-types.ts`
- `packages/core/src/workspace-codecs.ts`
- `packages/core/src/workspace-store.ts`
- `packages/core/src/index.ts`
- `packages/core/test/workspace-store.test.ts`

## Self-review

- Verified Proposal base identity, audit rows, and Generation Plan identity cannot be updated or deleted while the owning Workspace exists; root Project deletion still cascades.
- Verified graph/layout/Proposal codec boundaries reject malformed, accessor-backed, noncanonical, or internally inconsistent payloads.
- Verified stale approval writes no graph revision, Snapshot, or Generation Plan.
- Verified graph-plus-layout approval produces one Snapshot and layout-only approval produces none.
- Verified all Core tests and the complete Node TypeScript program after the final diff.

No unresolved Core concerns. Daemon/Web callers must send the new required `baseLayoutChecksum`; their Task 9 integration owns that transport update.
