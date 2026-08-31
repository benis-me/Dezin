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
- Generative Design output is a self-contained `index.html`. CSS and JavaScript are inline.
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
- A Page's first generation must contain exactly one non-empty semantic
  `<title>` in `<head>`. Publication adopts that title only while the Node still
  has its default `Page` name; an explicit user name is never overwritten.
- Canvas mutations use optimistic revision checks. Undo and redo replay ordinary
  canvas snapshots; they do not create a second mutation protocol.

## Node-kind contract

Every kind has an explicit catalog entry, generation/analysis copy, default
geometry, and presentation mode. The current runtime distinctions are:

| Kind | Agent output contract | Canvas/focus presentation |
| --- | --- | --- |
| Page | Complete responsive page with one semantic first-publication title | Sandboxed web preview with device controls and portable HTML export |
| Component | Reusable specimen, or a categorized production-scale library when the brief requests one, with states, variants, accessibility, content, motion, and usage | Sandboxed component preview |
| Design System | Layered tokens, visual rules, full catalog structure, representative interactions, and component contracts | Sandboxed system reference |
| Research | Evidence, gaps, findings, decisions, and implications | Document-sized research presentation |
| Design Tokens | CSS-variable and JSON-like token reference | Token-reference presentation |
| Design Document | Design.md-style rationale, rules, and guidance | Document-sized specification presentation |
| Layout | Responsive grids, regions, spacing, and composition | Layout-reference presentation |
| Knowledge | Facts, constraints, terminology, relationships, and open questions | Document-sized knowledge presentation |
| Image / Video | Immutable material revision plus scoped analysis | Native aspect-preserving media renderer |
| Document / File | Immutable material revision plus scoped analysis | MIME/filename-driven Markdown, TanStack code, text editor, or binary fallback |

**Build a component system** is a canvas starter, not a second data model. It
adds Design System, Component Library, Design Tokens, and Design.md Nodes in one
revision, selects all four as Main Agent context, and pre-fills a coordination
brief. Each Node still owns its ordinary immutable Version history and export
boundary.

The eight generative kinds still publish one validated `index.html` Version.
Their prompt and presentation contracts differ, but Markdown, token JSON/CSS,
component contracts, research sources, and knowledge facts are not yet separate
filesystem authority. They must not be described as native semantic artifacts
until bundle Versions can carry those typed payloads alongside preview HTML and
pinned assets. The first Figma URL import now publishes `Design.md`,
`tokens.json`, and `components.json` as checksum-bound material Document/File
Nodes through the blank-canvas **Import from Figma** context-menu action. The
three artifacts are appended to the current Project at the frozen right-click
anchor; the import never creates a separate Project. It deliberately does not
claim native semantic bundles or a pixel-perfect clone. The exact input,
credential, Version fence, durability, and remaining binary/OAuth/refresh work
are documented in [FIGMA-IMPORT.md](./FIGMA-IMPORT.md).

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
    events/
      invalidation-journal.json     # bounded SSE cursor and replay authority
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

Home creation uses one idempotent daemon bootstrap Job under
`design-bootstrap-jobs/<idempotency-key-hash>/`: its compact `job.json` reserves
the exact Project id, content-addressed attachment import, and optional Main
Agent turn. Equal request keys replay the same receipt, conflicting payloads
fail closed, restart recovery resumes the recorded phase, and staged
`payloads/<sha256>` bytes are removed after the receipt is ready.

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

The daemon keeps `design-storage.ts` as a stable facade over focused Canvas,
Asset/Version, Job/Thread, frozen-context, URL-context, and validation modules.
Implementation Export, project bootstrap, and invalidation streaming are
separate services; daemon and Web DTOs come from the browser-safe
`@dezin/design-canvas-contracts` package. The Web screen delegates durable state
and Agent-panel state to controllers while header, focus chrome, tool docks, and
panel views remain independently testable.

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

The immutable `/preview` response remains the exact validated Version bytes.
Focused generated iframes use a separate `/preview/embed` response that repeats
the Version integrity check, then prepends a capture-phase context-menu bridge
so iframe and canvas Node menus share one parent-owned surface. The embedded
document creates a one-document `MessageChannel` capability before artifact
code runs; the parent accepts only its first private port and never reconnects
after navigation. Ordinary window messages cannot open the canvas menu. The
instrumented response is revalidated instead of immutable-cached and has its
own checksum, ETag, length, and restrictive CSP.

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
not to an impossible descendant copy of that class. Child layout classes are not
hoisted onto the marker: multi-sibling documents preserve each child's original
same-element class composition and CSS cascade. Node-specific `:root` tokens
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
Transient provider failures may retry once inside the same confined Job;
authentication, permission, identity, contract, and cancellation failures do
not. A missing/empty/unchanged generated artifact gets one bounded continuation,
and repairable HTML/runtime validation may get two bounded in-place repairs.
After a Job is durably failed, the explicit Retry/Repair action creates one
idempotent successor for Node, Main, or revision-matching Export work; it never
rewrites the failed Job or retries a non-failed Job.

