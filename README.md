<div align="center">

# Dezin

**A local-first, tasteful design generator.**
Describe what you want; Dezin drives the coding-agent CLI you already have to build it as a real, self-contained artifact — and holds the output to a strict anti-AI-slop standard.

English · [简体中文](./README_CN.md)

<br />

<img src="./docs/assets/home.png" alt="Dezin — Start a design" width="960" />

</div>

---

Dezin is deliberately minimal — no telemetry, no hosted automation, no connectors, no paid model router, no plugin marketplace. Just the local loops that make generation good.

**BYOK, nothing leaves your machine.** Dezin shells out to a coding-agent CLI you already have installed and authenticated — Claude Code, Codex, Gemini CLI, Cursor Agent, CodeBuddy, Copilot, Qwen, opencode, Kimi CLI, Trae CLI, Pi, or Hermes. There is no Dezin account, no hosted inference, no API key to paste. The daemon binds to `127.0.0.1` and writes everything under `~/.dezin`.

## What makes it work

Three ideas do the work:

- **An anti-AI-slop quality kernel.** A deterministic linter flags the tells of machine-generated design — default Tailwind indigo, two-stop "trust" gradients, emoji-as-icons, invented metrics, filler copy, shadow-heavy cards — as P0 regressions, tuned to a neutral, borders-over-shadows aesthetic.
- **A closed quality → repair loop.** After the agent writes an artifact, Dezin runs static lint, rendered geometry checks, and optional agent visual review. Blocking P0/P1 findings feed back as repair turns automatically, up to the configured round limit. Quality is enforced, not advised.
- **Agent visual review with runtime evidence.** When enabled, a reviewer agent inspects rendered screenshots, viewport geometry, current conversation context, and browser runtime signals such as console errors, page errors, failed requests, and HTTP error responses. The reviewer can inherit the project agent/model or use its own Agent + model.
- **One source of truth.** The linter's rule lists generate the craft doc (`content/craft/anti-ai-slop.md`); a drift test fails if they diverge, so the prompt and the linter can never disagree.

The default brand (`modern-minimal`) is a Linear/Vercel neutral grayscale that does not trip its own linter. And Dezin holds its own UI to the same bar — neutral, restrained, borders over shadows, nothing louder than it needs to be — so the tool practices the taste it enforces ([`docs/SELF-DESIGN.md`](./docs/SELF-DESIGN.md)).

<div align="center">
  <img src="./docs/assets/workspace.png" alt="A Dezin Standard run in the workspace" width="900" />
  <p><em>A Standard run — the agent's reasoning and file writes stream on the left, the artifact renders live on the right, and every version lands with its own quality score.</em></p>
</div>

## Features

