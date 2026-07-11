#!/usr/bin/env bash
# Typecheck the whole workspace. The node packages + daemon are checked as one
# program (tsconfig.check.json) since they import each other by relative .ts path;
# the web app is checked with its own JSX/DOM tsconfig.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "── node program (packages/* + apps/daemon + scripts) ──"
pnpm exec tsc -p tsconfig.check.json --noEmit

echo "── apps/web ──"
( cd apps/web && pnpm exec tsc --noEmit -p tsconfig.json )

echo "── packages/leafer-react ──"
pnpm --dir packages/leafer-react typecheck

echo "TYPECHECK: PASS"
