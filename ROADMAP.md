# Roadmap

Dezin is an early open-source release. The core loop — describe → generate → lint → repair → preview → export — works end to end, across multiple agent CLIs, in both Prototype and Standard modes. This file is an honest list of what's solid and what's still rough or unbuilt.

## Shipped

- Closed anti-slop **lint → repair loop** with a single source of truth (linter rules generate the craft doc; a drift test enforces it).
- **Multi-agent BYOK** — Claude Code, Codex, Gemini CLI, Cursor Agent, opencode, Aider — scanned from PATH, picked per run, with the agent's real version.
- **Prototype** (single HTML) and **Standard** (Vite + React + GSAP project) build modes.
- **33 built-in design systems** with brand marks; import your own from a code folder or a `.fig` file.
- **Variant branches**: fork, iterate independently, and **compare** with a draggable slider.
- **Versions workspace**: per-branch run/version history, file preview, restore, diff, compare, and chat jump actions.
- **References**: attach another project's real artifact, drop screenshots, paste local paths.
- Streaming **process view**, durable run event replay/reconnect, sandboxed preview, `.zip` export, command palette, dark mode.
- Optional **agent-backed visual QA** for rendered screenshots and viewport geometry.
- **Electron desktop** shell with off-screen capture, and a **Chrome extension** for cover-image capture.

## TODO / rough edges

- [ ] **Parallel variant generation.** Today variants are created by *fork → iterate each separately*. The "one prompt → fan out N approaches at once → compare" flow isn't wired yet — the branch infrastructure is there, the fan-out scheduler and progress UI are not.
- [ ] **Real per-agent model enumeration.** Agent *versions* are probed for real (`--version`), but the per-agent **model lists are curated**, because there's no standard cross-CLI "list models" command. If an agent exposes one, wire it up for that agent.
- [ ] **Standard-mode hardening.** Building real Vite projects works but is newer than the prototype path; expect more edge cases (dependency installs, dev-server lifecycle, larger file trees).
- [ ] **Design-system import depth.** `.fig` parsing extracts palette / frames / fonts; code-folder import hands files to the agent. Neither yet produces a full 9-section `DESIGN.md` as polished as the hand-authored built-ins.
- [ ] **Desktop packaging.** The Electron app runs, but code-signing, notarization, and distribution (installers, auto-update) are intentionally not done.
- [ ] **Chrome extension polish.** Functional capture-to-composer; not packaged for the Web Store, limited site coverage.
- [ ] **CI / release automation.** Not set up for this initial release.
- [ ] **Broader test coverage** for newer UI surfaces and workflows (agent scan, references, Standard-mode edge cases).

## Explicitly out of scope

Deliberately not built, and not planned: telemetry, hosted inference / a paid model router, a plugin marketplace, "connectors", GitHub code-linking as a managed integration, and ambient automation. Dezin stays local-first and BYOK.

Have a use case that needs one of the TODOs? Open an issue — see [`CONTRIBUTING.md`](./CONTRIBUTING.md).
