import assert from "node:assert/strict";
import test from "node:test";

import { normalizeFigmaImport } from "../src/design/figma-import-normalizer.ts";

const source = {
  fileType: "design" as const,
  fileKey: "AbC123xyZ",
  branchKey: null,
  fileName: "Product-System",
  nodeIds: ["1:2"],
  requestedVersionId: null,
  normalizedUrl: "https://www.figma.com/design/AbC123xyZ/Product-System?node-id=1%3A2",
};

const file = {
  version: "42",
  name: "Product System",
  role: "viewer",
  editorType: "figma",
  linkAccess: "view",
  lastModified: "2026-08-11T00:00:00Z",
  document: {
    id: "0:0",
    name: "Product System",
    type: "DOCUMENT",
    children: [{
      id: "1:2",
      name: "Components",
      type: "CANVAS",
      children: [{ id: "2:2", name: "Button", type: "COMPONENT" }],
    }],
  },
  components: {
    "2:2": { key: "component-key", name: "Button", description: "Primary action", componentSetId: "3:1" },
  },
  componentSets: {
    "3:1": { key: "set-key", name: "Button", description: "Button variants" },
  },
  styles: {},
};

const variables = {
  meta: {
    variableCollections: {
      collection: {
        id: "collection",
        name: "Core",
        modes: [{ modeId: "light", name: "Light" }],
        defaultModeId: "light",
        variableIds: ["color"],
      },
    },
    variables: {
      color: {
        id: "color",
        name: "Color/Accent",
        variableCollectionId: "collection",
        resolvedType: "COLOR",
        valuesByMode: { light: { r: 1, g: 0, b: 0, a: 1 } },
        scopes: ["ALL_FILLS"],
      },
    },
  },
};

