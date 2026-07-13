# Multi-artifact design workspace

Status: approved
Date: 2026-07-13

## Summary

Dezin evolves from one generated design per project into a local-first design
workspace containing pages, reusable component masters, component instances,
research, moodboards, Sharingan captures, files, assets, Effects, and explicit
prototype relationships.

The product remains a design tool. Pages and components are independent design
artifacts with their own previews, Agents, versions, and quality evidence. They do
not need to form one deployable website or application. Code remains an internal
rendering and editing medium for live preview, deterministic direct edits, visual
review, and export.

The project overview is a semantic graph built with `@xyflow/react`. The existing
Leafer Moodboard remains the freeform visual-material canvas. React Flow does not
replace Leafer, and neither renderer's native JSON is the domain model.

## Confirmed product decisions

- Use **Artifact Graph + Shared Design Kernel**, not a deployable-app model and not
  a new universal scene graph.
- A project is a design workspace and shared Context root.
- Page and Component are independent first-class design artifacts.
- Components use a master-and-linked-instance model. Instances pin a component
  revision, support variants and local overrides, and may be detached explicitly.
- Component changes never propagate silently. They require impact review and an
  explicit propagation choice.
- Editing is Agent-first and hybrid: element selection plus Agent changes, with
  deterministic direct controls for common properties. A full Figma-style scene
  editor is not part of this feature.
- Page-to-page relationships use a two-stage prototype model: `planned`,
  `interactive`, and `broken`.
- Workspace generation is plan-first. The Workspace Agent first proposes editable
  nodes, resources, dependencies, and flows. Only an approved Proposal may start
  artifact generation.
- The approved implementation is phased internally, but all phases preserve the
  final domain contracts in this document.

## Goals

1. Generate and organize many pages, components, and resources in one workspace.
2. Preserve a coherent shared design language without forcing one deployable app.
3. Let users open any page or component in a focused, high-quality editing mode.
4. Give Workspace, Page, Component, and Resource Agents correctly scoped Context.
5. Make prototype flows explicit on the canvas and playable once bound.
6. Make versions, compare, restore, Viewer, Research, Sharingan, and quality
   evidence artifact-aware.
7. Support plan review, dependency-aware generation, partial failure, and safe
   retries without losing successful work.

## Non-goals

- Producing one deployable multi-route application.
- Replacing Leafer Moodboards with React Flow.
- Building a full scene graph, layout engine, or Figma/Webflow clone.
- Real-time multi-user collaboration.
- Silent component propagation or automatic destructive restores.
- Mounting live iframes inside every canvas node.
- Treating canvas position changes as design revisions.

## Domain model

### ProjectWorkspace

`ProjectWorkspace` is the project-level Context and graph root. It owns:

- the Shared Design Kernel;
- the current semantic graph revision;
- artifact and resource membership;
- active and historical Proposals;
- layout state and saved viewports;
- workspace checkpoints.

The existing `Project` remains the external identity and compatibility boundary.
Workspace state is created lazily for existing projects.

### SharedDesignKernel

The kernel contains global design vocabulary and reusable inputs:

- design tokens and themes;
- typography rules;
- shared asset references;
- project brief, terminology, exclusions, and durable decisions;
- default responsive frames and quality profile.

The kernel is revisioned. Artifact revisions pin the kernel revision they used.
Changing the kernel is a workspace-wide operation and requires impact analysis.

### WorkspaceNode

Semantic nodes have stable IDs and one of these kinds:

- `page`: a `PageDesign` artifact;
- `component`: a `ComponentDefinition` artifact;
- `resource`: a reference to a versioned Resource.

Visual groups and sections are layout objects, not semantic artifacts. React Flow
may render them as parent nodes through an adapter, but `parentId` never expresses
domain ownership.

Each artifact node records:

