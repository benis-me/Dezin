#!/usr/bin/env bash
# Run every package's tests with zero install (Node built-ins + type-stripping).
set -uo pipefail
cd "$(dirname "$0")/.."

NODE_FLAGS="--experimental-strip-types --experimental-sqlite --no-warnings"
fail=0
failed_dirs=""

for dir in packages/* apps/*; do
  # Skip Vite/React apps — they use vitest+JSX, not node:test type-stripping.
  [ -f "$dir/vite.config.ts" ] && continue
  [ -d "$dir/test" ] || continue
  compgen -G "$dir/test/*.test.ts" > /dev/null || continue

  echo "── $dir ──"
  # Run ONCE: capture output + exit code (running twice doubled flaky-port exposure).
  if out=$( cd "$dir" && node $NODE_FLAGS --test 'test/*.test.ts' 2>&1 ); then
    :
  else
    fail=1
    failed_dirs="$failed_dirs $dir"
  fi
  printf '%s\n' "$out" | grep -E '^(ok|not ok|# tests|# pass|# fail)' || true
done

if [ "$fail" -ne 0 ]; then
  echo "SUITE: FAIL —$failed_dirs"
  exit 1
fi
echo "SUITE: PASS"