test("Figma normalization emits deterministic raw authority plus Design.md, tokens, and components", () => {
  const first = normalizeFigmaImport({ source, file, variables: { kind: "available", body: variables } });
  const reorderedFile = {
    document: file.document,
    styles: {},
    componentSets: file.componentSets,
    components: file.components,
    lastModified: file.lastModified,
    linkAccess: file.linkAccess,
    editorType: file.editorType,
    role: file.role,
    name: file.name,
    version: file.version,
  };
  const second = normalizeFigmaImport({ source, file: reorderedFile, variables: { kind: "available", body: variables } });

  assert.equal(first.resolvedVersion, "42");
  assert.equal(first.fileName, "Product System");
  assert.deepEqual(first.incomplete, []);
  assert.equal(first.rawFile.sha256, second.rawFile.sha256);
  assert.equal(first.designMarkdown.sha256, second.designMarkdown.sha256);
  assert.equal(first.tokensJson.sha256, second.tokensJson.sha256);
  assert.equal(first.componentsJson.sha256, second.componentsJson.sha256);
  assert.match(first.designMarkdown.bytes.toString("utf8"), /^# Product System/m);
  assert.match(first.designMarkdown.bytes.toString("utf8"), /Button/);

  const tokens = JSON.parse(first.tokensJson.bytes.toString("utf8"));
  assert.equal(tokens.completeness, "complete");
  assert.equal(tokens.authority, "figma-variables-exact");
  assert.equal(tokens.collections[0].name, "Core");
  assert.equal(tokens.variables[0].name, "Color\/Accent");
  const components = JSON.parse(first.componentsJson.bytes.toString("utf8"));
  assert.equal(components.components[0].key, "component-key");
  assert.equal(components.componentSets[0].key, "set-key");
});

test("a REST-bounded Variables response with several full collections normalizes without pretty-print inflation", () => {
  const variableCount = 16_500;
  const variableIdsByCollection = Array.from({ length: 4 }, () => [] as string[]);
  for (let index = 0; index < variableCount; index += 1) {
    variableIdsByCollection[index % 4]!.push(`variable-${index}`);
  }
  const variableCollections = Object.fromEntries(Array.from({ length: 4 }, (_, index) => {
    const id = `collection-${index}`;
    return [id, {
      id,
      name: `Collection ${index}`,
      key: `collection-key-${index}`,
      modes: [{ modeId: "light", name: "Light" }, { modeId: "dark", name: "Dark" }],
      defaultModeId: "light",
      remote: false,
      hiddenFromPublishing: false,
      variableIds: variableIdsByCollection[index],
    }];
  }));
  const largeVariables = {
    status: 200,
    error: false,
    meta: {
      variableCollections,
      variables: Object.fromEntries(Array.from({ length: variableCount }, (_, index) => {
        const id = `variable-${index}`;
        return [id, {
          id,
          name: `Token/${index}`,
          key: `key-${index}`,
          variableCollectionId: `collection-${index % 4}`,
          resolvedType: "STRING",
          valuesByMode: { light: `value-${index}`, dark: `value-${index}` },
          remote: false,
          description: "",
          hiddenFromPublishing: false,
          scopes: ["ALL_SCOPES"],
          codeSyntax: { WEB: `--token-${index}` },
        }];
      })),
    },
  };
  assert.ok(Buffer.byteLength(JSON.stringify(largeVariables), "utf8") < 8 * 1024 * 1024);
  assert.ok(Buffer.byteLength(JSON.stringify(largeVariables, null, 2), "utf8") > 8 * 1024 * 1024);

  const normalized = normalizeFigmaImport({
    source,
    file,
    variables: { kind: "available", body: largeVariables },
  });

  assert.equal(JSON.parse(normalized.rawVariables!.bytes.toString("utf8")).meta.variables["variable-16499"].name, "Token/16499");
  assert.equal(JSON.parse(normalized.tokensJson.bytes.toString("utf8")).variables.length, variableCount);
});

test("Variables 403/404 remains explicit incomplete evidence and never invents token authority", () => {
  for (const status of [403, 404] as const) {
    const normalized = normalizeFigmaImport({
      source,
      file,
      variables: { kind: "unavailable", status, reason: `Figma Variables returned ${status}` },
    });
    const tokens = JSON.parse(normalized.tokensJson.bytes.toString("utf8"));
    assert.equal(tokens.authority, "style-values-inferred");
    assert.equal(tokens.completeness, "incomplete");
    assert.deepEqual(tokens.collections, []);
    assert.deepEqual(tokens.variables, []);
    assert.ok(normalized.incomplete.includes(`variables-http-${status}`));
  }
});

test("long Figma Node names are safely previewed instead of rejecting the whole import", () => {
  const longName = `ZenStudio ${"影视内容".repeat(320)}`;
  const normalized = normalizeFigmaImport({
    source,
    file: {
      ...file,
      document: {
        ...file.document,
        children: [{ id: "1:2", name: longName, type: "FRAME" }],
      },
    },
    variables: { kind: "unavailable", status: 403, reason: "Figma Variables returned 403" },
  });

  const markdown = normalized.designMarkdown.bytes.toString("utf8");
  assert.match(markdown, /ZenStudio/);
  assert.match(markdown, /… `FRAME`/);
  assert.equal(markdown.includes("\uFFFD"), false);
  assert.ok(normalized.incomplete.includes("outline-name-budget"));
  assert.ok(normalized.warnings.some((warning) => /Node name.*truncated/.test(warning)));
});

test("overlapping selected roots emit each visual candidate once", () => {
  const normalized = normalizeFigmaImport({
    source: { ...source, nodeIds: ["1:2", "2:2"] },
    file: {
      ...file,
      document: {
        ...file.document,
        children: [{
          id: "1:2", name: "Section", type: "SECTION",
          absoluteBoundingBox: { x: 0, y: 0, width: 4_000, height: 3_000 },
          children: [
            {
              id: "2:2", name: "Shared frame", type: "FRAME",
              absoluteBoundingBox: { x: 100, y: 100, width: 720, height: 620 }, children: [],
            },
            {
              id: "2:3", name: "Sibling frame", type: "FRAME",
              absoluteBoundingBox: { x: 900, y: 100, width: 720, height: 620 }, children: [],
            },
          ],
        }],
      },
    },
    variables: { kind: "unavailable", status: 403, reason: "unavailable" },
  });

  assert.deepEqual(normalized.visualCandidates.map((candidate) => candidate.nodeId), ["2:2", "2:3"]);
  assert.deepEqual(normalized.visualCandidates.map((candidate) => candidate.referencePath), [
    "derived/references/reference-frame-001.png",
    "derived/references/reference-frame-002.png",
  ]);
});

test("a requested selected Node missing from the version-fenced tree fails closed", () => {
  assert.throws(
    () => normalizeFigmaImport({
      source: { ...source, nodeIds: ["9:9"] },
      file,
      variables: { kind: "unavailable", status: 403, reason: "unavailable" },
    }),
    /selected Node tree is incomplete/,
  );
});

test("multiple selected roots receive visual candidates in stable round-robin order", () => {
  const root = (rootId: string, x: number) => ({
    id: rootId,
    name: `Root ${rootId}`,
    type: "SECTION",
    absoluteBoundingBox: { x, y: 0, width: 10_000, height: 8_000 },
    children: Array.from({ length: 12 }, (_, index) => ({
      id: `${rootId.split(":")[0]}:${index + 10}`,
      name: `Frame ${rootId}-${index}`,
      type: "FRAME",
      absoluteBoundingBox: { x: x + index * 740, y: 100, width: 720, height: 620 },
      children: [],
    })),
  });
  const normalized = normalizeFigmaImport({
    source: { ...source, nodeIds: ["1:1", "2:1"] },
    file: {
      ...file,
      document: { ...file.document, children: [root("1:1", 0), root("2:1", 20_000)] },
    },
    variables: { kind: "unavailable", status: 403, reason: "unavailable" },
  });

  assert.equal(normalized.visualCandidates.length, 12);
  assert.deepEqual(normalized.visualCandidates.slice(0, 4).map((candidate) => candidate.selectedNodeId), [
    "1:1", "2:1", "1:1", "2:1",
  ]);
  assert.equal(normalized.visualLayout.diagnostics &&
    (normalized.visualLayout.diagnostics as { truncated?: unknown }).truncated, true);
  assert.ok(normalized.incomplete.includes("visual-layout-node-budget"));
});

test("Board and Slides adapters label Design.md without inventing component or token semantics", () => {
  for (const fixture of [
    { fileType: "board" as const, editorType: "figjam", marker: "research/knowledge" },
    { fileType: "slides" as const, editorType: "slides", marker: "storyboard" },
  ]) {
    const normalized = normalizeFigmaImport({
      source: { ...source, fileType: fixture.fileType },
      file: { ...file, editorType: fixture.editorType },
      variables: { kind: "unavailable", status: 404, reason: "not applicable" },
    });
    assert.match(normalized.designMarkdown.bytes.toString("utf8"), new RegExp(fixture.marker));
    const components = JSON.parse(normalized.componentsJson.bytes.toString("utf8"));
    const tokens = JSON.parse(normalized.tokensJson.bytes.toString("utf8"));
    assert.deepEqual(components.components, []);
    assert.deepEqual(components.componentSets, []);
    assert.equal(tokens.authority, "not-applicable");
    assert.deepEqual(tokens.variables, []);
  }
});

test("URL adapter and API editorType mismatches fail closed", () => {
  assert.throws(
    () => normalizeFigmaImport({
      source: { ...source, fileType: "board" },
      file,
      variables: { kind: "unavailable", status: 404, reason: "not applicable" },
    }),
    /does not match/,
  );
});

test("raw and derived Figma artifacts omit ephemeral remote resource URLs but retain the normalized source URL", () => {
  const remote = "https://s3.example.invalid/temporary-render?signature=secret";
  const normalized = normalizeFigmaImport({
    source,
    file: {
      ...file,
      thumbnailUrl: remote,
      pluginData: { arbitrary: ["https://cdn.example.invalid/render.png?X-Amz-Signature=abc&X-Amz-Expires=30"] },
      components: {
        "2:2": { ...file.components["2:2"], thumbnail_url: remote },
      },
    },
    variables: { kind: "available", body: variables },
  });
  for (const artifact of [normalized.rawFile, normalized.designMarkdown, normalized.componentsJson, normalized.tokensJson]) {
    assert.equal(artifact.bytes.includes(Buffer.from(remote)), false);
    assert.equal(artifact.bytes.includes(Buffer.from("X-Amz-Signature")), false);
  }
  assert.match(normalized.rawFile.bytes.toString("utf8"), /ephemeral-remote-resource/);
  assert.match(normalized.designMarkdown.bytes.toString("utf8"), /https:\/\/www\.figma\.com\/design/);
  assert.ok(normalized.warnings.some((warning) => /remote resource/.test(warning)));
});

test("signed remote URLs in semantic scalars and object keys never reach derived or manifest-facing fields", () => {
  const remoteUrl = "https://s3.amazonaws.com/private/render?X-Amz-Signature=secret&X-Amz-Expires=30";
  const remote = `Project prefix ${remoteUrl} trailing text`;
  const normalized = normalizeFigmaImport({
    source,
    file: {
      ...file,
      name: remote,
      role: remote,
      linkAccess: remote,
      lastModified: remote,
      document: { ...file.document, name: remote, children: [{ id: "1:2", type: "CANVAS", name: remote }] },
      components: {
        [remote]: { key: remote, name: remote, description: remote },
      },
    },
    variables: { kind: "available", body: variables },
  });
  assert.equal(normalized.fileName, "Untitled Figma import");
  assert.equal(normalized.role, null);
  assert.equal(normalized.linkAccess, null);
  assert.equal(normalized.lastModified, null);
  const texts = [normalized.rawFile, normalized.designMarkdown, normalized.componentsJson, normalized.tokensJson]
    .map((artifact) => artifact.bytes.toString("utf8"));
  for (const text of texts) {
    assert.equal(text.includes("s3.amazonaws.com"), false);
    assert.equal(text.includes("X-Amz-Signature"), false);
  }
  assert.equal(normalized.warnings.some((warning) => warning.includes("s3.amazonaws.com")), false);
});

test("raw Figma responses fail with controlled errors when structural depth or width exceeds budgets", () => {
  let deep: unknown = "leaf";
  for (let index = 0; index < 70; index += 1) deep = { child: deep };
  for (const malicious of [
    { ...file, malicious: deep },
    { ...file, malicious: new Array(50_001).fill(null) },
  ]) {
    assert.throws(
      () => normalizeFigmaImport({ source, file: malicious, variables: { kind: "available", body: variables } }),
      /structural budget/,
    );
  }
});

test("Figma-authored names remain Markdown plaintext and cannot inject headings, links, or images", () => {
  const hostile = "# Injected [click](https://evil.invalid) ![image](https://evil.invalid/x.png)";
  const normalized = normalizeFigmaImport({
    source,
    file: {
      ...file,
      name: hostile,
      document: { ...file.document, children: [{ id: "1:2", type: "CANVAS", name: hostile }] },
      components: { "2:2": { ...file.components["2:2"], name: hostile } },
    },
    variables: { kind: "available", body: variables },
  });
  const markdown = normalized.designMarkdown.bytes.toString("utf8");
  assert.equal(markdown.includes("[click](https://evil.invalid)"), false);
  assert.equal(markdown.includes("![image](https://evil.invalid/x.png)"), false);
  assert.equal(markdown.includes("\n# Injected"), false);
  assert.ok(markdown.includes("\\# Injected \\[click\\]\\(https://evil\\.invalid\\)"));
});