- stable artifact ID and display name;
- current artifact revision ID;
- lifecycle status;
- render specification;
- quality summary and immutable thumbnail references;
- source-root identity in the internal artifact store;
- archived timestamp instead of destructive deletion.

Artifact lifecycle states are:

```text
planned -> queued -> generating -> validating -> ready
                                  -> needs-attention
planned/queued/running            -> cancelled
ready                             -> outdated
```

### ArtifactRevision

An Artifact Revision is immutable and contains:

- artifact ID, Artifact Track ID, revision number, parent revision, and creation
  provenance;
- internal source snapshot identity (`commitHash` plus source root or equivalent);
- content checksum;
- pinned Shared Design Kernel revision;
- pinned Resource revisions;
- pinned Component revisions used by the artifact;
- Render Spec and fixtures;
- screenshot, runtime, lint, and visual-review evidence;
- producing Run and immutable Context Pack hash.

The mutable artifact Head is only a pointer to an immutable revision. Publishing a
new revision uses compare-and-swap against the task's base revision.

### ArtifactTrack

An `ArtifactTrack` is an exploration lineage for one Page or Component. It replaces
the old assumption that a Project Variant owns the whole generated surface. Track
names such as `Main`, `Editorial direction`, or `Compact study` are artifact-local.

An Artifact Track must not be confused with a Component visual `variant` such as
`size=compact` or `state=loading`. A track selects a revision lineage; a visual
variant is rendered content inside one Component Revision. Each artifact has one
active track, and every Artifact Revision belongs to exactly one track.

### PageDesign

A Page Design is an independent full-page design artifact. It may define multiple
responsive frames under one revision. It does not require an application route.
Its Render Spec contains frame IDs, viewports, initial state/fixture, background,
and presentation metadata.

### ComponentDefinition and ComponentInstance

A Component Definition is a master design artifact with:

- named variants and states;
- a stable props/slots contract;
- responsive sizing behavior;
- preview fixtures and backgrounds;
- an immutable revision lineage.

A `ComponentInstance` belongs to a Page or another Component. It records:

- stable instance ID;
- owner artifact ID;
- component master ID;
- pinned component revision ID;
- selected variant/state;
- structured local overrides;
- a source/preview locator;
- linked or detached status.

Instances are not top-level canvas nodes. `uses` edges are derived from instance
relationships and become visible in the workspace graph through filters.

### Resource and ResourceRevision

Resources unify contextual inputs without replacing their owning systems:

```text
research | moodboard | sharingan-capture | file | asset | effect | external-reference
```

A Resource has a mutable Head and immutable revisions. A Resource Revision includes
a manifest, summary, checksum, provenance, source URLs or local paths, and its
creating Run where applicable. A graph edge may follow the Resource Head while the
workspace is being planned, but an approved Generation Plan pins exact revisions.

### WorkspaceEdge

Edges are versioned semantic relationships:

- `prototype`: Page to Page. State is `planned`, `interactive`, or `broken`.
- `uses`: Page/Component to Component, derived from linked instances.
- `informs`: Resource to Page/Component/Workspace.
- `derives-from`: Page/Component to a source Resource such as Sharingan Capture.

An interactive prototype edge additionally records:

- source Page and selected element/hotspot locator;
- trigger (`click`, `submit`, or explicitly supported event);
- target Page and target state;
- transition metadata;
- binding revision and validation status.

A planned edge is design intent, not proof of implementation. Deleting or changing
its source binding or target turns it into `broken`; it can never remain falsely
interactive.

### WorkspaceProposal and GenerationPlan

The Workspace Agent's first output is a structured `WorkspaceProposal`, never
source code. A Proposal records:

- base graph revision;
- proposed graph operations;
- rationale and explicit assumptions;
- proposed Resources and revision policy;
- component/page dependency plan;
- draft, approved, rejected, or superseded status.

The Proposal appears as an editable graph overlay. The user may rename, add,
archive, reconnect, regroup, or attach resources before approval.

