# Roadmap

Dezin is an early open-source release. The core loop — describe → generate → lint → repair → preview → export — works end to end, across multiple agent CLIs, in both Prototype and Standard modes. This file is an honest list of what's solid and what's still rough or unbuilt.

## Shipped

- Closed anti-slop **lint → repair loop** with a single source of truth (linter rules generate the craft doc; a drift test enforces it).
- **Multi-agent BYOK** — Claude Code, Codex, Gemini CLI, Cursor Agent, CodeBuddy, Copilot, Qwen, opencode, Kimi CLI, Trae CLI, Pi, Hermes — scanned from PATH, picked per run, with the agent's real version.
- **Prototype** (single HTML) and **Standard** (Vite + React project) build modes.
- **33 built-in design systems** with brand marks; import your own from a code folder or a `.fig` file.
- **Variant branches**: fork, iterate independently, and **compare** with a draggable slider.
- **Parallel variant generation**: fan one Standard prompt out to 2–4 seeded branches, run each independently, and compare the results without stealing the active branch.
- **Versions workspace**: per-branch run/version history, file preview, restore, diff, compare, and chat jump actions.
- **References**: attach another project's real artifact, drop screenshots, paste local paths.
- **Moodboards**: create local boards for visual references, arrange images/notes/sections/generator nodes on the canvas, and use a board-scoped Agent panel.
- **Project-to-Moodboard references**: attach a Moodboard from the project composer; the Agent receives budgeted board structure, notes, recent context, and local asset paths without storing a full canvas dump in the visible conversation.
- Streaming **process view**, durable run event replay/reconnect, sandboxed preview, `.zip` export, command palette, dark mode.
- Optional **agent-backed visual QA** for rendered screenshots and viewport geometry.
- **Electron desktop** shell with off-screen capture, and a **Chrome extension** for cover-image capture.
- **Live agent model discovery with seed fallback**: providers use their CLI/API model list when available and retain curated seed models when discovery is unavailable.
- **CI quality gates**: full workspace tests, measured coverage floors, typechecking, bundle budgets, child-process leak detection, and high-severity production dependency audit.

## TODO / rough edges

- [ ] **Standard-mode hardening.** Building real Vite projects works but is newer than the prototype path; expect more edge cases (dependency installs, dev-server lifecycle, larger file trees).
- [ ] **Design-system import depth.** `.fig` parsing extracts palette / frames / fonts; code-folder import hands files to the agent. Neither yet produces a full 9-section `DESIGN.md` as polished as the hand-authored built-ins.
- [ ] **Desktop packaging.** The Electron app runs, but code-signing, notarization, and distribution (installers, auto-update) are intentionally not done.
- [ ] **Chrome extension polish.** Functional capture-to-composer; not packaged for the Web Store, limited site coverage.
- [ ] **Release automation.** CI quality gates now run on pushes and pull requests, but tagged release packaging and publishing remain manual.
- [ ] **Broader test coverage** for newer UI surfaces and workflows (agent scan, references, Moodboard edge cases, Standard-mode edge cases).

## Explicitly out of scope

Deliberately not built, and not planned: telemetry, hosted inference / a paid model router, a plugin marketplace, "connectors", GitHub code-linking as a managed integration, and ambient automation. Dezin stays local-first and BYOK.

Have a use case that needs one of the TODOs? Open an issue — see [`CONTRIBUTING.md`](./CONTRIBUTING.md).
