# Moodboard Reference Images and Providers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add reference-image attachment controls to Moodboard generator and Quick Edit inputs, and add AI SDK fal + Google Vertex image providers.

**Architecture:** Reference images are persisted as moodboard asset ids, not new canvas nodes. The web toolbar owns attachment UI and passes `referenceAssetIds` through `useMoodboardBoard.generateImage`; the daemon loads those assets and calls AI SDK image generation with `{ text, images }` prompts when references exist. fal and Vertex are normal model providers in the existing provider registry and image-model factory.

**Tech Stack:** React 19, Vitest, node:test, AI SDK v7, `@ai-sdk/fal`, `@ai-sdk/google-vertex`, Dezin daemon node:http.

## Global Constraints

- Do not create ordinary canvas image nodes when uploading reference images from the toolbar.
- Generator submission replaces the generator with the generated image node.
- Quick Edit and other edit flows create a new image node.
- Store reusable reference ids in node `data.referenceAssetIds`.
- Keep Vertex first version on AI SDK Vertex Express Mode API key; do not add DB schema for project/location credentials.
- Use TDD: write failing tests before production code.
- Use existing Moodboard and Model Provider UI patterns.

---

### Task 1: Provider Registry and Runtime

**Files:**
- Modify: `apps/web/src/settings/model-provider-registry.ts`
- Modify: `apps/daemon/src/image-gen.ts`
- Modify: `apps/daemon/package.json`
- Modify: `pnpm-lock.yaml`
- Test: `apps/daemon/test/image-gen.test.ts`
- Test: `apps/web/src/moodboard/useMoodboardBoard.test.tsx`

**Interfaces:**
- Produces: `ProviderPreset.imageRuntime` accepts `"fal" | "vertex"`.
- Produces: `ImageGenOpts.providerId` values `"fal"` and `"vertex"` route to `fal.image(model)` and `vertex.image(model)`.

- [ ] **Step 1: Write failing provider tests**

Add tests asserting:

```ts
test("requestImage routes fal image models through the Fal AI SDK provider", async () => {
  // Stub fetch and expect the request URL/body to include the fal model invocation.
});

test("requestImage routes Vertex image models through the Google Vertex AI SDK provider", async () => {
  // Stub fetch and expect the image model factory to use providerId: "vertex".
});
```

Also add a web-side test that `imageModelOptions` includes preset image models for enabled `fal` and `vertex` providers.

- [ ] **Step 2: Verify red**

Run:

```bash
node --experimental-strip-types --experimental-sqlite --no-warnings --test apps/daemon/test/image-gen.test.ts
pnpm -s --filter @dezin/web test -- src/moodboard/useMoodboardBoard.test.tsx
```

Expected: FAIL because `fal` and `vertex` are not registered image runtimes.

- [ ] **Step 3: Install packages**

Run:

```bash
pnpm add --filter @dezin/daemon @ai-sdk/fal @ai-sdk/google-vertex
```

- [ ] **Step 4: Implement provider registry**

Add provider presets:

```ts
{
  id: "fal",
  name: "fal",
  protocol: "fal.ai",
  baseUrl: "",
  imageRuntime: "fal",
  keyPlaceholder: "fal key",
  fields: [{ key: "apiKey", label: "API Key", placeholder: "fal key", required: true, secret: true }],
  models: [
    { id: "fal-ai/flux/dev", name: "FLUX.1 Dev", capabilities: ["Image"] },
    { id: "fal-ai/flux-pro/v1.1", name: "FLUX.1 Pro 1.1", capabilities: ["Image"] },
  ],
}
```

