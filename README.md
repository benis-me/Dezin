<div align="center">

# Dezin

**A local-first Design Canvas powered by the coding-agent CLI you already use.**

English · [简体中文](./README_CN.md)

</div>

---

Dezin is an early desktop-first design tool. A project is an infinite Canvas of typed Nodes—Pages, Components, Design Systems, Research, Tokens, Documents, Layouts, Knowledge, and imported media. Agents can plan the Canvas, generate one Node at a time, and rebuild selected immutable versions into an implementation project.

Project state, Canvas history, generated versions, assets, Agent threads, jobs, and exports stay on local disk. Dezin operates no servers: there is no hosted account, telemetry, or model router. Everything that leaves your machine is listed under [Network egress](#network-egress) and happens with credentials you supplied.

## Current product contract

- **Canvas-first projects.** There is one primary Design Canvas workflow. The former Prototype/Standard mode selector, project variants, and Files/Versions workspace are not part of the current UI.
- **Typed Nodes and immutable Versions.** Generated HTML is published as immutable, checksum-bound Node Versions. Imported media is content-addressed. Canvas mutations use revision compare-and-swap, and undo/redo never rewrites published bytes.
- **Main and Node Agents.** The Main Agent can discuss a request, apply bounded Canvas commands, and dispatch scoped Node Jobs. A Node Agent can publish only its target Node. Ordinary conversation remains text and causes no Canvas mutation.
- **Bring your own Agent.** Dezin discovers installed provider CLIs and custom commands and exposes their available models. Claude and CodeBuddy receive the strongest tool/argument and execution-identity policy; every provider is still restricted to an exact daemon-owned pending working directory and a narrowed environment. Windows Design execution remains unavailable until its confinement can be proven.
- **Local, explicit assets.** Frozen context is byte-copied into each Job. Generated HTML cannot load remote scripts, styles, fonts, images, or other resources. Remote Markdown images in the app are never fetched automatically; they remain explicit links.
- **Implementation Export.** Export rebuilds selected immutable Node Versions as a Vite + TypeScript project in a local export directory. It does **not** currently download a ZIP.
- **Fail-closed validation.** Node HTML and Export source pass path allowlists, URL/DOM capability checks, CSP binding, strict TypeScript, an isolated Vite build, built-output scanning, and a Chrome desktop/mobile visual gate before publication. Export validation is intentionally narrow and security-focused; it is not a taste linter.
- **Bounded recovery.** Export may continue one incomplete or timed-out build in place and may run one diagnostic repair turn. Identity drift, frozen-input changes, unauthorized paths, and repeated validation failures are terminal.

The earlier `skills × design systems × craft` generation pipeline, staged Research direction gate, deterministic lint→repair loop, Prototype/Standard modes, branch variants, and ZIP delivery are no longer in the repository. See [`docs/DESIGN-CANVAS.md`](./docs/DESIGN-CANVAS.md) for the authoritative architecture and [`docs/DESIGN-PROCESS.md`](./docs/DESIGN-PROCESS.md) for the archived description of that predecessor.

## Supporting surfaces

- **Moodboards** for local reference material, notes, sections, and generated-image Nodes.
- **Design Systems** catalogue and custom-system import.
- **Effects** catalogue and editable effect projects.
- **Electron desktop shell** with native reveal/open integration and off-screen preview capture.
- **Chrome extension** for capturing reference imagery into Dezin.
- **Settings and model discovery** for installed Agents.

## Quick start

Prerequisites: **Node ≥ 22.16**, **pnpm 11**, and at least one authenticated coding-agent CLI on `PATH`.

```sh
pnpm install
pnpm dev
```

`pnpm dev` starts the local Node daemon and Vite UI. Open the printed URL, create a project, and use the Main Agent or `+ Add` to build the Canvas.

### Desktop

```sh
pnpm desktop
```

This builds the Web UI and launches Electron. Packaging, signing, notarization, and auto-update are not yet shipped.

### Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `DEZIN_PORT` | ephemeral | Fixed daemon port; development normally uses `7457` |
| `DEZIN_HOST` | `127.0.0.1` | Daemon bind address |
| `DEZIN_DATA_DIR` | `~/.dezin` | Local database, projects, assets, Jobs, and exports |
| `DEZIN_AGENT_CMD` | `claude` | Default Agent command |
| `DEZIN_SECRETS_KEY` | unset | 32-byte base64url key that encrypts API keys in the settings database and the stored Figma token at rest; the desktop shell generates and stores one through the OS keystore |

## Architecture

```text
apps/
  daemon/    local HTTP API, Canvas authority, Agent Jobs, validation, Export
  web/       React 19 Design Canvas, Moodboards, systems, Effects, settings
  desktop/   Electron shell and native integration
  extension/ Chrome reference capture
packages/
  agent/     provider runners and stream parsing
  core/      node:sqlite metadata and legacy Sharingan workspace state
  design/    bundled Design Systems
  effects/   built-in and custom Effect models
  design-canvas-contracts/  browser-safe wire contracts shared by daemon and Web
  leafer-react/             React reconciler bridge for the Moodboard canvas
content/
  design-systems/           bundled Design Systems loaded by packages/design
```

The active Design path is:

```text
React Canvas
  → daemon revision-CAS and durable Job ledger
  → Agent in a project-owned pending directory
  → immutable Node Version
  → frozen Export context
  → TypeScript/Vite/static/Chrome gates
  → immutable local export directory + manifest
```

Old SQLite Design tables are destructively retired only after the daemon creates a full `VACUUM INTO` backup and a migration receipt. Current Canvas project data is file-backed under each project's `design/` directory.

## Verification

```sh
pnpm test
pnpm test:coverage
pnpm typecheck
pnpm build:check
pnpm run ci
```

The CI command runs workspace tests and coverage floors, type checks, production build and bundle budgets, process-leak checks, and the high-severity production dependency audit. Real provider QA is opt-in because it consumes provider quota:

```sh
DEZIN_QA_CODEBUDDY=1 pnpm qa:design:codebuddy
```

The CodeBuddy receipt is valid only when the production runner/confinement path uses model `hy3-ioa` and the resulting Canvas/Export artifacts pass their normal gates.

## Documentation

- [`docs/DESIGN-CANVAS.md`](./docs/DESIGN-CANVAS.md) — authoritative current data, Agent, interaction, and Export contracts.
- [`ROADMAP.md`](./ROADMAP.md) — shipped scope and remaining work.
- [`docs/SELF-DESIGN.md`](./docs/SELF-DESIGN.md) — UI design principles.
- [`docs/DESIGN-PROCESS.md`](./docs/DESIGN-PROCESS.md) — archived pre-Canvas pipeline; not a current runtime promise.
- [`CONTRIBUTING.md`](./CONTRIBUTING.md) — development and contribution guide.

## Support matrix

| Platform | Run the app | Agent generation and Export |
| --- | --- | --- |
| macOS | Yes (development shell) | Yes |
| Linux | Yes | Yes |
| Windows | Yes | Not yet: Design execution stays fail-closed until process confinement is proven there |

Packaged, signed builds are not shipped yet; run from source with `pnpm dev` or `pnpm desktop`.

## Network egress

Dezin itself never phones home. These are the only outbound connections. Each one is started by an explicit action and authenticated with credentials you supplied:

| Feature | Destination | Credential |
| --- | --- | --- |
| Design Canvas Agents, Moodboard Agent, prompt optimization, title generation, image analysis | Your coding-agent CLI's own provider (Claude Code, Codex, CodeBuddy, ...) | The CLI's login |
| Moodboard image generation | Azure OpenAI, Google AI Studio, Google Vertex, fal, or any OpenAI-compatible endpoint you configure | API key in Settings → Providers |
| Model discovery | The configured provider endpoint, or a local Ollama at `127.0.0.1:11434` | Same key |
| Figma import | `api.figma.com` | Personal access token in Settings |
| Chrome extension capture | The page you capture (Pinterest, Behance, Dribbble and their image CDNs) and your local daemon | Pairing code |
| Sharingan capture | The URL you enter, fetched by local Chrome | None |

Generated HTML and Implementation Exports are validated to load no remote scripts, styles, fonts, or images.

## Trademarks

Bundled Design Systems are named for the public products whose design language inspired them (for example Airbnb, Apple, Linear, Stripe). Those names are trademarks of their respective owners. Dezin is not affiliated with, sponsored by, or endorsed by any of them, and ships none of their logos.

## License

[MIT](./LICENSE)
