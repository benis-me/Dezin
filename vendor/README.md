# Vendored capability packages

These tarballs are built from `capability-foundry` and committed so a fresh
Dezin checkout can install with a frozen lockfile without a sibling repository.
They are distribution artifacts, not editable source forks.

Run `pnpm check` in Foundry before refreshing any artifact. Each package's
`prepack` hook rebuilds its distribution output.

Refresh a tarball with `pnpm pack --pack-destination /path/to/dezin/vendor`
from the corresponding Foundry package, update the dependency and lockfile, then
run Dezin's typecheck, tests, and production build.

## refractive-glass-react

`refractive-glass-react-0.1.0.tgz` is built from
[benis-me/react-liquid-glass](https://github.com/benis-me/react-liquid-glass)
(`npm ci && npm run build:lib`, delete `dist/library/assets`, move `react`,
`react-dom`, and `motion` to `peerDependencies`, then `npm pack`). The Design
Canvas video Node uses its `Glass` lens for the play control.
