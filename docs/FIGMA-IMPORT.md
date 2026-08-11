# Figma URL import

**Status:** the first filesystem-authoritative import slice is implemented.
From an existing Design Canvas, Dezin can import an authorized Figma file URL
and atomically append three material artifacts to the current Project:
`Design.md`, `tokens.json`, and `components.json`. This is a deterministic
analysis import, not a pixel-perfect Figma clone.

## Supported input

The blank-canvas context menu exposes **Import from Figma**. The dialog accepts
these credential-free HTTPS URL forms:

- `https://www.figma.com/design/<file-key>/<name>`
- `https://www.figma.com/file/<file-key>/<name>`
- `https://www.figma.com/board/<file-key>/<name>`
- `https://www.figma.com/slides/<file-key>/<name>`
- `https://www.figma.com/design/<main-key>/branch/<branch-key>/<name>`

An optional `node-id` is normalized from URL form such as `5-3` to REST form
`5:3`. Explicit Node selections are bounded, de-duplicated, sorted, and must
agree with the URL. Proto, Site, Buzz, credential-bearing URLs, fragments,
encoded path separators, and malformed identities fail closed.

Historical `version-id` URLs are intentionally rejected in this slice. The
Variables endpoint cannot be pinned to that historical Version, so accepting
one would falsely claim an exact token snapshot.

The daemon is the parsing authority. The Web parser only provides a conservative
preview. The right-click position is converted to a Canvas coordinate and rounded
before the menu closes. While an import is unconfirmed, the renderer persists
only an opaque random idempotency key and the SHA-256 of its canonical submission
fingerprint, including the Project and anchor; it stores neither the Figma URL nor
the PAT. An ambiguous retry or renderer restart reuses that pending key. Confirmed
success clears it, so a later explicit import of the same URL can capture a newer
Figma Version.

