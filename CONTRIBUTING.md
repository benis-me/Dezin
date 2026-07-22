# Contributing to Dezin

Thanks for taking a look. Dezin is small and opinionated by design — contributions that keep it that way are very welcome.

## Setup

Prerequisites: **Node ≥ 22.16**, **pnpm 11**. For real generation you also need a coding-agent CLI on your PATH (Claude Code, Codex, Gemini CLI, Cursor Agent, CodeBuddy, Copilot, Qwen, opencode, Kimi CLI, Trae CLI, Pi, or Hermes), authenticated.

```sh
pnpm install
pnpm dev          # daemon + web UI together
```

You can develop and run the whole test suite **without any agent installed** — generation is the only part that needs one.

## Checks before you push

```sh
pnpm test           # every script, package, app, and Web suite
pnpm test:coverage  # the same suites with implementation-only coverage floors
pnpm typecheck      # Node program, Web, and Leafer type checks
pnpm build:check    # production build, bundle budgets, and lazy-boundary guards
pnpm run ci         # all CI gates above plus the production dependency audit
```

The GitHub workflow runs the same gates on Node 22.16 and pnpm 11.9.

## How it's laid out

See the architecture map in the [README](./README.md#architecture). The short version:

- `packages/quality` — the anti-slop linter and the closed lint→repair loop. This is the heart of the project.
- `packages/agent` — wires generation to whichever CLI runner the user picked.
- `apps/daemon` — the Node (`node:http` + `node:sqlite`) backend; no build step.
- `apps/web` — the React 19 + Tailwind v4 UI.
- `content/` — the design systems, skills, and the generated craft doc.

## Two rules that matter

1. **The anti-slop doc is generated, not edited.** `content/craft/anti-ai-slop.md` is produced from the linter's rule lists in `packages/quality`. A drift test fails if they diverge. If you change a rule, regenerate the doc (see `packages/craft`) rather than editing the markdown by hand.
2. **Keep the backend hermetic.** The daemon and packages run on Node built-ins with TypeScript type-stripping — no build step, no native modules, no runtime dependencies. Please don't add a bundler or a native dep to that path.

## UI / design conventions

The app practises what it preaches: neutral monochrome palette (no "AI purple"), borders over shadows, tactile `:active` states, and a `prefers-reduced-motion` path for every animation. No em-dashes in user-facing copy. Match the surrounding components — reach for the shared `ui/` primitives before hand-rolling.

## Commits & PRs

- Keep changes focused; one concern per PR.
- Run the checks above and mention what you verified.
- Describe the user-visible effect, not just the diff.

## Reporting issues

Bugs, rough edges, and TODOs from the [roadmap](./ROADMAP.md) are all fair game. Include your OS, Node version, the agent CLI you used, and steps to reproduce.
