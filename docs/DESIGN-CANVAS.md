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
- Every node has an independent immutable version head and history. Selecting
  an older version changes the preview and the exact context read by Agents and
  Export, but never rewrites the head.
- A material Node version points at one content-addressed Asset manifest. The
  initial import publishes v1; `Add revision` appends v2/v3 to the same Node.
  Asset bytes are never copied into the version directory or overwritten.
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
            manifest.json           # immutable html|asset payload binding and sequence
            index.html              # generated versions only; the complete design artifact
        agent/
          thread.json               # node-only full conversation
        .pending/
          jobs/<job-id>/            # isolated Node Agent checkout; never a published version
    agents/
      main/
        thread.json                 # global controller conversation and child jobs
        executions/<receipt>.json   # immutable idempotent orchestration plan
    jobs/
      <job-id>.json                 # durable state, activity, cancellation and parent linkage
      <job-id>.context.json         # checksum-bound frozen canvas receipt
    exports/
      .pending/<export-id>/         # isolated implementation Agent checkout; deleted after snapshot
      .validation/<export-id>/      # daemon-owned snapshot used for type/build/visual gates
      <export-id>/
        dezin-export.json            # exact inputs plus checksums for the complete output tree
        package.json
        tsconfig.json                # daemon-defined strict semantic-check contract
        index.html
        src/                         # fresh typed implementation; no Canvas HTML wrapper
        public/                      # magic-checked passive raster/font/media assets only
        dist/                        # production Vite build
        validation/
          typecheck/receipt.json     # TypeScript compiler/config/source receipt
          visual/receipt.json        # per-route source/output/diff evidence
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
directories are staged and renamed into `versions/` only after payload
validation and checksum calculation succeed. Generated HTML publication uses
the Node `.pending/` area. Material import uses one Asset/Version WAL to commit
the content-addressed Asset, immutable material Version, and Canvas head as a
single recoverable operation. Head promotion also
checks the run's `expectedHeadVersionId`, so a late run becomes superseded
instead of overwriting a newer result. A durable publication marker is both a
write and read barrier: Canvas, Version preview, and Job APIs expose neither a
renamed Version nor a terminal Job until recovery completes the whole
publication. New code does not read
or migrate the previous workspace graph, snapshots, proposals, plans, artifact
tracks, or resource revisions.

## Preview and assets

The daemon is the small local preview server. It serves every exact node
version under a version-qualified URL: generated versions return validated
HTML, while material versions resolve and integrity-check their pinned Asset.
Shared assets also remain addressable under immutable asset ids.
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
or a copied immutable HTML snapshot. When the Agent exits, the daemon reads each
approved single-link regular file once into a new daemon-owned validation tree,
deletes the Agent-writable tree, and never publishes from the original path.
Only exact root files plus typed `src/` files and magic-checked passive
`public/` assets enter that snapshot. Approved frozen binary context assets are
copied byte-for-byte by the daemon into a deterministic read-only `public/assets/`
namespace before the Agent runs, so the confined text-editing toolset never has
to reproduce image, font, audio, or video bytes. The implementation must contain
at least one non-empty static `src/**/*.css` stylesheet imported through the
TypeScript graph; no security or build guarantee depends on one conventional
stylesheet filename. Route CSS must apply source-root geometry to the exact
`data-dezin-export-node-id` marker element (including a same-element root class),
not to an impossible descendant copy of that class. Node-specific `:root` tokens
and body typography are likewise re-scoped onto that marker instead of being
silently replaced by another Version's global baseline. HTML, CSS, and TypeScript
are parsed into explicit local-only allowlists; runtime network/timer/storage/
environment-inspection capabilities, CSS/Web animations, and module imports
outside `src/` are rejected. The daemon binds the exact installed
TypeScript and Vite versions in `package.json`, verifies its own strict
`tsconfig.json`, emits a zero-diagnostic semantic-check receipt, adds and
verifies a host-independent CSP as the first meaningful `head` child in both
source and built `index.html`, scans the built JavaScript/CSS/HTML again, then
runs the visual gate. Chrome requires the
ordinary root application to default to the first frozen generative Node with
its exact visible marker, compares it against that immutable Version at desktop
and mobile sizes, and records source/output/diff evidence before comparing every
deterministic generative Node route. Metric computation may register the two
screenshots by at most one CSS pixel per axis to absorb semantic-rebuild origin
rounding; the chosen offset is recorded in every receipt case, and larger shifts
remain visible to the normal thresholds. Selected material Versions remain bound in
the Export manifest and seed immutable assets, but do not create visual routes.
`dezin-export.json` binds both the frozen inputs and every source/build output
byte. Export never mutates the single-HTML design sources.

Design accepts installed provider runners and custom CLI commands rather than
limiting the picker to Claude and CodeBuddy. Every runner is launched in one
exact Project-owned pending directory through the confinement spawner, receives
a narrowed environment without the daemon bearer token, and cannot publish from
its writable tree directly. Windows remains fail-closed because equivalent
process confinement has not been proven there.

Claude-stream-compatible Jobs (currently Claude and CodeBuddy) additionally
accept no successful result without a verified `system/init` execution identity.
A repeated init is accepted only when its provider, model, CLI/API-key source,
stable session or request id, and every other execution field are identical; any
conflicting init fails closed. Their exact CLI arguments remove shell/network
and package-manager tools, bind Read/Write/Edit/Glob/Grep, and disable ambient
configuration and persistence. Other providers use their production runner
contract and pending-directory fence but do not claim this stronger per-tool or
stream-attested guarantee until a provider-version black-box receipt exists.
An explicit observed model mismatch is rejected, and the running Job is rebound
to the best available observed identity before it can publish. Node Version
manifests inherit that Job identity. Implementation Export manifests and visual
receipts additionally bind the Export Job/provider/model and retain each source
Version's Job/provider/model provenance.