Every canonical Canvas, Job, and Thread authority change also advances the
project-local invalidation journal. Web clients subscribe over authenticated
SSE with `Last-Event-ID`, replay retained cursors, reset to canonical GETs when
the epoch/history cannot be continued, and do not use interval polling as an
alternate authority.
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
- A single click selects a Node for canvas editing and opens its compact,
  node-scoped Agent without moving the viewport. A double click enters spatial
  focus and expands that same Agent slightly: the Node itself follows a shallow
  Bézier flight into a viewport-adaptive container that nearly fills the usable
  height while the React Flow viewport remains byte-for-byte unchanged. Generated
  content is laid out at 100% CSS size rather than visually zoomed; device presets
  change the responsive container width. Other Nodes travel on straight radial
  paths, with nearer Nodes moving farther than distant ones, then disappear behind
  an opaque mask whose duration and ease match the source flight.
  The focused Node is explicitly stacked above that mask. Its exact-Version
  preview receives pointer, keyboard, scrolling, and form input directly. The
  sandbox remains `allow-scripts` without `allow-same-origin`; focus changes
  interaction routing, not preview authority. Enter is the immediate keyboard
  equivalent of double-click; Back/Escape flies the Node back to its exact source
  position without writing a viewport mutation.
- Node Agent chrome and its bounded transcript mount independently from the Node
  flight, so history rendering cannot delay focus. The compact panel expands to
  the available canvas height in focus. Its close action hides only the Agent
  while leaving the centered, interactive Node untouched; the focus dock can
  restore the Agent. The separate Back
  control exits focus. A Node preview is the object itself and has no permanent
  title bar. Selection uses restrained depth without an outline or redundant
  inline toolbar. Pointer hover reveals faint corner resize brackets plus the
  Node name rising from behind the frame; both reverse smoothly on leave.
  Fixed-ratio material kinds preserve that ratio through corner resize.
- Every Node panel uses the same compact `Vn` Version selector in its header;
  timestamps remain in the menu rather than the trigger. Material Nodes additionally
  expose a single-file `Add revision` action; Agent composer attachments still
  create separate context Nodes and never mutate the selected Node implicitly.
  The composer grows between explicit minimum and maximum heights. Historical
  activity is represented as compact semantic rows with a bounded recent window;
  older messages and Jobs page in explicitly instead of mounting thousands of
  hidden elements. Terminal and failed runs remain collapsed with a one-line
  failure summary; only requested detail is expanded. Ordinary conversation is
  transcript text, never a synthetic Turn card; an active conversational turn
  uses only the compact 3×3 orb and shimmer status. Expanded activity and
  reasoning regions use interruptible grid-height transitions with no left
  emphasis rail. Non-error surfaces stay neutral: blue marks active work, green
  marks completion, amber marks waiting/cancellation, and red is reserved for
  failure identity and expanded failure detail.
- `Cmd/Ctrl+Z` and `Cmd/Ctrl+Shift+Z` perform undo and redo. Text inputs keep
  native editing history.
- Auto arrange is deterministic, respects node sizes, keeps context nodes ahead
  of generated outputs, and does not overlap nodes.
- Canvas chrome uses self-hosted Fontsource Geist/Geist Mono variable fonts and
  a quiet spatial vocabulary: a pale open field, micro-metadata, hairline
  boundaries, theme-aware translucent bottom controls, broad negative space, and
  blue only for selection/live work. The Add/tools cluster sits at the lower
  right while view controls sit at the lower left. Context menus use a wide,
  softly elevated surface and dim the canvas behind them. Focus flights use a
  sampled quadratic trajectory, fast-to-slow timing, and a distance-adjusted
  420–540ms duration so short and long travel feel consistent; deferred detail
  follows at 130ms. Reversals are generated from the animation's current path
  progress, so close/reopen never snaps to an endpoint or pauses at a segmented
  midpoint. The mask uses an interruptible opacity transition. Ordinary panels
  and menus use shorter asymmetric transform/opacity paths. Presses use
  restrained scale feedback, compositor motion avoids layout properties, and
  all loops/transitions honor reduced motion.
- No iframe is mounted for an empty or distant off-screen generated Node. Ready
  Nodes mount only their selected exact Version. Outside focus a gesture shield
  preserves selection and pan/drag semantics; double-click focus removes that
  shield and makes the iframe itself the hit target. New generated documents must
  reflow from 320px without document-level horizontal overflow. The focused Page
  dock can download its exact immutable Version as portable single-file HTML;
  daemon-owned pinned Assets are checksum-verified and embedded as data URLs so
  the file does not depend on a running Dezin instance.