Approval uses compare-and-swap on the base graph revision. A stale Proposal returns
a conflict and must be reviewed again. Approval compiles the Proposal into an
immutable `GenerationPlan` DAG.

### WorkspaceSnapshot

A Workspace Snapshot records:

- semantic graph revision;
- Artifact ID to active Artifact Track and Artifact Revision mapping;
- Resource ID to Resource Revision mapping;
- Shared Design Kernel revision;
- creating Proposal/Plan and checkpoint provenance.

Spatial layout is not part of the semantic revision, but an optional layout
snapshot may accompany a checkpoint for recovery and export.

Every successful Artifact Head publication, semantic graph change, Kernel change,
approved component propagation, or restore creates a new Workspace Snapshot.
Independent Generation Plan tasks may therefore publish useful partial progress as
separate snapshots; the final Plan checkpoint names the resulting snapshot. A pure
layout or viewport change never creates one. Snapshot publication uses
compare-and-swap against its base snapshot so concurrent work cannot silently
replace a newer mapping.

## Data ownership and persistence

- SQLite is the normalized working index and command boundary for graph, layout,
  Proposals, task state, and revision metadata.
- Semantic graph operations carry `baseGraphRevision` and apply atomically.
- Immutable workspace/context/resource manifests are written to durable local
  storage for replay, export, and audit.
- The existing internal Git-based source store remains the source snapshot and
  transaction engine where practical. Each artifact has a stable source root and
  an independent revision index even when multiple artifacts share one physical
  repository.
- `RenderAssemblyBuilder` materializes a Preview Target from one Artifact Revision,
  its pinned Component revision closure, and its pinned Kernel revision. This
  prevents an unapproved component update from changing existing Page pixels.
- React Flow nodes and edges are adapter output only. Persisting a raw
  `ReactFlowJsonObject` as domain truth is forbidden.
- Canvas position, size, collapsed groups, viewport, and selection are stored
  separately. Dragging saves on drag stop; viewport saves on move end with debounce;
  selection is ephemeral.
- Semantic deletion archives by default. Dependency-aware confirmation is required
  before archiving a Component, Resource, or Page with consumers/edges.

## Project Studio information architecture

Introduce a persistent project shell:

```text
/projects/:projectId/canvas
/projects/:projectId/artifacts/:artifactId
```

`ProjectStudio` remains mounted while switching between the overview and focused
artifact editor. It owns project-level graph state, viewport restoration, run/task
queue state, and the Workspace Agent conversation. The current monolithic
`WorkspaceScreen` is decomposed rather than extended with more project-global
preview state.

### Workspace canvas

The canvas uses custom React Flow nodes:

- Page card: current thumbnail, page name, frame count, revision, quality, run
  state, and incoming/outgoing prototype counts.
- Component card: specimen thumbnail, variants/states, current revision, consumer
  count, and pending-impact state.
- Resource card: type, title, pinned/latest state, provenance, and relevant counts.
- Layout group: spatial organization only, such as journey, feature, or product
  area.

Node cards use cached immutable WebP/PNG thumbnails. They never mount persistent
iframes or nested canvas runtimes.

Default-visible edges are prototype edges. `uses`, `informs`, and `derives-from`
edges are shown on selection or through a filter. Edge labels and animation appear
only when selected, hovered, broken, or actively generating.

Semantic zoom:

- below 0.38: type, title, and status only;
- 0.38 to 0.72: thumbnail and core metadata;
- above 0.72: handles, relationship details, and contextual actions.

The canvas supports pan/zoom, fit, minimap when useful, marquee and keyboard
multi-selection, grouping, incremental layout save, edge filters, and selection-to-
Agent Context. Custom `nodeTypes`, `edgeTypes`, callbacks, and store selectors remain
stable and memoized.

### Proposal review

Draft Proposal nodes and edges render as an overlay distinct from accepted graph
objects. The review surface exposes:

