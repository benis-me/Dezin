# Contributing to Dezin

Thanks for taking a look. Dezin is small and opinionated by design. Contributions that keep it that way are very welcome.

The authoritative description of what the product does today is [`docs/DESIGN-CANVAS.md`](./docs/DESIGN-CANVAS.md). If this file and that one disagree, that one wins.

## Setup

Prerequisites: **Node 22.16 or newer** (see `.nvmrc`), **pnpm 11**. For real generation you also need a coding-agent CLI on your PATH (Claude Code, Codex, Gemini CLI, Cursor Agent, CodeBuddy, Copilot, Qwen, opencode, Kimi CLI, Trae CLI, Pi, or Hermes), authenticated.

```sh
pnpm install
pnpm dev          # daemon + web UI together; reuses a daemon that is already running
```

You can develop and run the whole test suite **without any agent installed**. Generation is the only part that needs one.

## Checks before you push

```sh
pnpm test           # every script, package, app, and Web suite; runs all suites, then lists failures
pnpm test:coverage  # the same suites with implementation-only coverage floors
pnpm typecheck      # Node program, Web, and Leafer type checks
pnpm build:check    # production build, bundle budgets, and lazy-boundary guards
pnpm run ci         # all CI gates above plus the production dependency audit
```

The GitHub workflow runs the same gates on Node 22.16 and pnpm 11, plus the desktop and extension suites on macOS.

## How it's laid out

See the architecture map in the [README](./README.md#architecture). The short version:

- `apps/daemon` is the Node (`node:http` + `node:sqlite`) backend. It runs from TypeScript source with type stripping; there is no build step.
- `apps/web` is the React 19 + Tailwind v4 UI. The Design Canvas uses `@xyflow/react`; Moodboards use Leafer. Both stay.
- `apps/desktop` is the Electron shell; `apps/extension` is the Chrome reference-capture extension.
- `packages/agent` wraps the provider CLIs; `packages/core` is the SQLite store; `packages/design` and `packages/effects` hold bundled content models; `packages/design-canvas-contracts` is the browser-safe wire contract shared by daemon and Web.
- `content/design-systems` holds the bundled Design Systems that `packages/design` loads.

## Dependency policy

- **Daemon and packages.** Prefer Node built-ins. Runtime dependencies are allowed when they carry real weight and are listed in `apps/daemon/package.json` for a reason you can name: `vite` and `typescript` build and check Implementation Exports, `puppeteer-core` drives the Chrome gates, `parse5` and `lightningcss` parse generated HTML/CSS, `@napi-rs/canvas` rasterizes captures, `ai` and the `@ai-sdk/*` providers power Moodboard image generation with the user's own keys. Do not add a bundler to the daemon path, and do not add a native module without opening an issue first.
- **Web.** One icon set (`lucide-react`) plus `@lobehub/icons-static-svg` for AI-provider marks; one Markdown renderer (`streamdown`). Reach for what is already installed before adding a library, and remove a dependency when its last import goes.
- **Lockfile.** `pnpm-lock.yaml` is the only lockfile. Vendored `vendor/*.tgz` packages come from the Capability Foundry repository; see `vendor/README.md` for how to refresh them.

## UI and copy conventions

The app practises what it preaches: neutral monochrome palette (no "AI purple"), borders over shadows, tactile `:active` states, and a `prefers-reduced-motion` path for every animation. Match the surrounding components and reach for the shared `ui/` primitives before hand-rolling.

User-facing copy is English, uses no em dashes (a test in `apps/web` enforces this), and names things by what people recognize. Dates and times are formatted through `apps/web/src/lib/format-date.ts` so the UI does not switch language with the browser locale.

## Commits and PRs

- Keep changes focused; one concern per PR.
- Run the checks above and mention what you verified.
- Describe the user-visible effect, not just the diff.

## Reporting issues

Bugs, rough edges, and TODOs from the [roadmap](./ROADMAP.md) are all fair game. Include your OS, Node version, the agent CLI you used, and steps to reproduce.
