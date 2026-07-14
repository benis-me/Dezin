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

## Fix Review

Addressed every finding in `task-9-core-review-checklist.md`:

- added `BEFORE INSERT` duplicate-identity guards for Proposal, Proposal audit, and Generation Plan rows, so `INSERT OR REPLACE` cannot delete immutable history even with `recursive_triggers = OFF`;
- required Proposal base Snapshots to be sealed, same-Workspace, and pinned to the Proposal's base graph revision at both the SQL insert and strict read boundaries;
- made audit decoding cross-check relational identity/revision/timestamp metadata, rejected `{}` reviews, and required a contiguous audit history plus exact current-revision coherence;
- guarded the audited base layout checksum for every approval, including graph-only proposals;
- rejected imported `component-propagation` commands before stale/conflict state can mutate;
- validated Artifact create/revise plans against the final graph, proposed name, planned Artifact/Track identity, and exact sealed base Revision semantics while preserving valid planned identities for Task 12.

The SQL/read-boundary audit found that the former base-anchor foreign keys proved only same-Workspace scalar existence. `decodeProposalRow()` did not load the base Snapshot, so raw imports could anchor a Proposal to an unsealed Snapshot or to a Snapshot from a different graph revision. The new insert trigger and strict Snapshot read close both paths.

### RED

The focused review tests were added before the production changes. The first complete Core run reported:

```text
tests 166; pass 157; fail 9
```

The failures covered all six review areas. In particular, the recursive-trigger-off replacement probe observed `[false, false, false]` for Proposal, audit, and Plan replacement protection, and a separate current-row rollback probe failed with `Missing expected exception` before contiguous audit verification existed.

### GREEN

```text
pnpm --filter @dezin/core test
tests 168; pass 168; fail 0; cancelled 0; skipped 0

pnpm --filter @dezin/core test:coverage
tests 168; pass 168; fail 0
all files: lines 91.81%; branches 79.01%; functions 91.04%

pnpm exec tsc -p tsconfig.check.json --noEmit
exit 0

git diff --check
exit 0
```

The immutable-history test also verifies the exact original rows survive failed replacements, `PRAGMA foreign_key_check` remains empty, `PRAGMA quick_check` is `ok`, and root Project deletion still cascades successfully.
