# Figma import architecture research

**Status:** researched, not implemented. Dezin currently has no Figma URL
parser, OAuth/PAT connection, REST client, import endpoint, `design/imports/`
store, or native bundle Version. Everything below is a proposed contract and
delivery sequence, not a shipped product capability.

Dezin's Figma import must preserve filesystem authority. A Figma URL is an
external source reference, not a durable Node payload: every imported response,
render, and image fill must be pinned to one exact Figma version, hashed, and
committed atomically before it can become Canvas context.

## Proposed input

The planned parser accepts the official Figma file URL shape
`https://www.figma.com/:file_type/:file_key/:file_name` and its optional
`node-id`. It normalizes URL node IDs such as `5-3` to REST IDs such as `5:3`,
then retains the branch key, requested version, selected node IDs, and normalized
source URL. The Figma response remains authoritative for `editorType`, access
role, `linkAccess`, and resolved file version; URL text is never trusted for
those fields.

The official Files API exposes the document tree, local components, component
sets, styles, layout and annotation data. Selected subtrees should be fetched
with `ids` and bounded `depth` rather than downloading an unbounded file by
default:

- [Files endpoints](https://developers.figma.com/docs/rest-api/file-endpoints/)
- [File node types](https://developers.figma.com/docs/rest-api/file-node-types/)
- [Components and styles endpoints](https://developers.figma.com/docs/rest-api/component-endpoints/)

## Authentication and permissions

The proposed product integration uses OAuth authorization-code flow with S256
PKCE and an external browser.
The minimum scope is `file_content:read`; metadata, version history, libraries,
variables, and webhooks are requested only when their feature is enabled. A
personal access token is acceptable only for an explicit local-development
mode. Tokens belong in the macOS Keychain or daemon secret store and must never
be written into Canvas JSON, Job context, Version payloads, or exports.

- [Authentication](https://developers.figma.com/docs/rest-api/authentication/)
- [OAuth apps](https://developers.figma.com/docs/rest-api/oauth-apps/)
- [OAuth scopes](https://developers.figma.com/docs/rest-api/scopes/)

The Variables REST API is Enterprise-only. Official endpoint requirements also
limit it to full members; reads require view access and `file_variables:read`,
while writes require edit access and `file_variables:write`. When that API is
unavailable, the proposed importer may derive observed values from node
properties and bound-variable references, but the result must be marked
incomplete and must not masquerade as the file's token authority.

- [Variables API](https://developers.figma.com/docs/rest-api/variables/)
- [Variables endpoints](https://developers.figma.com/docs/rest-api/variables-endpoints/)

## Immutable import record

Each proposed successful import creates a new `importId` rather than
overwriting an older snapshot:

```text
design/imports/<importId>/
  manifest.json
  raw/file.json
  raw/nodes/*.json
  derived/Design.md
  derived/tokens/*.json
  derived/components/*.json
  previews/<nodeId>.<png|svg>
```

Binary payloads continue to use the existing content-addressed Asset store. The
manifest records the normalized URL, file/branch/version IDs, selected node IDs,
non-secret credential subject, granted scopes, access snapshot, response and
blob SHA-256 values, importer/mapping schema versions, missing dependencies,
and the user's acknowledgement that they have rights to process the file.

Figma's rendered-image URLs expire after 30 days and image-fill URLs after no
more than 14 days. The import transaction must download them before expiry,
verify MIME type and magic bytes, hash them, and store them locally; a remote
URL can never be Version authority.

## Atomic pipeline

1. Strictly parse and normalize the URL locally.
2. Preflight credentials, scopes, file access, selected nodes, and import limits.
3. Resolve and lock one exact Figma file version.
4. Fetch selected subtrees, styles, images, and permitted variables in bounded
   batches while respecting `429 Retry-After`.
5. Write every response and downloaded asset to a transaction staging directory.
6. Run a deterministic normalizer; AI may explain or enrich the result but may
   not invent source facts or alter the raw snapshot.
7. Atomically commit the import manifest, derived artifacts, assets, and one
   Canvas revision. Failure leaves no partial Nodes.
8. A refresh or webhook creates a new immutable import revision and a visible
   diff; it never mutates the prior snapshot in place.

Figma's `FILE_UPDATE` webhook is a delayed dirty signal, not a realtime diff.
`FILE_VERSION_UPDATE` is preferable for explicitly named versions. Webhook
passcodes must be verified before scheduling a refresh.

- [Webhook events](https://developers.figma.com/docs/rest-api/webhooks-events/)
- [Webhook security](https://developers.figma.com/docs/rest-api/webhooks-security/)
- [Rate limits](https://developers.figma.com/docs/rest-api/rate-limits/)

## Semantic mapping

- Raw source manifest and selected JSON become a material Document/File Node.
- Sections and frames become user-confirmed Page, Layout, or Component candidates;
  the importer never assumes every frame is a page.
- Component sets become variant groups. Components retain property definitions,
  instance overrides, constraints, auto-layout fields, annotations, source node
  IDs, and stable component keys.
- Variable collections become token sets and modes become themes. Aliases remain
  references with cycle and missing-remote diagnostics.
- Published styles map to composite color, typography, effect, or grid tokens.
  Observed colors and sizes are evidence, not automatically declared tokens.
- `Design.md` clearly separates extracted Figma facts from Dezin inference,
  including unresolved dependencies and permission gaps.
- Image-fill assets and rendered node previews remain distinct payloads with
  exact export format, scale, node ID, and file version provenance.

The current Canvas Version model only supports `html | asset`. A complete
semantic import therefore requires bundle Versions that can authoritatively
carry Markdown, JSON, CSS, component contracts, preview HTML, and pinned assets.
Until that schema exists, derived `Design.md` and token/component JSON must be
material Documents/Files and must not be presented as native generative Nodes.

## Delivery phases

1. URL parser, import manifest/schema, deterministic normalizer, budgets, and
   offline fixtures.
2. OAuth/PAT read path, exact-version selected subtree, local image/SVG capture,
   and atomic material-node import.
3. Bundle Version schema and native `design-document`, `design-tokens`, and
   `component` semantic artifacts/editors.
4. Enterprise Variables and library dependency resolution with explicit
   incomplete diagnostics.
5. User-confirmed immutable refresh/diff, optionally triggered by webhooks.
6. Optional, explicitly authorized write-back of Dezin links/status. A public
   integration needs privacy and Figma Developer Terms review before release.

REST is the primary import authority. A Figma plugin can later enhance the
currently open file or provide an explicit write-back channel, but it cannot be
the background cross-file source of truth.