- additions, removals, and relationship changes;
- assumptions and unresolved inputs;
- resource attachments and pinned/latest policy;
- estimated generation tasks and dependency order;
- inline rename, add, remove, reconnect, and regroup actions;
- one explicit approval action.

No Artifact source, Graph Head, or Resource consumer changes before approval.

### Artifact editor

Page and Component share one focused `ArtifactEditor` shell:

- live rendered design in the center;
- outline/layers, instances, and attached Resources in a collapsible side surface;
- contextual direct-edit inspector;
- scoped Agent conversation and structured Context rail;
- frame/fixture, zoom, compare, version, and presentation controls.

The preview inspect bridge maps selected rendered elements to stable source and
component-instance locators. Selection becomes a typed Agent Context item, not raw
prompt text.

Direct edits are intentionally bounded:

- copy and accessible label;
- image/asset selection;
- token-backed color, typography, and surface values;
- supported size, spacing, alignment, visibility, and responsive controls;
- component variant/state and local instance overrides;
- prototype trigger binding.

Complex structural or aesthetic changes go through the scoped Agent. Deterministic
direct edits become validated mutation commands. Text typing is coalesced on blur;
each logical direct mutation creates undo history and a durable checkpoint according
to the artifact autosave policy.

Leaving the editor preserves the graph viewport, selection, Agent draft, artifact
frame, and inspector state. Historical revisions are read-only.

### Responsive and accessible behavior

- Desktop uses resizable editor/Agent surfaces.
- Narrow layouts replace permanent sidebars with tabs or sheets while retaining
  canvas pan/zoom, node selection, Agent access, and artifact preview.
- Nodes, edges, handles, menus, proposal changes, and generation states have
  keyboard access and explicit accessible names.
- State is never communicated by color alone.
- Reduced motion disables decorative edge and transition animation.
- Canvas and editor shortcuts ignore text fields, buttons, links, and interactive
  preview controls.

## Agent architecture

Introduce `AgentOrchestrator`. The existing run handler becomes a single-target
execution module instead of owning request parsing, Research, Context composition,
scheduling, publication, and QA in one function.

### Agent scopes

- Workspace Agent: reads graph/kernel summaries, creates Proposals, analyzes impact,
  and orchestrates approved plans. It cannot approve its own Proposal or directly
  edit artifact source.
- Page Agent: writes one Page source root, may change local instance overrides, and
  reads pinned components, prototype neighbors, Kernel, and attached Resources.
- Component Agent: writes one Component master, variants/states, and its public
  contract. Publication creates impact analysis but never propagates automatically.
- Resource Agent: creates immutable Research/Moodboard/Capture-derived Resource
  revisions and cannot modify consuming artifacts.

Conversations are scoped to workspace, artifact, or resource. Runs record scope,
base revision, Plan/Task IDs, attempt, and Context Pack ID. Run-to-artifact targets
are many-to-many so one orchestration run can record requested, created, touched,
deleted, or dependent artifacts.

### Context Resolver

The web client submits structured references. The daemon resolves them into an
immutable `ContextPack` with graph revision, target, resolved items, durable
manifest, token estimate, omissions, provenance, and checksum.

Priority order:

1. system contract, permissions, and Shared Design Kernel;
2. target Artifact Revision;
3. selected elements, instances, nodes, or edges;
4. explicit user attachments and Resource references;
5. direct `uses`, `informs`, and `derives-from` dependencies;
6. direct prototype predecessors/successors;
7. recent scoped-conversation summary;
8. request-relevant indirect resources.

The Resolver uses graph distance and edge type before FTS/BM25 ranking. Full project
source and complete history are never injected by default. Agents may inspect more
through bounded workspace/artifact/resource outline tools.

Task profiles reserve input budget for output and tools, then assign budget to
target, explicit references, dependencies, conversation, and indirect retrieval.
Explicit references may be summarized but never silently omitted. If required
Context still cannot fit, the task becomes `blocked-context` with a concrete reason.