- **Bring your own agent.** Dezin scans your PATH for installed CLIs and lets you pick per-run, with the agent's real version. Models the agent exposes are selectable too.
- **Configurable quality automation.** Visual Review can run on the project agent/model or a separate reviewer agent/model, and auto-improve defaults to 8 repair rounds.
- **Two build modes.** *Prototype* — one self-contained HTML file, fastest to iterate. *Standard* — a real Vite + React project (with `motion` + `gsap` on tap) with components and routing.
- **33 built-in design systems.** Brand visual languages modelled on Airbnb, Apple, Linear, Stripe, Vercel, Notion, Figma, and more (each a 9-section `DESIGN.md` + tokens), plus neutral house styles. Import your own from a code folder or a `.fig` file.
- **Effects library.** 20 built-in `@Paper` visual effects — image filters (paper texture, fluted glass, halftone, dithering) and generative shaders (mesh/radial gradients, god rays, smoke, metaballs) — rendered via Paper Shaders, each with presets and a live parameter panel. Author your own WebGL2/GLSL effects and let the Agent revise them while the preview stays live.
- **Variant branches.** Fork a design into parallel branches, iterate each differently, then compare them side by side with a draggable before/after slider.
- **Files and Versions workspace.** Browse generated files with an in-pane source preview, and review per-branch versions grouped by branch with View, Diff, Compare, Restore, and Chat jump actions.
- **Durable run state.** Run events are persisted and replayed when you reopen a project or navigate back. In-app navigation can reconnect to a running agent; if the desktop app quits, the interrupted run reopens at its last known state.
- **Moodboards.** Collect references before a design starts on a high-performance, AI-native infinite canvas — pan and zoom across image, note, section, and image-generator nodes, generate visual material inline, and drive it all from a board-scoped Agent. Built on the Leafer engine for a fluid, Lovart-style canvas experience, entirely local.
- **Reference real work.** The composer's `+` menu pulls context in from anywhere: attach files or a whole folder (the local agent reads them in place), upload a `.fig` and import its design, reference another Dezin project (its real artifact is handed to the agent), reference a Moodboard (budgeted canvas context + asset paths), or pull in a built-in or custom Effect. You can also point the agent at a specific element in the live preview, or drop in screenshots to recreate.
- **Live process view.** The agent's reasoning and file writes stream into the chat as it works; the artifact renders in a sandboxed iframe; export downloads a `.zip`.
- **Desktop app.** An Electron shell (`apps/desktop`) with native window chrome and pixel-perfect off-screen capture for previews.
- **Chrome extension.** Capture a cover image from Dribbble / Behance / Pinterest and send it straight to the composer (`apps/extension`).
- **Command palette, dark mode, keyboard-first.** The usual niceties, done with restraint.

## A look around

<div align="center">
  <img src="./docs/assets/design-systems.png" alt="Dezin design systems gallery" width="900" />
  <p><em>33 built-in design systems, each a brand visual language with its own tokens — or bring your own from a code folder or a <code>.fig</code> file.</em></p>
</div>

<div align="center">
  <img src="./docs/assets/effects.png" alt="Dezin Effects library" width="900" />
  <p><em>The Effects library — 20 built-in <code>@Paper</code> visual effects, from image filters to generative shaders, each with live parameters and presets.</em></p>
</div>

<div align="center">
  <img src="./docs/assets/moodboard.png" alt="Dezin Moodboards" width="900" />
  <p><em>Moodboards — collect references and generate visual material before a design starts.</em></p>
</div>

<div align="center">
  <img src="./docs/assets/moodboard-canvas.png" alt="A Dezin moodboard canvas" width="900" />
  <p><em>The moodboard canvas — a high-performance, AI-native infinite canvas of image, note, section, and image-generator nodes, with a board-scoped Agent panel.</em></p>
</div>

## Composable by design

None of Dezin's surfaces is a silo — they feed each other. A single run weaves a **skill** (what to build) and a **design system** (the brand) together with anything you attach: reference files or a folder, a `.fig`, another generated project, a **Moodboard**, and one or more **Effects**. Outputs loop back as inputs — a finished design becomes a reference for the next, and images you generate on a moodboard canvas become assets a design can pull in. The `+` menu on every composer is where it all comes together.

## Quick start

Prerequisites: **Node ≥ 22.13**, **pnpm 11**, and at least one **coding-agent CLI on your PATH** (e.g. `claude`), authenticated, for real generation.

```sh
pnpm install      # install the workspace
pnpm dev          # runs the daemon + the web UI together (Ctrl-C stops both)
```

`pnpm dev` starts the Node daemon and the Vite dev server; open the printed URL, describe a design, pick a mode and a design system, choose your agent, and **Build**. Run events stream into the chat as the artifact takes shape.

The stack is deliberately **hermetic**: the backend runs on Node built-ins (`node:http`, `node:sqlite`) with TypeScript type-stripping, so it runs and tests with just `node` — no build step, no native modules.

### Desktop

```sh
pnpm desktop      # build the web app and launch the Electron shell
```

### Configuration

The daemon reads a few environment variables:

