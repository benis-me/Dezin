#!/usr/bin/env bash
# Run the Dezin daemon + web dev server together. Ctrl-C stops both.
#
#   pnpm dev            (from the repo root)
#
# The daemon owns its discovery file (.dezin/daemon.json): it writes the file when
# it starts listening and removes it on shutdown. This script never deletes that
# file itself, so a second `pnpm dev` cannot break an instance that is already
# running; it detects the live daemon through .dezin/daemon.lock and reuses it.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"

PORTFILE="$ROOT/.dezin/daemon.json"
LOCKFILE="$ROOT/.dezin/data/daemon.lock"
export DEZIN_PORTFILE="$PORTFILE"
export DEZIN_DATA_DIR="${DEZIN_DATA_DIR:-$ROOT/.dezin/data}"
# Fixed dev port so `node --watch` daemon restarts keep the same address (Vite's
# proxy resolves the target once at startup). Production stays portless (unset).
export DEZIN_PORT="${DEZIN_PORT:-7457}"

if [ ! -d apps/web/node_modules ]; then
  echo "apps/web has no node_modules; run 'pnpm install' from the repo root first." >&2
  exit 1
fi

mkdir -p "$ROOT/.dezin"

# A live daemon holds .dezin/data/daemon.lock with its pid. Reuse it instead of
# racing for the lock (and instead of touching its discovery file).
live_daemon_pid() {
  [ -f "$LOCKFILE" ] || return 1
  local pid
  pid=$(node -e 'try{const l=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));if(Number.isInteger(l.pid))console.log(l.pid)}catch{}' "$LOCKFILE" 2>/dev/null || true)
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null && echo "$pid"
}

DAEMON_PID=""
if EXISTING_PID=$(live_daemon_pid); then
  echo "Reusing the Dezin daemon already running for $DEZIN_DATA_DIR (pid $EXISTING_PID)."
  [ -f "$PORTFILE" ] && echo "Daemon: $(cat "$PORTFILE" | sed -E 's/"token":"[^"]*"/"token":"<redacted>"/')"
else
  # No live owner: a leftover discovery file can only be stale.
  rm -f "$PORTFILE"
  echo "Starting Dezin daemon (--watch auto-restart) …"
  ( cd apps/daemon && node --watch --experimental-strip-types --experimental-sqlite --no-warnings src/start.ts ) &
  DAEMON_PID=$!
  # Wait for the daemon to advertise its port. The daemon removes the file itself on exit.
  for _ in $(seq 1 60); do [ -f "$PORTFILE" ] && break; sleep 0.25; done
  if [ -f "$PORTFILE" ]; then
    echo "Daemon ready: $(cat "$PORTFILE" | sed -E 's/"token":"[^"]*"/"token":"<redacted>"/')"
  else
    echo "Daemon didn't write $PORTFILE in time; Vite will fall back to :$DEZIN_PORT." >&2
  fi
fi

cleanup() { [ -n "$DAEMON_PID" ] && kill "$DAEMON_PID" 2>/dev/null || true; }
trap cleanup EXIT INT TERM

echo "Starting web dev server (Vite) …"
( cd apps/web && DEZIN_PORTFILE="$PORTFILE" pnpm run dev )