Every resolved item records source revision, checksum, reason for inclusion, trust
level, excerpt/summary boundary, token estimate, and provenance. `provided`,
`observed-read`, and `agent-declared-used` remain distinct evidence states.

Existing Moodboard run snapshots are generalized into Resource Context adapters.
Every Run pins Resource revisions, so later edits cannot alter an active task.

### Plan-first generation

Approval compiles an immutable task DAG:

```text
Resource and Research tasks
          -> Component generation
          -> Page generation
          -> Prototype binding and graph validation
          -> Workspace checkpoint
```

Each task fixes target, base revision, Context Pack hash, Resource revisions,
Component dependencies, capabilities, QA profile, and prerequisite tasks.

Independent Components and Pages may run concurrently. Each task works in an
isolated directory and publishes only after source validation, render, and quality
gates succeed. Artifact Head publication uses compare-and-swap. A concurrent user
edit produces `needs-rebase` rather than an overwrite.

One task failure keeps successful revisions, marks its dependency subtree blocked,
and lets independent tasks continue. Users can retry the same inputs or retry with
latest Context; the UI distinguishes those choices.

Default concurrency limits are three Agent generation tasks, two render/visual QA
tasks, and two image-generation tasks, with one writer per Artifact/Resource and an
exclusive lock for Kernel mutation. Integration into the shared internal source
store is serialized.

### Failure recovery and safety

- Active tasks have durable state, heartbeat/lease, idempotency key, and replayable
  events. Interrupted daemon tasks resume from the last published revision.
- Transient Agent failures retry up to three times with bounded exponential backoff.
  Cancellation does not retry.
- Schema, path, no-change, build, render, and quality failures use bounded targeted
  repair and never loop blindly.
- Half-written workspaces never become Artifact Head.
- Agent source writes are restricted to the target source root. Kernel changes and
  component propagation require explicit workspace operations.
- All source and Resource paths are canonicalized and guarded against traversal and
  symlink escape.
- Resource text, captured DOM, uploaded documents, and external HTML are untrusted
  data, not system instructions.
- Workspace Agent cannot archive nodes, approve a Proposal, propagate a Component,
  or mark an edge interactive without validated user action/binding.
- A no-op Agent run ends as `no-artifact-change`, not generic success.

## Resource integration

### Research

Product and Visual tracks remain parallel and validated. A Research Revision owns
reports, sources, assets, directions, and chosen direction. Research can inform the
whole workspace or specific artifacts through explicit edges. A chosen direction
does not silently become global when only one artifact consumes it.

Visual Research may derive a Moodboard Resource while preserving the source
Resource/revision link and provenance.

### Moodboard

Moodboards remain editable Leafer boards. An Agent run consumes a fixed immutable
board snapshot, not the moving Head. Whole-board and selected-node references use
the same Resource Context adapter and retain asset paths, captions, provenance, and
budget omissions.

### Sharingan

Sharingan becomes a Capture Resource instead of only a project-wide boolean mode.
A capture session is mutable until published; a Capture Revision then fixes page
URLs, screenshots, DOM, styles, assets, render maps, probe manifest, checksums, and
authorization/provenance metadata.

Captured URLs may seed proposed Page nodes. Captured links become planned prototype
edge candidates. Each generated Page consumes only its matching capture evidence.

`derives-from` records fidelity as `exact` or `inspired`. Strict source-vs-generated
visual fidelity gates apply only to artifacts linked as `exact`; capture rules never
pollute unrelated workspace artifacts.

### Files, assets, Effects, and external references

These use the same immutable Resource Revision and Context Adapter contract. Code,
scripts, external pages, and HTML default to untrusted data. Updating a Resource
creates a revision; approved tasks remain pinned.

## Component publication and propagation