```ts
{
  id: "vertex",
  name: "Vertex AI",
  protocol: "Google Vertex AI",
  baseUrl: "",
  imageRuntime: "vertex",
  keyPlaceholder: "Vertex Express Mode API key",
  fields: [{ key: "apiKey", label: "API Key", placeholder: "Vertex Express Mode API key", required: true, secret: true }],
  models: [
    { id: "imagen-4.0-generate-001", name: "Imagen 4", capabilities: ["Image"] },
    { id: "imagen-4.0-ultra-generate-001", name: "Imagen 4 Ultra", capabilities: ["Image"] },
  ],
}
```

- [ ] **Step 5: Implement runtime factory**

Update `image-gen.ts`:

```ts
import { fal } from "@ai-sdk/fal";
import { createVertex } from "@ai-sdk/google-vertex";

function isFal(opts: ImageGenOpts) {
  return opts.providerId === "fal";
}

function isVertex(opts: ImageGenOpts) {
  return opts.providerId === "vertex";
}
```

Use:

```ts
if (isFal(opts)) return fal.image(opts.model.trim() || "fal-ai/flux/dev");
if (isVertex(opts)) return createVertex({ apiKey: opts.apiKey, fetch: fetchImpl }).image(opts.model.trim() || "imagen-4.0-generate-001");
```

- [ ] **Step 6: Verify green**

Run the commands from Step 2. Expected: PASS.

---

### Task 2: Reference Image API and Daemon Prompt Plumbing

**Files:**
- Modify: `apps/web/src/lib/api.ts`
- Modify: `apps/daemon/src/moodboard-handler.ts`
- Modify: `apps/daemon/src/image-gen.ts`
- Test: `apps/daemon/test/moodboard-image.test.ts`
- Test: `apps/daemon/test/image-gen.test.ts`

**Interfaces:**
- Consumes: `referenceAssetIds?: string[]` in `GenerateMoodboardImageOptions`.
- Produces: `ImageGenOpts.referenceImages?: SourceImageInput[]`.

- [ ] **Step 1: Write failing daemon tests**

Add tests asserting:

```ts
test("POST /api/moodboards/:id/generate-image sends reference asset bytes with the prompt", async () => {
  // Create an uploaded reference asset, call generate-image with referenceAssetIds,
  // assert requestImage receives prompt.images with those bytes.
});

test("POST /api/moodboards/:id/generate-image persists reference ids on generated image nodes", async () => {
  // Generate from a generator with references and assert data.referenceAssetIds.
});
```

- [ ] **Step 2: Verify red**

Run:

```bash
node --experimental-strip-types --experimental-sqlite --no-warnings --test apps/daemon/test/moodboard-image.test.ts apps/daemon/test/image-gen.test.ts
```

Expected: FAIL because `referenceAssetIds` are ignored.

- [ ] **Step 3: Implement API types**

Update `GenerateMoodboardImageOptions`:

```ts
referenceAssetIds?: string[];
```

- [ ] **Step 4: Implement daemon asset loading**

In `handleGenerateMoodboardImage`, parse `referenceAssetIds`, load each moodboard asset file, and pass:

```ts
referenceImages: referenceImages.length ? referenceImages : undefined
```

to `ImageGenOpts`.

- [ ] **Step 5: Implement AI SDK prompt images**

In `requestImage`, if `opts.referenceImages?.length`, call:

```ts
generateImage({
  model: imageModel(opts, loggedFetch),
  prompt: { text: prompt, images: opts.referenceImages.map((image) => new Uint8Array(image.data)) },
  ...generationSettings(opts),
});
```

In `requestImageEdit`, include the source image first, then reference images.

- [ ] **Step 6: Verify green**

Run the Step 2 command. Expected: PASS.

---

### Task 3: Reference Image Toolbar UI

**Files:**
- Modify: `apps/web/src/moodboard/MoodboardCanvasToolbars.tsx`
- Modify: `apps/web/src/moodboard/MoodboardCanvas.tsx`
- Modify: `apps/web/src/moodboard/useMoodboardBoard.ts`
- Modify: `apps/web/src/moodboard/useMoodboardCanvasController.ts`
- Test: `apps/web/src/moodboard/moodboard-ui.test.tsx`
- Test: `apps/web/src/moodboard/useMoodboardBoard.test.tsx`

