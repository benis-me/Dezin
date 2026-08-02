# Design Canvas

The Design project is a top bar over one infinite canvas. It has no permanent
left Agent rail, right Inspector, Proposal review, Build Plan, Group model, or
legacy project migration path.

## Product model

- The canvas is the shared context boundary. Every visible node can be cited by
  the Main Agent or by a node-scoped Agent.
- A node-scoped Agent owns exactly one node. It may read the frozen canvas
  context but may only publish a new immutable version for its target node.
- The Main Agent may add, remove, rename, move, select, and queue nodes. It may
  dispatch node-scoped Agents and report their statuses, but it cannot publish
  node content itself.
- Design output is a self-contained `index.html`. CSS and JavaScript are inline.
  Shared project assets are immutable and served by the local daemon.
- Component, Page, Design System, Research, Design Tokens, Design Document,
  Layout, and Knowledge nodes are generative. Image, Video, Document, and File
  nodes are material context.
- Every generated node has an independent version head and history. Selecting
  an older version is a view concern and never rewrites the head.
- A material Node's content-addressed Asset manifest is its immutable revision
  record. Importing changed bytes creates a new material Node/revision identity;
  it never silently overwrites the Canvas context that an Agent already read.
- Empty, queued, generating, validating, ready, failed, cancelled, and
  superseded are durable node/run states. A process crash must never turn a
  partial candidate into a ready version or clear the last ready preview.
- Canvas mutations use optimistic revision checks. Undo and redo replay ordinary
  canvas snapshots; they do not create a second mutation protocol.

## On-disk layout

Each Design project owns one new `design/` root below the daemon-managed
project directory:

```text
projects/<project-id>/
  design/
    metadata.json                   # normal Design identity: name + created/updated/archive timestamps
    project.json                    # Canvas authority: CAS revision + viewport + nodes
    assets/
      <asset-id>/
        manifest.json               # immutable identity, provenance, bundle checksums
        original.<ext>
        bundle/...                  # copied assets referenced by imported exact Versions
    nodes/
      <node-id>/
        versions/
          <version-id>/
            manifest.json           # immutable sequence, expected head, checksum, context hash
            index.html              # the complete generated design artifact
        agent/
          thread.json               # node-only full conversation
        .pending/
          jobs/<job-id>/            # isolated Node Agent checkout; never a published version
    agents/
      main/
        thread.json                 # global controller conversation and child jobs
    jobs/
      <job-id>.json                 # durable state, activity, cancellation and parent linkage
      <job-id>.context.json         # checksum-bound frozen canvas receipt
    exports/
      .pending/<export-id>/         # isolated implementation Agent checkout
      <export-id>/
        dezin-export.json            # exact inputs plus checksums for the complete output tree
        package.json
        index.html
        src/                         # fresh typed implementation; no Canvas HTML wrapper
        public/assets/               # approved local assets copied from frozen context
        dist/                        # production Vite build validation receipt
```

For an ordinary Design project, `design/project.json` is the existence and
Canvas authority, while `design/metadata.json` owns the project name, archive
state, and metadata-edit timestamps. The public Project `updatedAt` is the
maximum of metadata activity and durable Canvas activity, so node work updates
recent-project ordering without a second cross-file commit. Create, list, get,
patch, title, delete, Agent, Export, and restart recovery never require or write
a SQLite `projects` row. Sharingan remains an independent capture domain with
its own existing SQLite identity and bootstrap lifecycle; that identity is not
a fallback for an ordinary Design project.

The daemon serializes mutations per project. Metadata and Canvas writes use a
same-directory temporary file plus atomic rename. Version
directories are staged under `.pending/` and renamed into `versions/` only
after HTML validation and checksum calculation succeed. Head promotion also
checks the run's `expectedHeadVersionId`, so a late run becomes superseded
instead of overwriting a newer result. New code does not read
or migrate the previous workspace graph, snapshots, proposals, plans, artifact
tracks, or resource revisions.

## Preview and assets

The daemon is the small local preview server. It serves an exact node version
under a version-qualified URL and shared assets under immutable asset ids.
Preview iframes use `sandbox="allow-scripts"` without `allow-same-origin` and
receive no daemon authorization token. Preview responses apply a restrictive
CSP (`connect-src`, `frame-src`, and `object-src` are `none`). Generated HTML
cannot navigate the parent and cannot rely on a Vite project, package install,
remote script, or remote stylesheet.

Only the following paths are public reads:

```text
/api/projects/:projectId/design-canvas/nodes/:nodeId/versions/:versionId/preview/*
/api/projects/:projectId/design-canvas/assets/:assetId/*
```

The project top bar's implementation action freezes the selected head versions,
and every transitive Asset pin, records their checksums, and asks an
implementation Agent to recreate those designs as fresh Vite + TypeScript
source. The daemon rejects if any generative Node is empty, rejects iframe,
`srcdoc`, raw-HTML injection, remote dependencies, Dezin runtime references,
or a copied immutable HTML snapshot, then runs a real production Vite build.
`dezin-export.json` binds both the frozen inputs and every source/build output
byte. Export never mutates the single-HTML design sources.

## Mutation and Agent contracts

Canvas writes carry an `expectedRevision` compare-and-swap guard. Agent turns
also carry an idempotency key so retries cannot enqueue duplicate work. The
server accepts one of these canvas intents:

```text
add-node | update-node | remove-node | set-viewport | replace-layout
```

Main Agent output is a strict, bounded JSON envelope containing the same Canvas
intents plus scoped `dispatches`; it cannot publish design bytes. Canvas intents
are applied in one revision-CAS mutation. Each dispatch creates a child Job with
`parentJobId`; individual dispatch failures remain visible in the parent turn
instead of hiding or rolling back already accepted Canvas commands. Node Agent
output is not a command envelope: the Agent edits a staged `index.html`, which
the daemon validates and publishes as one version. Prompts receive a frozen,
checksum-bound context containing node summaries, exact selected Versions, and
every transitive content-addressed Asset bundle. Context payloads are treated as
untrusted data and cannot change Agent instructions or scope.

## Interaction contract

- `+` in the project top bar and the canvas context menu open the same node
  catalogue.
- An empty canvas displays Quick Start at the usable canvas center, not as a
  permanent side panel or a stored node.
- Selecting a node opens its Agent beside the node. Placement is viewport-
  clamped and chooses the side with the most usable space.
- `Cmd/Ctrl+Z` and `Cmd/Ctrl+Shift+Z` perform undo and redo. Text inputs keep
  native editing history.
- Auto arrange is deterministic, respects node sizes, keeps context nodes ahead
  of generated outputs, and does not overlap nodes.
- No iframe is mounted for an empty or distant off-screen generated node. Ready
  nodes mount only their selected exact version; an interaction mode explicitly
  hands pointer input from the canvas to the sandbox.