Publishing a Component creates a new master revision and an `ImpactReport`:

- direct and transitive consumers;
- removed or changed variants, props, slots, and states;
- incompatible local overrides;
- before/after component fixtures;
- before/after screenshots for affected Page frames;
- estimated propagation tasks.

The user may:

- keep all consumers pinned;
- update selected consumers;
- update all compatible consumers;
- detach selected instances;
- open an incompatible consumer for repair.

Each impact analysis is fixed to the component's from/to Revisions and a base
Workspace Snapshot. Override compatibility is resolved through stable prop, slot,
and design-node IDs; an override that cannot be mapped is blocking and is never
silently discarded.

Propagation is a new approved Proposal compiled into a `PropagationBatch`. The
batch records its base Snapshot, selected instances, isolated candidate revisions,
visual evidence, and terminal result. All selected consumers build and pass QA
before publication. Publication is all-or-nothing: if one consumer fails, a
dependency changes, or the base Snapshot becomes stale, no selected consumer Head
moves. Candidate revisions remain available for repair, retry, or reducing scope.
When every candidate passes, one transaction publishes all selected Heads and one
Workspace Snapshot. Historical revisions are never mutated; unselected consumers
remain pinned and visible.

## Viewer, Preview Targets, and prototype playback

Preview and Viewer use a discriminated target-safe contract:

```ts
type PreviewTarget =
  | { kind: "artifact-current"; projectId: string; artifactId: string; trackId?: string }
  | { kind: "artifact-revision"; projectId: string; revisionId: string }
  | { kind: "run-candidate"; projectId: string; runId: string }
  | { kind: "workspace-flow"; projectId: string; snapshotId: string; startArtifactId: string }
  | { kind: "component-state"; projectId: string; revisionId: string; variantKey: string; stateKey: string };
```

The daemon resolves `artifact-current` to an immutable Revision before it grants a
lease, and returns the resolved target ID, source tree checksum, dependency-lock
checksum, Render Spec, and optional Snapshot ID. Compare resolves both sides before
opening, and Flow Viewer pins one Workspace Snapshot for its entire session.

`RenderAssemblyBuilder` resolves the immutable target plus pinned dependencies. One
project runtime may serve many current targets; historical or compare targets use
isolated, leased assemblies. Runtime identity is not confused with artifact
identity.

Page Viewer renders a full-page frame. Component Viewer renders an isolated fixture
with explicit variant/state/background. Canvas thumbnails use immutable cached
captures keyed by the complete Preview Target and assembly checksum.

Artifact Compare permits Revision-to-Revision and Candidate-to-Current comparisons
with compatible frame/fixture, state, and viewport. Workspace Compare permits
Snapshot-to-Snapshot graph, Kernel, and revision-map comparison before drilling
into an Artifact. It supports side-by-side, overlay, source diff, and visual diff.
Per-pane failures stay independent and explicit; an incomplete side can never
produce a passed comparison.

Prototype Play Mode starts from a selected Page and follows validated interactive
edges. Planned edges are visible in flow inspection but not clickable. Broken edges
show their missing binding/target and repair action.

Historical Viewer is read-only. Repair actions require restoring or forking to a
new Head.

## Versioning and restore

- Artifact versions are numbered per Artifact Track lineage.
- Workspace checkpoints map the whole graph to exact Artifact/Resource/Kernel
  revisions.
- Workspace Snapshot ancestry represents whole-workspace history, while Artifact
  Tracks represent local explorations. The first release has one active Workspace
  Head plus named checkpoints; it does not add parallel workspace branches.
- Direct edits, Agent runs, component propagation, prototype binding, and restore
  create history-preserving revisions.
- Current short-term undo/redo remains separate from durable revision history.

Artifact restore applies the selected source/dependency state and creates a new
revision. It never resets or erases history. Dependency validation runs before
publication.

Component restore defaults to restoring the master while keeping consumers pinned.
Repinning selected or all consumers is a separate propagation Proposal with visual
impact review.

