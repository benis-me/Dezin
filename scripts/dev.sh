#!/usr/bin/env bash
# Run the Dezin daemon + web dev server together, portless. Ctrl-C stops both.
#
#   npm run dev            (from the repo root)
#
# The daemon binds an ephemeral port and advertises it in .dezin/daemon.json;
# Vite reads that file to target its /api and /projects proxy. No fixed port.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"

PORTFILE="$ROOT/.dezin/daemon.json"
export DEZIN_PORTFILE="$PORTFILE"
export DEZIN_DATA_DIR="${DEZIN_DATA_DIR:-$ROOT/.dezin/data}"
# Fixed dev port so `node --watch` daemon restarts keep the same address (Vite's
# proxy resolves the target once at startup). Production stays portless (unset).
export DEZIN_PORT="${DEZIN_PORT:-7457}"

if [ ! -d apps/web/node_modules ]; then
  echo "apps/web has no node_modules — run 'cd apps/web && npm install' first." >&2
  exit 1
fi

mkdir -p "$ROOT/.dezin"
rm -f "$PORTFILE"

echo "Starting Dezin daemon (portless: ephemeral port, --watch auto-restart) …"
( cd apps/daemon && node --watch --experimental-strip-types --experimental-sqlite --no-warnings src/start.ts ) &
DAEMON_PID=$!
cleanup() { kill "$DAEMON_PID" 2>/dev/null || true; rm -f "$PORTFILE"; }
trap cleanup EXIT INT TERM

# Wait for the daemon to advertise its port.
for _ in $(seq 1 60); do [ -f "$PORTFILE" ] && break; sleep 0.25; done
if [ -f "$PORTFILE" ]; then
  echo "Daemon ready: $(cat "$PORTFILE")"
else
  echo "Daemon didn't write $PORTFILE in time; Vite will fall back to :7457." >&2
fi

echo "Starting web dev server (Vite) …"
( cd apps/web && DEZIN_PORTFILE="$PORTFILE" npm run dev )
