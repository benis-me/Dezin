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
- Local single-HTML Node preview with strict URL, DOM-capability, asset, and responsive-output validation; focused Pages can be downloaded as checksum-verified, self-contained portable HTML.
- First Page publication requires one semantic `<title>` and adopts it as the default Node name; bounded transient-provider, incomplete-artifact, and validation-repair paths keep recovery fail-closed.
- Failed Node, Main, and Implementation Export Jobs expose an idempotent immutable-successor Retry/Repair path instead of hiding action failures.
- **Implementation Export** to an immutable local Vite + TypeScript directory with a frozen manifest, strict source/built-output scanning, CSP, TypeScript, isolated Vite build, and Chrome desktop/mobile visual evidence.
- One bounded continuation for incomplete/timeout Export work and one bounded validation-repair turn.
- Moodboards, Design Systems, Effects, Settings, Electron development shell, and Chrome reference-capture extension.
- CI gates for tests, measured coverage floors, typechecking, bundle budgets, child-process leaks, and high-severity production dependency audit.

## Required before the next release

- [x] Complete a quota-backed production-path CodeBuddy `hy3-ioa` Canvas + Implementation Export receipt, including every deterministic Node route and immutable output hash.
- [ ] Add provider-version black-box confinement receipts for additional real CLIs; generic providers are available, but do not yet have Claude/CodeBuddy's verified tool and execution-identity guarantees.
- [ ] Exercise first-fit geometry, persisted resize, light/dark appearance, reduced motion, tooltips, and live activity motion in packaged Electron on macOS.
- [ ] Package, sign, notarize, and distribute the Electron application.

## Architecture follow-ups

- [x] Split Canvas storage into a stable facade over primitives, Canvas state, Asset/Version publication, Job/Thread ledger, frozen context, URL handling, and static validation modules.
- [x] Extract Implementation Export from the global-Agent module behind one production adapter shared by HTTP and QA.
- [x] Replace Canvas/Job/Thread polling with a persisted, replayable SSE invalidation journal.
- [x] Replace the initial Home→Canvas session handoff with an idempotent, restart-recoverable daemon bootstrap Job.
- [x] Publish shared pure Design Canvas contracts for daemon and Web rather than maintaining mirrored unions.
- [x] Split Canvas and Agent state into controllers and extract header, focus chrome, tool docks, and Agent-panel views with focused interaction coverage.
- [x] Ship the first filesystem-authoritative Figma URL import: strict Design/File/Board/Slides and branch parsing, local PAT/env credential handling, exact-version REST fencing, durable cross-process replay/recovery, and atomic `Design.md`/`tokens.json`/`components.json` material Nodes. Pixel-perfect clone, binary capture, OAuth, refresh/diff, and native semantic bundles remain follow-ups documented in [docs/FIGMA-IMPORT.md](docs/FIGMA-IMPORT.md).

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