Workspace restore creates a new checkpoint/branch from the selected Snapshot. It
does not use destructive reset. Dirty or conflicting draft state blocks restore
until the user resolves or checkpoints it.

## Quality model

Artifact publication requires:

- source/build validation;
- artifact-kind static lint;
- runtime console, page, network, and response checks;
- visual QA for required Page frames or Component fixtures;
- immutable revision-scoped screenshots and findings;
- dependency and graph integrity checks.

Workspace quality additionally checks:

- missing Artifact/Resource/Revision references;
- broken or falsely interactive prototype edges;
- missing Component variants/slots/props used by instances;
- incompatible overrides;
- token and design-kernel drift;
- orphaned required artifacts and blocked Generation Plan tasks;
- affected-consumer regressions after shared changes.

Quality states distinguish `passed`, `needs-attention`, `failed`, and `unassessed`.
An unavailable reviewer or missing evidence never becomes a clean score. Shared
changes rerun only the dependency closure plus workspace graph gates.

## Error semantics

- Stale Proposal: conflict with latest graph diff; no mutation.
- Stale Artifact base: `needs-rebase`; no Head overwrite.
- Missing required Context/Resource: task is blocked with actionable details.
- Independent generation failure: node fails; unrelated nodes continue.
- Component incompatibility: consumer stays pinned; propagation task is blocked.
- Preview assembly failure: target-specific error; other Viewer panes and nodes stay
  usable.
- Broken prototype binding: edge becomes `broken`; Play Mode refuses the transition.
- Daemon restart: active task becomes interrupted and resumes/retries idempotently.
- Cancellation: active tasks stop, pending tasks skip, published revisions remain.
- No artifact change: explicit failure, not a generic assistant completion.

## Migration and compatibility

1. Additive schema migrations create workspace, graph, layout, proposal, task,
   artifact revision, resource revision, context pack, instance, and target tables.
2. `ensureWorkspace(projectId)` lazily creates a workspace for existing projects.
3. Existing single artifacts appear as one synthesized Page node without moving
   source files or rewriting history.
4. Existing Standard Runs backfill into the synthesized Page lineage where their
   source snapshot is available.
5. The first multi-artifact release enables Project Workspace only for Standard
   projects. Prototype `index.html` projects keep the existing single-page surface
   and APIs; they are not automatically converted. A later explicit upgrade may use
   a static-HTML Page adapter, but must preserve the original restorable snapshot.
6. Existing Sharingan projects retain their compatibility flag while published
   captures are exposed as Capture Resources.
7. Existing Research and Visual Moodboards are wrapped as Resources with provenance
   rather than copied destructively.
8. Existing project/moodboard/Effect context APIs remain available while the new
   structured Context Resolver becomes the canonical path.
9. The current export format is v2. Workspace export increments it to v3 and adds
   graph, layout, snapshots, Artifact Tracks and Revisions, Resource Revisions,
   dependency locks, source manifests, and evidence. Import continues to accept
   v1/v2; a v2 Standard project is wrapped as one Page and its Project Variants are
   mapped to Artifact Tracks. Import v3 preserves stable IDs and relationships.
10. New APIs are additive until live migration and rollback fixtures pass.

## Performance requirements

- Canvas nodes use thumbnails, never persistent iframes.
- Custom node/edge components and callbacks are stable and memoized.
- Selection IDs are stored separately so inspector/Agent surfaces do not subscribe
  to the full nodes array.
- Large graphs collapse groups and non-selected relation types.
- Only visible elements may be enabled after measured validation.
- Performance fixtures cover 50/200/500 nodes and 100/500/2000 edges.
- Pan, zoom, selection, and drag remain interactive under the 200-node target
  fixture on supported desktop hardware; no Home/Settings initial bundle may import
  the workspace-canvas chunk.
