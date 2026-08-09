# Roadmap

Dezin is an early open-source Design Canvas. This file describes the current product, not the retired Prototype/Standard workspace.

## Shipped

- Infinite **Design Canvas** with typed generative and material Nodes.
- Immutable, checksum-bound Node Versions and content-addressed Asset bundles.
- Revision-CAS Canvas mutations, local viewport authority, undo/redo, semantic arrange, resize, and version switching.
- **Main Agent** text conversation, bounded Canvas plans, and scoped child dispatches.
- **Node Agents** with frozen Canvas context and target-only publication.
- Installed-provider/custom-CLI selection with model discovery; strict Claude/CodeBuddy execution identity and exact pending-directory confinement for every Design runner.
- Provider-neutral durable Job activity, cancellation, idempotency, restart recovery, and semantic status presentation.
- Atomic migration backup and receipt before destructive retirement of old SQLite Design tables.
- Imported images/documents and exact cross-project Version references.
- Local single-HTML Node preview with strict URL, DOM-capability, asset, and responsive-output validation.
- **Implementation Export** to an immutable local Vite + TypeScript directory with a frozen manifest, strict source/built-output scanning, CSP, TypeScript, isolated Vite build, and Chrome desktop/mobile visual evidence.
- One bounded continuation for incomplete/timeout Export work and one bounded validation-repair turn.
- Moodboards, Design Systems, Effects, Settings, Electron development shell, and Chrome reference-capture extension.
- CI gates for tests, measured coverage floors, typechecking, bundle budgets, child-process leaks, and high-severity production dependency audit.

## Required before the next release

- [ ] Complete a quota-backed production-path CodeBuddy `hy3-ioa` Canvas + Implementation Export receipt, including every deterministic Node route and immutable output hash.
- [ ] Add provider-version black-box confinement receipts for additional real CLIs; generic providers are available, but do not yet have Claude/CodeBuddy's verified tool and execution-identity guarantees.
- [ ] Exercise first-fit geometry, persisted resize, light/dark appearance, reduced motion, tooltips, and live activity motion in packaged Electron on macOS.
- [ ] Package, sign, notarize, and distribute the Electron application.

## Architecture follow-ups

- [ ] Split Canvas storage into Canvas state, Asset/Version publication, Job/Thread ledger, frozen context, and static validation modules.
- [ ] Extract Implementation Export from the global-Agent module behind one production adapter shared by HTTP and QA.
- [ ] Stream persisted Job activity over SSE instead of polling while preserving durable replay.
- [ ] Move the initial Home→Canvas intent handoff from session storage to an idempotent daemon bootstrap Job.
- [ ] Publish shared pure Design Canvas contracts for daemon and Web rather than maintaining mirrored unions.
- [ ] Split the largest Canvas screen and Agent panel along controller/view boundaries and add focused browser interaction coverage.

## Formally retired from the primary Canvas contract

The repository still contains useful standalone or historical code for these concepts, but the current application does not claim them as shipped Canvas features:

- Prototype/Standard build-mode selection.
- Project variant branches and the old Files/Versions workspace.
- The staged Research direction gate.
- The global `skills × design systems × craft` prompt stack.
- The legacy `@dezin/quality` anti-slop lint→repair loop as a Canvas publication gate.
- Browser ZIP download for Implementation Export; publication currently produces a local immutable directory.

Reintroducing one of these requires a new Canvas-native contract, tests, and documentation—it must not be inferred from the retained package alone.

## Explicitly out of scope

Hosted inference, a paid model router, telemetry, managed connectors, a plugin marketplace, and ambient background automation. Dezin remains local-state-first and uses provider CLIs under the user's own accounts.