Official identity and query semantics are documented by Figma's
[File endpoints](https://developers.figma.com/docs/rest-api/file-endpoints/) and
[Node ID contract](https://developers.figma.com/docs/plugins/api/properties/nodes-id/).

## Authentication

The first slice uses a Figma personal access token (PAT):

- `FIGMA_ACCESS_TOKEN` takes precedence when set for the local daemon.
- Otherwise the user can store or forget a PAT from the import dialog.
- The daemon secret directory is private (`0700`) and the token file is `0600`.
- Credential status returns only `configured` and `source`; the token is never
  echoed to the renderer.
- The PAT is never accepted in an import request, Project, Canvas, manifest,
  derived artifact, error response, or non-secret receipt.

Required access is `file_content:read` plus `file_metadata:read`.
`file_variables:read` is optional and only enables exact Variables when the
account and plan permit it. See Figma's
[authentication](https://developers.figma.com/docs/rest-api/authentication/),
[PAT](https://developers.figma.com/docs/rest-api/personal-access-tokens/), and
[scope](https://developers.figma.com/docs/rest-api/scopes/) documentation.

OAuth is not shipped. Figma's token exchange and refresh still require a client
secret, so a future desktop OAuth flow must use the system browser and a
server-side secret/callback; it must not embed that secret or authenticate in a
WebView. See [OAuth apps](https://developers.figma.com/docs/rest-api/oauth-apps/).

## Exact snapshot pipeline

For one accepted import Dezin performs a bounded, version-fenced round:

1. Read `/files/:key/meta` as metadata fence `M0`.
2. Read `/files/:key` at exact Version `V`, with bounded `ids`, `depth`, and
   `branch_data` when applicable.
3. Read local Variables when applicable and authorized.
4. Read metadata fence `M1`.
5. Accept only when `M0 == V == M1`; one whole-round restart is allowed when
   the file changes during capture.

The REST client uses only the fixed official API origin, refuses redirects,
bounds response bytes and structural complexity, applies a per-attempt deadline,
and only retries `429` inside a short, explicit `Retry-After` window. Caller
cancellation remains an `AbortError`.

Design branches are fetched by branch identity and must close back to the
requested main file through `mainFileKey`. Metadata, file, editor type, and
Version identities are validated before they can become authority.

## Published authority

Every successful import owns an immutable directory:

```text
projects/<project-id>/design/imports/<import-id>/
  manifest.json
  raw/file.json
  raw/variables.json       # only when exact Variables are available
  derived/Design.md
  derived/tokens.json
  derived/components.json
```

The three derived files are also published atomically into one Canvas revision:

| Artifact | Canvas kind | Meaning |
| --- | --- | --- |
| `Design.md` | Document | File/editor metadata, selected structure, extracted facts, warnings, and incomplete areas |
| `tokens.json` | File | Exact Variables when authorized, otherwise explicitly inferred style evidence |
| `components.json` | File | Deterministic local component, component-set, and style records |

The first card uses the frozen right-click anchor as its top-left position. The
other two use the same row at `x + 460` and `x + 920`; all three start at
`420 × 560`. A successful import remains on the current Project route, selects
the three new Nodes, and frames them once without opening an Agent panel.

`tokenAuthority` is one of `figma-variables-exact`,
`style-values-inferred`, or `not-applicable`. A Variables `403`/`404` is recorded
as incomplete evidence and never masquerades as exact token authority. Figma's
Variables REST API has additional plan, membership, permission, and scope
requirements; see [Variables](https://developers.figma.com/docs/rest-api/variables/)
and [Variables endpoints](https://developers.figma.com/docs/rest-api/variables-endpoints/).

Raw and derived JSON are canonicalized and checksum-bound. Untrusted names are
rendered as Markdown plaintext. Temporary/signed render, thumbnail, download,
and CDN URLs are removed from nested values, keys, embedded semantic text,
titles, manifests, and derived files. The normalized public Figma source URL is
the only remote URL retained as provenance.

## Durability and replay

The import is a daemon-owned, Project-local cross-process transaction:

- One idempotency key binds one normalized request; rebinding returns `409`
  before credential or network access.
- Cross-process tickets serialize the same receipt, are cancellable while
  waiting, and use owner identity plus fencing so an old process cannot delete
  or publish over a replacement.
- The target Project must already exist. Missing Projects fail before receipt,
  credential, or Figma access, and an import never creates or resurrects one.
- Accepted receipts, snapshot publication, the Asset batch, final import
  publication, and phase advancement are fsync-ordered.
- Restart recovery adopts an already-renamed snapshot and rolls
  `snapshot-staged` or later phases forward without Figma or PAT access.
- Ready replay verifies every immutable artifact byte and returns the current
  canonical Canvas plus the original import receipt with no remote request or
  Canvas mutation.
- The Project is protected by the runtime operation lease while it is being
  materialized, so concurrent deletion cannot tear down an active import.

HTTP endpoints:

```text
GET    /api/figma/credential
PUT    /api/figma/credential
DELETE /api/figma/credential
POST   /api/projects/:id/design-canvas/imports/figma
```

The import endpoint returns `201` when a newly created receipt completes in the
same request. An existing, request-identical receipt returns `200` after either
offline continuation or exact replay. Idempotency conflict or corrupt authority
returns `409`.

## Deliberate limitations

This slice does **not** yet:

- download Figma image fills, rendered previews, fonts, or other expiring binary
  resources;
- recreate a pixel-identical editable page or native Dezin Component/Token
  bundle;
- resolve remote libraries and aliases beyond the selected file snapshot;
- refresh, diff, subscribe to webhooks, or write anything back to Figma;
- authenticate through OAuth.

Those capabilities require immutable binary capture, native bundle Versions,
explicit refresh/diff UX, and additional privacy/Figma Developer Terms review.
REST remains the source authority; a future Figma plugin may enhance the open
file or provide an explicit write-back channel, but cannot replace durable
cross-file import authority.