**Interfaces:**
- Produces: `ReferenceImageInput` toolbar subcomponent.
- Consumes: `onUploadReferenceFiles(files, node?)`.
- Produces: `generateImage(node, prompt, { params, sourceAssetId, referenceAssetIds })`.

- [ ] **Step 1: Write failing UI tests**

Add tests asserting:

```tsx
test("GeneratorPromptToolbar exposes reference image actions above the prompt", async () => {
  // Expect button "Reference images"; click and see "Upload from computer" and "Select from canvas".
});

test("GeneratorPromptToolbar submits reference asset ids with the prompt", async () => {
  // Render with referenceAssetIds in node data; click Generate; expect onGenerate receives options.
});

test("QuickEditPromptToolbar exposes reference image actions above the prompt", async () => {
  // Same visible controls for Quick Edit.
});
```

- [ ] **Step 2: Verify red**

Run:

```bash
pnpm -s --filter @dezin/web test -- src/moodboard/moodboard-ui.test.tsx src/moodboard/useMoodboardBoard.test.tsx
```

Expected: FAIL because controls and `referenceAssetIds` options do not exist.

- [ ] **Step 3: Add reference controls**

Add a compact toolbar area above each textarea with:

```tsx
<Button aria-label="Reference images">参考图</Button>
```

Popover items:

```tsx
<button>从本地上传图片</button>
<button>从画布选择</button>
```

- [ ] **Step 4: Wire local upload**

Use a hidden file input with `accept="image/*"` and call `onUploadReferenceFiles(files, node)`.

- [ ] **Step 5: Wire canvas selection**

Add a one-shot canvas reference selection mode:

```ts
referencePickTargetId: string | null;
startReferencePick(targetId: string);
```

Clicking an image node while active appends its `assetId` to the target generator node.

- [ ] **Step 6: Pass ids during generation**

Read `node.data.referenceAssetIds` and include:

```ts
referenceAssetIds
```

in `generateImage` options.

- [ ] **Step 7: Verify green**

Run the Step 2 command. Expected: PASS.

---

### Task 4: Final Verification and Commit

**Files:**
- All modified files.

- [ ] **Step 1: Typecheck**

Run:

```bash
pnpm -s typecheck
```

Expected: `TYPECHECK: PASS`.

- [ ] **Step 2: Target tests**

Run:

```bash
pnpm -s --filter @dezin/web test -- src/moodboard/moodboard-ui.test.tsx src/moodboard/useMoodboardBoard.test.tsx
node --experimental-strip-types --experimental-sqlite --no-warnings --test apps/daemon/test/image-gen.test.ts apps/daemon/test/moodboard-image.test.ts
```

Expected: all tests pass.

- [ ] **Step 3: Build**

Run:

```bash
pnpm -s --filter @dezin/web build
```

Expected: build exits 0; existing chunk-size warning is acceptable.

- [ ] **Step 4: Full suite**

Run:

```bash
pnpm -s test
```

Expected: `SUITE: PASS`.

- [ ] **Step 5: Commit and push**

Run:

```bash
git add apps/daemon apps/web pnpm-lock.yaml docs/superpowers/plans/2026-07-03-moodboard-reference-images-and-providers.md
git commit -m "feat: add moodboard reference images and providers"
git push origin hardening/07-platform-api-debt
```

Expected: push succeeds.

---

## Self-Review

- Spec coverage: reference uploads, canvas selection, API payload, AI SDK image prompts, fal provider, Vertex provider, tests, and final verification are all covered.
- Placeholder scan: no TODO/TBD placeholders remain.
- Type consistency: `referenceAssetIds`, `ImageGenOpts.referenceImages`, `ProviderPreset.imageRuntime`, and provider ids are consistent across tasks.