- Thumbnail requests are cancellable, revision-keyed, lazy, and bounded.

## Testing strategy

### Core and store

- schema migration and legacy wrapping;
- graph command validation, optimistic revision conflict, archive guards;
- layout persistence independent from semantic revisions;
- Artifact/Resource revision immutability;
- Component instance pins, variants, overrides, detach, and impact closure;
- Workspace Snapshot serialization and import/export v1/v2/v3.

### Daemon

- structured Proposal validation and stale approval rejection;
- Generation Plan compilation and dependency ordering;
- actual independent-task concurrency and single-writer locks;
- partial failure, retry, cancellation, restart, idempotency, and rebase;
- deterministic Context resolution, budgets, omissions, provenance, and hashes;
- Page/Component/Resource source-root confinement;
- Render Assembly current/historical/pinned-component behavior;
- target-safe preview, compare, restore, and immutable evidence;
- Research/Moodboard/Sharingan adapters and exact-scope fidelity;
- graph and affected-consumer quality gates.

### Web

- node/edge kinds, statuses, semantic zoom, filters, grouping, and incremental save;
- Proposal overlay editing and one explicit approval action;
- keyboard canvas operation, accessible labels, reduced motion, and narrow layouts;
- ProjectStudio route persistence and canvas return state;
- Page/Component editor scopes, selected-element Context, direct edit commands;
- prototype planning, binding, playback, and broken-state repair;
- component Impact Report and selective propagation;
- Artifact version list, compare target lock, restore/fork, and historical read-only
  behavior;
- partial task failure and retry controls.

### End-to-end

1. Request two Pages, two Components, Research, and a flow.
2. Review and edit the Proposal; verify no source mutation before approval.
3. Approve; verify Resources/Components precede Pages and independent tasks overlap.
4. Inspect Page and Component artifacts, structured Context, versions, and evidence.
5. Bind a planned flow, play it, break its source, and repair it.
6. Publish a Component update, inspect consumer diffs, update selected instances,
   and confirm other consumers stay pinned.
7. Compare and restore an Artifact without losing history.
8. Restore a Workspace Snapshot to a new checkpoint/branch.
9. Create artifacts from Research, Moodboard, and a multi-page Sharingan Capture and
   confirm each receives only relevant pinned evidence.
10. Restart the daemon during generation and verify safe recovery without duplicate
    revision publication.

Final acceptance includes real browser/Electron verification of the workspace
canvas, focused editors, proposal approval, partial failure, prototype playback,
component propagation, compare/restore, and migrated legacy projects.

## Implementation slices

The architecture is one feature but implementation is staged to preserve working
software after each slice:

1. **Foundation and compatibility**: domain types, schema/store, graph commands,
   snapshots, legacy Page wrapper, APIs, and ProjectStudio shell.
2. **Canvas and Proposal**: xyflow adapter, node/edge UI, layout persistence,
   Proposal review/approval, statuses, accessibility, and performance fixtures.
3. **Artifact targets and editor**: Page/Component contracts, ArtifactEditor,
   Preview Target, Render Assembly, thumbnails, selected-element bridge, and direct
   edits.
4. **Agent orchestration**: scoped conversations, Context Resolver, immutable packs,
   Generation Plan DAG, scheduler, isolated task publication, recovery, and partial
   retries.
5. **Components and prototypes**: instance pins/overrides/detach, impact reports,
   propagation Proposals, planned/interactive/broken edges, and Play Mode.
6. **Versions, Viewer, and quality**: artifact lineage, workspace checkpoints,
   compare/restore, immutable evidence, dependency-aware QA, and historical safety.
7. **Resource migration**: Research, Moodboard, Sharingan, files/assets/Effects,
   export/import v3, live migration, and complete end-to-end verification.

Each slice must ship with its own focused tests and a reviewer pass. Later slices may
depend on earlier contracts but may not replace them with shortcut project-wide
state.