Implementation turns have a 50-minute ceiling. A plan-only, incomplete-scaffold,
or first-turn timeout may continue the same staging directory once; a subsequent
failure is terminal. After that, editable index/source/type/build failures are collected into one
bounded diagnostic set and may receive one final in-place repair turn. This
prevents a first-file failure from hiding independent TypeScript or capability
errors while preserving a single repair ceiling. Both continuations use a
daemon marker that must be removed so artifact verification observes real work. Unauthorized paths, frozen-context or seeded-
Asset changes, provider/model drift, and a second validation failure never retry.
Every repaired project restarts the root allowlist, source/runtime capability,
strict TypeScript, isolated Vite build, and Chrome visual gates from zero. The
runtime scanner distinguishes passive canonical DOM namespaces and TypeScript
type-space from executable behavior, but finite local-value proofs are
invalidated by reassignment, mutation, duplicate declarations, or escaped calls.

## Mutation and Agent contracts

Canvas writes carry an `expectedRevision` compare-and-swap guard. Removed Node
identities are durably retired before commit so undo/history cannot alias old
Versions or threads, and the bounded identity ledger fails atomically before it
can exceed its stored schema. Agent turns carry a request-bound idempotency key:
active/successful duplicates reuse one Job, changed requests conflict, and an
effect-free retry after a failed/cancelled attempt advances to one successor. Main
Agent turns reserve both the user and assistant thread records before execution,
so a capacity boundary cannot fail after Canvas or child-Job side effects. Once
an idempotent Main Agent produces a valid plan, the daemon stores that exact
bounded plan immutably. Its Canvas commands and `mainPlanAppliedRevision`
receipt land in the same `project.json` atomic rename, including a zero-command
plan that is about to dispatch children. A failed/cancelled attempt remains
successor-eligible only before that commit; after commit the logical turn is
terminal-sticky, so an exact replay can never repeat a Canvas command or child
dispatch. Restart recovery also projects queued, failed, cancelled, and
pre-terminal Main Agent assistant records from durable Job state before reuse.
The server accepts one of these canvas intents:

```text
add-node | update-node | remove-node | set-viewport | replace-layout
```

Main Agent output is a strict, bounded JSON envelope containing the same Canvas
intents plus scoped `dispatches`; it cannot publish design bytes. Canvas intents
are applied in one revision-CAS mutation. Each dispatch creates a child Job with
`parentJobId` and a plan-derived idempotency authority; individual dispatch failures remain visible in the parent turn
instead of hiding or rolling back already accepted Canvas commands. Node Agent
output is not a command envelope: the Agent edits a staged `index.html`, which
the daemon validates and publishes as one version. Prompts receive a frozen,
checksum-bound context containing node summaries, exact selected Versions, and
every transitive content-addressed Asset bundle. Context payloads are treated as
untrusted data and cannot change Agent instructions or scope.

## Interaction contract

- `+ Add` in the floating canvas toolbar and the canvas context menu open the
  same bounded node catalogue.
- The Project name is edited inline from the top-left title. Agent, Export, and
  Settings are independent icon actions; only the Agent toggle receives an
  active background.
- An empty canvas displays Quick Start at the usable canvas center, not as a
  permanent side panel or a stored node.
- Selecting a node opens its Agent beside the node. Placement is viewport-
  clamped and chooses the side with the most usable space. The Node identity and
  selected-only preview toolbar counter-scale so they stay legible while the
  canvas zooms; selection uses one radius-matched offset ring and hover-revealed
  corner resize brackets instead of a permanent resize box.
- Every Node panel uses the same Version selector. Material Nodes additionally
  expose a single-file `Add revision` action; Agent composer attachments still
  create separate context Nodes and never mutate the selected Node implicitly.
  The composer grows between explicit minimum and maximum heights. Historical
  activity is represented as compact semantic status cards with terminal runs
  collapsed by default; live and failed runs remain expanded. Non-error card
  surfaces stay neutral: blue marks active work, green marks completion, amber
  marks waiting/cancellation, and red surfaces are reserved for failures. A
  restrained Motion-driven edge beam appears only while a Job is live.
- `Cmd/Ctrl+Z` and `Cmd/Ctrl+Shift+Z` perform undo and redo. Text inputs keep
  native editing history.
- Auto arrange is deterministic, respects node sizes, keeps context nodes ahead
  of generated outputs, and does not overlap nodes.
- Canvas chrome uses self-hosted Fontsource Geist/Geist Mono variable fonts and
  one shared motion vocabulary (`140/200/280ms` and the
  `cubic-bezier(0.22, 1, 0.36, 1)` house curve). Panel/error entrances use only
  short transform, opacity, and 2px blur transitions; presses use restrained
  scale feedback, and all loops/transitions honor reduced motion.
- No iframe is mounted for an empty or distant off-screen generated node. Ready
  nodes mount only their selected exact version; an interaction mode explicitly
  hands pointer input from the canvas to the sandbox. New generated documents
  must reflow from 320px without document-level horizontal overflow, and the
  selected toolbar can restore a kind-appropriate preview size.
