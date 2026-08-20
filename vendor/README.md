# Vendored capability packages

These tarballs are built from `capability-foundry` and committed so a fresh
Dezin checkout can install with a frozen lockfile without a sibling repository.
They are distribution artifacts, not editable source forks.

Run `pnpm check` in Foundry before refreshing any artifact. Each package's
`prepack` hook rebuilds its distribution output.

Refresh a tarball with `pnpm pack --pack-destination /path/to/dezin/vendor`
from the corresponding Foundry package, update the dependency and lockfile, then
run Dezin's typecheck, tests, and production build.