| Var | Default | Purpose |
| --- | --- | --- |
| `DEZIN_PORT` | ephemeral | Fixed port (dev uses `7457`; production is portless via `.dezin/daemon.json`) |
| `DEZIN_HOST` | `127.0.0.1` | Bind address |
| `DEZIN_DATA_DIR` | `~/.dezin` | Where projects, the SQLite DB, and imported systems live |
| `DEZIN_AGENT_CMD` | `claude` | Default agent command |

## Architecture

A pnpm monorepo.

```
packages/
  quality/   anti-slop linter + the lint→repair closed loop (the headline)
  core/      node:sqlite metadata store (projects/conversations/messages/runs)
  prompt/    composeSystemPrompt — a layered system prompt
  agent/     AgentRunner + generateArtifact (wires the loop) + per-CLI runners
  design/    bundled design systems + loader (registry of DESIGN.md brands)
  effects/   built-in @Paper visual effects (Paper Shaders metadata) + the custom GLSL effect model
  skills/    SKILL.md loader (artifact shapes)
  craft/     generates the anti-slop doc from quality's rule lists + a drift test
apps/
  daemon/    node:http server: runs, project CRUD, agent scan, static preview, ZIP export
  web/       Vite + React 19 + Tailwind v4 SPA — workspace, design systems, Effects + Moodboard canvas (Leafer)
  desktop/   Electron shell + off-screen capture
  extension/ Chrome extension — capture a cover image into the composer
content/
  skills/          authored SKILL.md workflows (artifact shapes)
  design-systems/  the 33 built-in brands (DESIGN.md + tokens.css + manifest)
  craft/           generated anti-ai-slop.md
```

Generation is driven by a **3-axis content model**: `skills` (what to build) × `design-systems` (the brand visual language) × `craft` (universal anti-slop rules). All three are composed into one system prompt and handed to the agent, which writes files into the project folder. The result is linted; P0 findings re-enter as the next turn until clean. Moodboards are a separate local data model for pre-design material collection; projects can reference them without dumping the whole board into chat history.

## Test

```sh
pnpm test           # every suite: scripts, packages, daemon, desktop, extension, Leafer, and Web
pnpm test:coverage  # the same suites with measured Node/V8 coverage floors
pnpm typecheck      # node program, Web, and Leafer type checks
pnpm build:check    # production Web build, initial/total JS budgets, and lazy-boundary guards
pnpm run ci         # all local gates above plus the production dependency audit
```

Node suites use `node --experimental-strip-types --experimental-sqlite --test`; Web uses Vitest with V8 coverage. The root orchestrator names every suite explicitly, applies a bounded timeout, and terminates its owned process group on failure. CI runs the same gates on Node 22.14 / pnpm 11.9 and audits production dependencies at high severity.

## Docs

- [`ROADMAP.md`](./ROADMAP.md) — what's shipped and what's still a TODO.
- [`CONTRIBUTING.md`](./CONTRIBUTING.md) — how to build, test, and send a change.
- [`docs/SELF-DESIGN.md`](./docs/SELF-DESIGN.md) — how Dezin's own UI follows Dezin's rules.

## License

[MIT](./LICENSE).

## References

Dezin was built from scratch; its direction was informed by ideas from these projects:

- [open-design](https://github.com/nexu-io/open-design) — for the anti-AI-slop craft direction and the idea of composing generation from a brand/system content model.
- [Claude Design](https://claude.ai) — Anthropic's Claude interface, a touchstone for the restrained, content-first product aesthetic Dezin aims for.
- [shadcn/ui](https://github.com/shadcn-ui/ui) — the component approach (Radix primitives + CVA + `tailwind-merge`) behind Dezin's own UI, and one of the built-in design systems.
- [simple-icons](https://github.com/simple-icons/simple-icons) — the brand marks used for the built-in design systems.
- [Paper Shaders](https://github.com/paper-design/shaders) — the shader presets and parameter defaults behind Dezin's built-in `@Paper` effects (Apache-2.0).
- [Leafer UI](https://github.com/leaferjs/leafer-ui) — the high-performance canvas engine that powers the Moodboard's infinite canvas.
