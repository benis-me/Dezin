#!/usr/bin/env bash
# One command for desktop dev: start the daemon + Vite (via dev.sh) AND the
# Electron shell together. Ctrl-C — or closing the window — stops everything.
#
#   pnpm desktop:dev
#
# Electron (DEZIN_DEV=1) discovers Vite's actual port from .dezin/web.json, so a
# port-conflict fallback stays in sync. Don't also run `pnpm dev` separately —
# this already starts that stack; two copies would fight over the daemon port.
set -uo pipefail
cd "$(dirname "$0")/.."

# Drop a stale portfile so Electron waits for THIS run's Vite, not a dead port.
rm -f .dezin/web.json

# Run the daemon + Vite stack in its OWN process group (set -m), so the trap can
# tear down the whole tree — dev.sh, daemon, Vite — without touching this script
# or pnpm. dev.sh's foreground child (Vite) would otherwise orphan on a plain kill.
set -m
bash scripts/dev.sh &
STACK_PGID=$!
set +m
cleanup() { kill -- -"$STACK_PGID" 2>/dev/null || true; }
trap cleanup EXIT INT TERM

# Electron in the foreground; it polls .dezin/web.json for Vite's URL. When it
# exits (window closed) or Ctrl-C arrives, the trap stops the background stack.
DEZIN_DEV=1 pnpm --filter ./apps/desktop start
