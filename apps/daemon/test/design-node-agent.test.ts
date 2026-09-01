import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  AgentExecutionIdentityError,
  AgentTurnError,
  ClaudeCodeRunner,
  type AgentRunner,
  type AgentTurnInput,
} from "../../../packages/agent/src/index.ts";
import { Store } from "../../../packages/core/src/index.ts";
import {
  getDesignCanvas,
  getDesignJob,
  getDesignThread,
  initializeDesignProject,
  importDesignCanvasAssetBatch,
  listDesignVersions,
  listDesignJobs,
  mutateDesignCanvas,
  publishDesignVersion,
  storeDesignAsset,
} from "../src/design/design-storage.ts";
import {
  buildDesignNodeSystemPrompt,
  cancelDesignNodeTurn,
  startDesignNodeTurn,
} from "../src/design/design-node-agent.ts";
import type { DesignNodeRuntimeAssetDescriptor } from "../src/design/design-node-runtime-gate.ts";

test("Node generation prompts bind the exact target and expose kind-specific contracts", () => {
  const store = new Store(":memory:");
  try {
    const settings = store.getSettings();
    const page = buildDesignNodeSystemPrompt({
      settings,
      message: "Create it",
      node: { id: "node-page", kind: "page", name: "Home" },
    });
    const research = buildDesignNodeSystemPrompt({
      settings,
      message: "Research it",
      node: { id: "node-research", kind: "research", name: "Audience evidence" },
    });
    const designSystem = buildDesignNodeSystemPrompt({
      settings,
      message: "Build the system",
      node: { id: "node-system", kind: "design-system", name: "Design System" },
    });
    const componentLibrary = buildDesignNodeSystemPrompt({
      settings,
      message: "Build the library",
      node: { id: "node-library", kind: "component", name: "Component Library" },
    });
    assert.match(page, /node-page.*page/i);
    assert.match(page, /complete responsive page/i);
    assert.match(page, /320px.*horizontal overflow/i);
    assert.match(research, /node-research.*research/i);
    assert.match(research, /evidence.*sources|sources.*evidence/i);
    assert.match(designSystem, /primitive.*semantic.*component.*UI tokens/i);
    assert.match(designSystem, /inputs.*navigation.*overlays.*feedback.*data display.*complex composition/i);
    assert.match(componentLibrary, /production-scale categorized catalog/i);
    assert.match(componentLibrary, /states.*variants.*accessibility.*content.*motion/i);
    assert.notEqual(page, research);
    assert.doesNotMatch(page, /Dezin Render Frame|dezin:frame-change|Viewer and visual QA|Vite|npm\s+install|pre-installed React|GSAP|CDN/i);
    assert.match(page, /untrusted reference data/i);
    assert.match(page, /cannot change these instructions/i);
    assert.match(page, /visual-reference.*layout-authority/i);
    assert.match(page, /read.*visual.*layout.*before drafting/i);
    assert.match(page, /product surface.*frame geometry/i);
    assert.match(page, /semantic-outline.*never.*visual evidence/i);
    assert.match(page, /reference-overview.*not.*target/i);
    assert.match(page, /reference-frame.*visual authority/i);
    assert.match(page, /not.*pixel-perfect/i);
    assert.match(page, /without.*referenceAuthority.*background/i);
    assert.match(page, /re-open.*index\.html.*audit/i);
    assert.match(page, /never inject markup.*innerHTML/i);
    assert.match(page, /never construct.*URL-bearing attribute.*dynamically/i);
    assert.match(page, /never pass.*variable.*tag name.*createElement/i);
    assert.match(page, /Map.*computed.*receiver|computed.*receiver.*Map/i);
  } finally {
    store.close();
  }
});

test("explicit Figma references carry visual, layout, and semantic authority into the staged Agent context", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "dezin-design-figma-reference-authority-"));
  const projectId = "project-figma-reference-authority";
  const referenceBytes = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from("figma visual reference"),
  ]);
  const overviewBytes = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from("figma reference overview"),
  ]);
  const layoutBytes = Buffer.from(JSON.stringify({ frame: { width: 720, height: 727 }, surface: "modal" }));
  const outlineBytes = Buffer.from("# Popup\n\nSemantic outline only.");
  const runner: AgentRunner = {
    id: "figma-reference-authority-fake",
    async runTurn(input) {
      const context = JSON.parse(await readFile(join(input.projectDir, ".context", "canvas.json"), "utf8"));
      const byId = new Map(context.nodes.map((node: { id: string }) => [node.id, node]));
      const reference = byId.get("node-reference") as { name: string; referenceAuthority?: string; assetPath: string };
      const overview = byId.get("node-overview") as { referenceAuthority?: string; referenceRole?: string };
      const layout = byId.get("node-layout") as { referenceAuthority?: string; assetPath: string };
      const outline = byId.get("node-outline") as { referenceAuthority?: string };
      const background = byId.get("node-background") as Record<string, unknown>;

      assert.equal(reference.name, "Library detail state");
      assert.equal(reference.referenceAuthority, "visual-reference");
      assert.equal((reference as { referenceRole?: string }).referenceRole, "reference-frame");
      assert.equal(overview.referenceAuthority, "visual-reference");
      assert.equal(overview.referenceRole, "reference-overview");
      assert.equal(layout.referenceAuthority, "layout-authority");
      assert.equal(outline.referenceAuthority, "semantic-outline");
      assert.equal(Object.hasOwn(background, "referenceAuthority"), false);
      assert.deepEqual(await readFile(join(input.projectDir, reference.assetPath)), referenceBytes);
      assert.deepEqual(JSON.parse(await readFile(join(input.projectDir, layout.assetPath), "utf8")), {
        frame: { width: 720, height: 727 },
        surface: "modal",
      });

      const html = "<!doctype html><html><head><title>Figma grounded page</title></head><body><main>Grounded</main></body></html>";
      await writeFile(join(input.projectDir, "index.html"), html);
      return { text: "generated", artifactHtml: html, artifactPath: "index.html" };
    },
  };
  try {
    await initializeDesignProject(dataDir, projectId);
    const imported = await importDesignCanvasAssetBatch(dataDir, projectId, {
      expectedRevision: 0,
      items: [
        {
          asset: { name: "reference.png", mimeType: "image/png", base64: referenceBytes.toString("base64") },
          binding: { type: "create-node", node: { id: "node-reference", kind: "image", name: "reference.png" } },
        },
        {
          asset: { name: "reference-overview.png", mimeType: "image/png", base64: overviewBytes.toString("base64") },
          binding: { type: "create-node", node: { id: "node-overview", kind: "image", name: "reference-overview.png" } },
        },
        {
          asset: { name: "layout.json", mimeType: "application/json", base64: layoutBytes.toString("base64") },
          binding: { type: "create-node", node: { id: "node-layout", kind: "file", name: "layout.json" } },
        },
        {
          asset: { name: "Design.md", mimeType: "text/markdown", base64: outlineBytes.toString("base64") },
          binding: { type: "create-node", node: { id: "node-outline", kind: "document", name: "Design.md" } },
        },
        {
          asset: { name: "reference.png", mimeType: "image/png", base64: referenceBytes.toString("base64") },
          binding: { type: "create-node", node: { id: "node-background", kind: "image", name: "reference.png" } },
        },
      ],
    });
    await mutateDesignCanvas(dataDir, projectId, {
      expectedRevision: imported.revision,
      intents: [
        { type: "update-node", nodeId: "node-reference", patch: { name: "Library detail state" } },
        { type: "update-node", nodeId: "node-overview", patch: { name: "Imported state map" } },
        { type: "update-node", nodeId: "node-layout", patch: { name: "Desktop frame geometry" } },
        { type: "update-node", nodeId: "node-outline", patch: { name: "Product information architecture" } },
        { type: "add-node", node: { id: "node-page", kind: "page", name: "Grounded page" } },
      ],
    });
    const completed = await (await startDesignNodeTurn({
      dataDir,
      projectId,
      nodeId: "node-page",
      message: "Use the selected Figma references",
      systemPrompt: "Write index.html",
      runner,
      contextNodeIds: ["node-reference", "node-overview", "node-layout", "node-outline"],
    })).completion;
    assert.equal(completed.status, "ready", completed.error ?? "Figma reference context failed");
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("a Node Agent continues once in the same staging directory when it stops after planning", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "dezin-design-node-plan-only-continuation-"));
  const projectId = "project-plan-only-continuation";
  const prompts: string[] = [];
  const workingDirectories: string[] = [];
  let calls = 0;
  const runner = new ClaudeCodeRunner({
    id: "plan-only-continuation-fake",
    command: "codebuddy",
    spawner: {
      async run(input) {
        calls += 1;
        prompts.push(input.stdin);
        workingDirectories.push(input.cwd);
        if (calls === 2) {
          const html = "<!doctype html><html><head><title>Completed page</title></head><body><main>Completed in place</main></body></html>";
          await writeFile(join(input.cwd, "index.html"), html);
        }
        return {
          stdout: [
            JSON.stringify({
              type: "system", subtype: "init", session_id: `continuation-${calls}`,
              model: "hy3-ioa", apiKeySource: "test", claude_code_version: "2.133.1",
            }),
            JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: calls === 1 ? "I will plan the page." : "Completed the staged Node" }] } }),
            JSON.stringify({ type: "result", subtype: "success", result: calls === 1 ? "planned" : "done", is_error: false }),
          ].join("\n"),
          exitCode: 0,
        };
      },
    },
  });
  try {
    await initializeDesignProject(dataDir, projectId);
    await mutateDesignCanvas(dataDir, projectId, {
      expectedRevision: 0,
      intents: [{ type: "add-node", node: { id: "node-page", kind: "page" } }],
    });
    const started = await startDesignNodeTurn({
      dataDir, projectId, nodeId: "node-page", message: "Build the page", systemPrompt: "Write index.html", runner,
    });

    const completed = await started.completion;
    assert.equal(completed.status, "ready", completed.error ?? "Plan-only continuation failed");
    assert.equal(calls, 2);
    assert.equal(new Set(workingDirectories).size, 1);
    assert.match(prompts[1] ?? "", /Build the page/);
    assert.match(prompts[1] ?? "", /stopped after planning/i);
    assert.match(prompts[1] ?? "", /write the complete index\.html/i);
    assert.ok(completed.activity.some((entry) => /stopped after planning.*continuing the same staged Node once/i.test(entry.text)));
    assert.equal((await listDesignVersions(dataDir, projectId, "node-page")).length, 1);
    const thread = await getDesignThread(dataDir, projectId, { type: "node", nodeId: "node-page" });
    assert.deepEqual(thread.messages.map((message) => message.role), ["user", "assistant"]);
    assert.match(thread.messages.at(-1)?.content ?? "", /completed the staged Node/i);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("a Node Agent retries one transient provider failure in the same confined staging directory", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "dezin-design-node-transient-retry-"));
  const projectId = "project-transient-retry";
  const directories: string[] = [];
  let calls = 0;
  const runner: AgentRunner = {
    id: "transient-retry-fake",
    async runTurn(input) {
      calls += 1;
      directories.push(input.projectDir);
      if (calls === 1) throw new Error("provider returned 503: temporarily unavailable");
      const html = "<!doctype html><html><head><title>Recovered page</title></head><body><main>Recovered</main></body></html>";
      await writeFile(join(input.projectDir, "index.html"), html);
      assert.equal(input.isRepair, true);
      assert.match(input.message, /transient provider failure/i);
      return { text: "Recovered after transient failure", artifactHtml: html, artifactPath: "index.html" };
    },
  };
  try {
    await initializeDesignProject(dataDir, projectId);
    await mutateDesignCanvas(dataDir, projectId, {
      expectedRevision: 0,
      intents: [{ type: "add-node", node: { id: "node-page", kind: "page" } }],
    });
    const started = await startDesignNodeTurn({
      dataDir, projectId, nodeId: "node-page", message: "Build the page", systemPrompt: "Write index.html", runner,
    });

    const completed = await started.completion;
    assert.equal(completed.status, "ready", completed.error ?? "Transient retry failed");
    assert.equal(calls, 2);
    assert.equal(new Set(directories).size, 1);
    assert.ok(completed.activity.some((entry) => /transient provider failure.*retrying once/i.test(entry.text)));
    assert.equal((await listDesignVersions(dataDir, projectId, "node-page")).length, 1);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("a transient retry preserves the first attested identity when its second attempt fails plainly", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "dezin-design-node-transient-identity-"));
  const projectId = "project-transient-identity";
  let calls = 0;
  const executionIdentity = {
    requested: { providerId: "codebuddy", model: null },
    observed: {
      providerId: "codebuddy",
      model: "hy3-ioa",
      command: "codebuddy",
      cliVersion: "2.133.1",
      apiKeySource: "test",
      protocol: "claude-stream-json-init-v1" as const,
    },
  };
  const runner: AgentRunner = {
    id: "codebuddy",
    identityProtocol: "claude-stream-json-init-v1",
    async runTurn() {
      calls += 1;
      if (calls === 1) throw new AgentTurnError("provider returned 503 temporarily unavailable", executionIdentity);
      throw new Error("second attempt failed before identity output");
    },
  };
  try {
    await initializeDesignProject(dataDir, projectId);
    await mutateDesignCanvas(dataDir, projectId, {
      expectedRevision: 0,
      intents: [{ type: "add-node", node: { id: "node-page", kind: "page" } }],
    });
    const completed = await (await startDesignNodeTurn({
      dataDir, projectId, nodeId: "node-page", message: "Build", systemPrompt: "Write", runner,
    })).completion;
    assert.equal(calls, 2);
    assert.equal(completed.status, "failed");
    assert.equal(completed.runnerId, "codebuddy");
    assert.equal(completed.model, "hy3-ioa");
    assert.match(completed.error ?? "", /second attempt failed/i);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("a failed plan-only continuation preserves the identity attested by its first turn", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "dezin-design-node-continuation-identity-"));
  const projectId = "project-continuation-identity";
  let calls = 0;
  const runner = new ClaudeCodeRunner({
    id: "codebuddy",
    command: "codebuddy",
    spawner: {
      async run() {
        calls += 1;
        if (calls >= 2) throw new Error("codebuddy timed out after 1000ms");
        return {
          stdout: [
            JSON.stringify({
              type: "system", subtype: "init", session_id: "plan-only-attested",
              model: "hy3-ioa", apiKeySource: "test", claude_code_version: "2.133.1",
            }),
            JSON.stringify({ type: "result", subtype: "success", result: "planned", is_error: false }),
          ].join("\n"),
          exitCode: 0,
        };
      },
    },
  });
  try {
    await initializeDesignProject(dataDir, projectId);
    await mutateDesignCanvas(dataDir, projectId, {
      expectedRevision: 0,
      intents: [{ type: "add-node", node: { id: "node-page", kind: "page" } }],
    });
    const started = await startDesignNodeTurn({
      dataDir, projectId, nodeId: "node-page", message: "Build the page", systemPrompt: "Write index.html", runner,
    });

    const completed = await started.completion;
    assert.equal(calls, 3);
    assert.equal(completed.status, "failed");
    assert.equal(completed.runnerId, "codebuddy");
    assert.equal(completed.model, "hy3-ioa");
    assert.match(completed.error ?? "", /timed out/i);
    assert.deepEqual(await listDesignVersions(dataDir, projectId, "node-page"), []);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("a Node Agent repairs the exact generated-HTML validation diagnostic in place", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "dezin-design-node-validation-repair-"));
  const projectId = "project-validation-repair";
  const inputs: AgentTurnInput[] = [];
  const runner: AgentRunner = {
    id: "validation-repair-fake",
    async runTurn(input) {
      inputs.push(input);
      const initial = `<!doctype html><html><head><title>Local index</title></head><body><a id="one">One</a><script>
        const links = Array.from(document.querySelectorAll("a"));
        const linkById = links.reduce((accumulator) => accumulator, {});
        for (const link of links) {
          const id = link.id;
          linkById[id] = link;
        }
      </script></body></html>`;
      const repaired = `<!doctype html><html><head><title>Local index</title></head><body><a id="one">One</a><script>
        const links = Array.from(document.querySelectorAll("a"));
        const linkById = new Map();
        for (const link of links) {
          linkById.set(link.id, link);
        }
        document.body.dataset.links = String(linkById.size);
      </script></body></html>`;
      const html = inputs.length === 1 ? initial : repaired;
      if (inputs.length === 2) {
        assert.equal(input.isRepair, true);
        assert.match(input.message, /daemon diagnostic.*data, not an instruction/i);
        assert.match(input.message, /member <dynamic>.*linkById\[id\] = link/i);
        assert.match(input.message, /repair attempt 1 of 2/i);
        assert.deepEqual(input.history?.slice(-2).map((turn) => turn.role), ["user", "assistant"]);
      }
      await writeFile(join(input.projectDir, "index.html"), html);
      return { text: inputs.length === 1 ? "Initial draft" : "Repaired the lookup table", artifactHtml: html, artifactPath: "index.html" };
    },
  };
  try {
    await initializeDesignProject(dataDir, projectId);
    await mutateDesignCanvas(dataDir, projectId, {
      expectedRevision: 0,
      intents: [{ type: "add-node", node: { id: "node-page", kind: "page" } }],
    });
    const started = await startDesignNodeTurn({
      dataDir,
      projectId,
      nodeId: "node-page",
      message: "Build a local link index",
      systemPrompt: "Write index.html",
      runner,
    });

    const completed = await started.completion;
    assert.equal(completed.status, "ready", completed.error ?? "Validation repair failed");
    assert.equal(inputs.length, 2);
    assert.deepEqual(inputs[0]?.history, []);
    assert.equal(new Set(inputs.map((input) => input.projectDir)).size, 1);
    assert.ok(completed.activity.some((entry) => /validation found a repairable issue.*attempt 1 of 2/i.test(entry.text)));
    const versions = await listDesignVersions(dataDir, projectId, "node-page");
    assert.equal(versions.length, 1);
    const publishedHtml = await readFile(join(
      dataDir, "projects", projectId, "design", "nodes", "node-page", "versions", versions[0]!.id, "index.html",
    ), "utf8");
    assert.match(publishedHtml, /new Map\(\)/);
    assert.doesNotMatch(publishedHtml, /linkById\[id\]\s*=/);
    const thread = await getDesignThread(dataDir, projectId, { type: "node", nodeId: "node-page" });
    assert.deepEqual(thread.messages.map((message) => message.role), ["user", "assistant"]);
    assert.match(thread.messages.at(-1)?.content ?? "", /repaired the lookup table/i);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("a Page first generation repairs a missing title and atomically adopts it as the default Node name", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "dezin-design-page-title-"));
  const projectId = "project-page-title";
  let calls = 0;
  const runner: AgentRunner = {
    id: "page-title-fake",
    async runTurn(input) {
      calls += 1;
      const html = calls === 1
        ? "<!doctype html><html><head></head><body><main>Untitled draft</main></body></html>"
        : "<!doctype html><html><head><title>  Atlas   Workspace  </title></head><body><main>Named page</main></body></html>";
      if (calls === 2) {
        assert.equal(input.isRepair, true);
        assert.match(input.message, /page.*title|title.*page/i);
      }
      await writeFile(join(input.projectDir, "index.html"), html);
      return { text: calls === 1 ? "Draft" : "Added the title", artifactHtml: html, artifactPath: "index.html" };
    },
  };
  try {
    await initializeDesignProject(dataDir, projectId);
    await mutateDesignCanvas(dataDir, projectId, {
      expectedRevision: 0,
      intents: [{ type: "add-node", node: { id: "node-page", kind: "page" } }],
    });
    const started = await startDesignNodeTurn({
      dataDir, projectId, nodeId: "node-page", message: "Build it", systemPrompt: "Write index.html", runner,
    });
    const completed = await started.completion;
    assert.equal(completed.status, "ready", completed.error ?? "Page title repair failed");
    assert.equal(calls, 2);
    const node = (await getDesignCanvas(dataDir, projectId)).nodes[0]!;
    assert.equal(node.name, "Atlas Workspace");
    assert.equal(node.versionCount, 1);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("a Node browser runtime gate returns blank, overflow, runtime, and a11y diagnostics through the bounded repair loop", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "dezin-design-node-runtime-gate-"));
  const projectId = "project-node-runtime-gate";
  let runnerCalls = 0;
  let gateCalls = 0;
  const runner: AgentRunner = {
    id: "runtime-gate-fake",
    async runTurn(input) {
      runnerCalls += 1;
      const html = `<!doctype html><html><head><title>Runtime checked</title></head><body><main>${runnerCalls === 1 ? "Draft" : "Accessible result"}</main></body></html>`;
      if (runnerCalls === 2) assert.match(input.message, /runtime gate.*blank/i);
      await writeFile(join(input.projectDir, "index.html"), html);
      return { text: `turn-${runnerCalls}`, artifactHtml: html, artifactPath: "index.html" };
    },
  };
  try {
    await initializeDesignProject(dataDir, projectId);
    await mutateDesignCanvas(dataDir, projectId, {
      expectedRevision: 0,
      intents: [{ type: "add-node", node: { id: "node-page", kind: "page" } }],
    });
    const completed = await (await startDesignNodeTurn({
      dataDir,
      projectId,
      nodeId: "node-page",
      message: "Build",
      systemPrompt: "Write",
      runner,
      runtimeGate: async () => {
        gateCalls += 1;
        if (gateCalls === 1) throw new Error("Node runtime gate failed at mobile: rendered output is blank");
        return { viewports: 2, meaningfulElements: 1 };
      },
    })).completion;
    assert.equal(completed.status, "ready", completed.error ?? "Runtime repair failed");
    assert.equal(runnerCalls, 2);
    assert.equal(gateCalls, 2);
    assert.ok(completed.activity.some((entry) => /runtime gate passed 2 responsive viewport/i.test(entry.text)));
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("a Node runtime gate receives lazy descriptors for exact materialized frozen Asset ownership", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "dezin-design-node-runtime-assets-"));
  const projectId = "project-node-runtime-assets";
  const assetBytes = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from("runtime frozen asset"),
  ]);
  const observedAssets: DesignNodeRuntimeAssetDescriptor[] = [];
  const runner: AgentRunner = {
    id: "runtime-asset-fake",
    async runTurn(input) {
      const context = JSON.parse(await readFile(join(input.projectDir, ".context", "canvas.json"), "utf8"));
      const assetId = context.nodes.find((node: { id: string }) => node.id === "node-image").assetId;
      const html = `<!doctype html><html><head><title>Runtime Asset</title></head><body><main>Asset<img alt="Reference" src="dezin-asset://${assetId}"></main></body></html>`;
      await writeFile(join(input.projectDir, "index.html"), html);
      return { text: "generated", artifactHtml: html, artifactPath: "index.html" };
    },
  };
  try {
    await initializeDesignProject(dataDir, projectId);
    const imported = await importDesignCanvasAssetBatch(dataDir, projectId, {
      expectedRevision: 0,
      items: [{
        asset: { name: "runtime.png", mimeType: "image/png", base64: assetBytes.toString("base64") },
        binding: { type: "create-node", node: { id: "node-image", kind: "image" } },
      }],
    });
    const assetId = imported.nodes.find((node) => node.id === "node-image")?.assetId;
    assert.ok(assetId);
    await mutateDesignCanvas(dataDir, projectId, {
      expectedRevision: imported.revision,
      intents: [{ type: "add-node", node: { id: "node-page", kind: "page" } }],
    });
    const completed = await (await startDesignNodeTurn({
      dataDir,
      projectId,
      nodeId: "node-page",
      message: "Build with the frozen reference",
      systemPrompt: "Write index.html",
      runner,
      runtimeGate: async (gateInput) => {
        observedAssets.push(...gateInput.assets);
        const descriptor = gateInput.assets.find((asset) => asset.assetId === assetId);
        assert.ok(descriptor);
        assert.equal(descriptor.mimeType, "image/png");
        assert.equal(descriptor.bytes, assetBytes.byteLength);
        assert.equal(descriptor.checksum, createHash("sha256").update(assetBytes).digest("hex"));
        assert.deepEqual(descriptor.ownerNodeIds, ["node-image"]);
        assert.equal(descriptor.stagingPath.startsWith(`${dataDir}/`), true);
        assert.deepEqual(await readFile(descriptor.stagingPath), assetBytes);
        return { viewports: 2, meaningfulElements: 1 };
      },
    })).completion;
    assert.equal(completed.status, "ready", completed.error ?? "Runtime Asset wiring failed");
    assert.equal(observedAssets.length, 1);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("Page titles never overwrite a user name or a name adopted by the first Version", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "dezin-design-page-title-stability-"));
  const projectId = "project-page-title-stability";
  const titleRunner = (titles: string[]): AgentRunner => ({
    id: "page-title-stability-fake",
    async runTurn(input) {
      const title = titles.shift()!;
      const html = `<!doctype html><html><head><title>${title}</title></head><body><main>${title}</main></body></html>`;
      await writeFile(join(input.projectDir, "index.html"), html);
      return { text: title, artifactHtml: html, artifactPath: "index.html" };
    },
  });
  try {
    await initializeDesignProject(dataDir, projectId);
    await mutateDesignCanvas(dataDir, projectId, {
      expectedRevision: 0,
      intents: [
        { type: "add-node", node: { id: "node-default", kind: "page" } },
        { type: "add-node", node: { id: "node-custom", kind: "page", name: "User landing" } },
      ],
    });
    const defaultRunner = titleRunner(["First title", "Second title"]);
    for (const message of ["First", "Second"]) {
      const started = await startDesignNodeTurn({
        dataDir, projectId, nodeId: "node-default", message, systemPrompt: "Write index.html", runner: defaultRunner,
      });
      assert.equal((await started.completion).status, "ready");
    }
    const custom = await startDesignNodeTurn({
      dataDir,
      projectId,
      nodeId: "node-custom",
      message: "Custom",
      systemPrompt: "Write index.html",
      runner: titleRunner(["Generated marketing title"]),
    });
    assert.equal((await custom.completion).status, "ready");
    const canvas = await getDesignCanvas(dataDir, projectId);
    assert.equal(canvas.nodes.find((node) => node.id === "node-default")?.name, "First title");
    assert.equal(canvas.nodes.find((node) => node.id === "node-default")?.versionCount, 2);
    assert.equal(canvas.nodes.find((node) => node.id === "node-custom")?.name, "User landing");
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("a Node Agent gets two bounded validation repairs when independent defects surface in sequence", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "dezin-design-node-two-repairs-"));
  const projectId = "project-two-repairs";
  const inputs: AgentTurnInput[] = [];
  const runner: AgentRunner = {
    id: "two-repairs-fake",
    async runTurn(input) {
      inputs.push(input);
      const html = inputs.length === 1
        ? '<!doctype html><html><head><title>Repair sequence</title></head><body><img src="https://example.invalid/remote.png"></body></html>'
        : inputs.length === 2
          ? '<!doctype html><html><head><title>Repair sequence</title></head><body><button onclick="this.textContent=\'Done\'">Run</button></body></html>'
          : '<!doctype html><html><head><title>Repair sequence</title></head><body><button id="run">Run</button><script>document.querySelector("#run").addEventListener("click", (event) => { event.currentTarget.textContent = "Done"; });</script></body></html>';
      await writeFile(join(input.projectDir, "index.html"), html);
      return { text: `turn-${inputs.length}`, artifactHtml: html, artifactPath: "index.html" };
    },
  };
  try {
    await initializeDesignProject(dataDir, projectId);
    await mutateDesignCanvas(dataDir, projectId, {
      expectedRevision: 0,
      intents: [{ type: "add-node", node: { id: "node-page", kind: "page" } }],
    });
    const started = await startDesignNodeTurn({
      dataDir, projectId, nodeId: "node-page", message: "Repair every defect", systemPrompt: "Write index.html", runner,
    });
    const completed = await started.completion;
    assert.equal(completed.status, "ready", completed.error ?? "Second repair did not publish");
    assert.equal(inputs.length, 3);
    assert.equal(inputs[1]?.isRepair, true);
    assert.equal(inputs[2]?.isRepair, true);
    assert.match(inputs[1]?.message ?? "", /repair attempt 1 of 2/i);
    assert.match(inputs[2]?.message ?? "", /repair attempt 2 of 2/i);
    assert.equal(completed.activity.filter((entry) => /validation found a repairable issue/i.test(entry.text)).length, 2);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("a Node Agent fails closed after its bounded validation repairs are exhausted", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "dezin-design-node-repair-exhausted-"));
  const projectId = "project-repair-exhausted";
  let calls = 0;
  const runner: AgentRunner = {
    id: "repair-exhausted-fake",
    async runTurn(input) {
      calls += 1;
      const html = '<!doctype html><html><head></head><body><script src="https://example.invalid/remote.js"></script></body></html>';
      await writeFile(join(input.projectDir, "index.html"), html);
      return { text: "still invalid", artifactHtml: html, artifactPath: "index.html" };
    },
  };
  try {
    await initializeDesignProject(dataDir, projectId);
    await mutateDesignCanvas(dataDir, projectId, {
      expectedRevision: 0,
      intents: [{ type: "add-node", node: { id: "node-page", kind: "page" } }],
    });
    const started = await startDesignNodeTurn({
      dataDir, projectId, nodeId: "node-page", message: "Stay local", systemPrompt: "Write index.html", runner,
    });
    const completed = await started.completion;
    assert.equal(calls, 3);
    assert.equal(completed.status, "failed");
    assert.match(completed.error ?? "", /remote scripts or resources|unpinned or external URL/i);
    assert.equal(completed.activity.filter((entry) => /validation found a repairable issue/i.test(entry.text)).length, 2);
    assert.deepEqual(await listDesignVersions(dataDir, projectId, "node-page"), []);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("a provider failure during validation repair terminalizes the same Job without rebinding its identity", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "dezin-design-node-repair-provider-failure-"));
  const projectId = "project-repair-provider-failure";
  let calls = 0;
  const executionIdentity = {
    requested: { providerId: "codebuddy", model: null },
    observed: {
      providerId: "codebuddy",
      model: "hy3-ioa",
      command: "codebuddy",
      cliVersion: "2.133.1",
      apiKeySource: "copilot.tencent.com",
      protocol: "claude-stream-json-init-v1" as const,
    },
  };
  const runner: AgentRunner = {
    id: "codebuddy",
    identityProtocol: "claude-stream-json-init-v1",
    async runTurn(input) {
      calls += 1;
      if (calls === 2) {
        throw new AgentTurnError("codebuddy returned an error result: authentication expired", executionIdentity);
      }
      const html = '<!doctype html><html><head></head><body><script src="https://example.invalid/remote.js"></script></body></html>';
      await writeFile(join(input.projectDir, "index.html"), html);
      return { text: "initial invalid draft", artifactHtml: html, artifactPath: "index.html", executionIdentity };
    },
  };
  try {
    await initializeDesignProject(dataDir, projectId);
    await mutateDesignCanvas(dataDir, projectId, {
      expectedRevision: 0,
      intents: [{ type: "add-node", node: { id: "node-page", kind: "page" } }],
    });
    const started = await startDesignNodeTurn({
      dataDir, projectId, nodeId: "node-page", message: "Generate safely", systemPrompt: "Write index.html", runner,
    });

    const completed = await started.completion;
    assert.equal(calls, 2);
    assert.equal(completed.status, "failed");
    assert.equal(completed.runnerId, "codebuddy");
    assert.equal(completed.model, "hy3-ioa");
    assert.match(completed.error ?? "", /authentication expired/i);
    const canvas = await getDesignCanvas(dataDir, projectId);
    assert.equal(canvas.nodes[0]?.state, "failed");
    assert.equal(canvas.nodes[0]?.activeJobId, null);
    assert.deepEqual(await listDesignVersions(dataDir, projectId, "node-page"), []);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

class WritingRunner implements AgentRunner {
  readonly id = "writing-fake";
  input: AgentTurnInput | null = null;

  async runTurn(input: AgentTurnInput) {
    this.input = input;
    const context = JSON.parse(await readFile(join(input.projectDir, ".context", "canvas.json"), "utf8"));
    assert.equal(context.targetNodeId, "node-page");
    const shared = context.nodes.find((node: { id: string }) => node.id === "node-shared");
    assert.match(shared.selectedVersionPath, /^\.context\/nodes\//);
    assert.match(await readFile(join(input.projectDir, shared.selectedVersionPath), "utf8"), /Shared context/);
    assert.equal(shared.selectedVersionAssetPins.length, 1);
    assert.match(shared.selectedVersionAssetPins[0].path, /^\.context\/assets\//);
    const pinnedBytes = await readFile(join(input.projectDir, shared.selectedVersionAssetPins[0].path));
    assert.deepEqual([...pinnedBytes.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const sharedDuplicate = context.nodes.find((node: { id: string }) => node.id === "node-shared-2");
    assert.equal(sharedDuplicate.selectedVersionAssetPins[0].path, shared.selectedVersionAssetPins[0].path);
    const image = context.nodes.find((node: { id: string }) => node.id === "node-image");
    assert.match(image.assetPath, /^\.context\/assets\//);
    const imageBytes = await readFile(join(input.projectDir, image.assetPath));
    assert.deepEqual([...imageBytes.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const duplicateImage = context.nodes.find((node: { id: string }) => node.id === "node-image-2");
    assert.equal(duplicateImage.assetPath, image.assetPath);
    const html = "<!doctype html><html><head><title>Generated page</title><style>body{margin:0}</style></head><body><main data-design-node-id=\"hero\">Generated</main></body></html>";
    await writeFile(join(input.projectDir, "index.html"), html);
    input.onActivity?.({
      kind: "tool",
      name: "Write",
      summary: "Writing index.html",
      toolCallId: "tool-write-index",
      toolInput: "{\"file_path\":\"index.html\"}",
      diff: "--- /dev/null\n+++ b/index.html\n@@ -0,0 +1,1 @@\n+<!doctype html>",
    });
    input.onActivity?.({
      kind: "tool-result",
      toolCallId: "tool-write-index",
      toolResult: "File written",
      toolResultError: false,
    });
    return {
      text: "Generated the page.",
      artifactHtml: html,
      artifactPath: "index.html",
      executionIdentity: {
        requested: { providerId: this.id, model: null },
        observed: {
          providerId: this.id,
          model: "runtime-fixture-model",
          command: "writing-fake",
          cliVersion: "1.0.0",
          apiKeySource: null,
          protocol: "claude-stream-json-init-v1" as const,
        },
      },
    };
  }
}

test("a Node Agent owns one staged HTML output and publishes an immutable version", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "dezin-design-node-agent-"));
  const projectId = "project-agent";
  try {
    await initializeDesignProject(dataDir, projectId);
    const assetBytes = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from("context image"),
    ]);
    await storeDesignAsset(dataDir, projectId, {
      name: "context.png",
      mimeType: "image/png",
      base64: assetBytes.toString("base64"),
    });
    const pinnedAsset = await storeDesignAsset(dataDir, projectId, {
      name: "version-only.png",
      mimeType: "image/png",
      base64: Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        Buffer.from("version-only image"),
      ]).toString("base64"),
    });
    await mutateDesignCanvas(dataDir, projectId, {
      expectedRevision: 0,
      intents: [
        { type: "add-node", node: { id: "node-shared", kind: "component", name: "Shared" } },
        { type: "add-node", node: { id: "node-shared-2", kind: "component", name: "Shared copy" } },
        { type: "add-node", node: { id: "node-page", kind: "page", name: "Home" } },
      ],
    });
    await importDesignCanvasAssetBatch(dataDir, projectId, {
      expectedRevision: 1,
      items: [
        {
          asset: { name: "context.png", mimeType: "image/png", base64: assetBytes.toString("base64") },
          binding: { type: "create-node", node: { id: "node-image", kind: "image", name: "Image" } },
        },
        {
          asset: { name: "context.png", mimeType: "image/png", base64: assetBytes.toString("base64") },
          binding: { type: "create-node", node: { id: "node-image-2", kind: "image", name: "Image copy" } },
        },
      ],
    });
    for (const nodeId of ["node-shared", "node-shared-2"]) {
      await publishDesignVersion(dataDir, projectId, {
        nodeId,
        html: `<!doctype html><html><head><style>body{margin:0}</style></head><body>Shared context<img src="dezin-asset://${pinnedAsset.id}"></body></html>`,
        contextHash: "a".repeat(64),
        canvasRevision: 2,
        expectedHeadVersionId: null,
        jobId: null,
        runnerId: "fixture",
        model: null,
      });
    }
    const runner = new WritingRunner();
    const started = await startDesignNodeTurn({
      dataDir,
      projectId,
      nodeId: "node-page",
      message: "Design a distinctive home page",
      systemPrompt: "Follow Dezin's design-quality contract. Write one index.html.",
      runner,
      contextNodeIds: ["node-shared", "node-image"],
    });
    assert.equal(started.job.runnerId, "writing-fake");
    assert.equal(started.job.model, null);
    const completed = await started.completion;
    assert.equal(completed.status, "ready");
    assert.ok(completed.versionId);
    assert.match(runner.input?.projectDir ?? "", /design\/nodes\/node-page\/\.pending\/jobs\/job-/);

    const canvas = await getDesignCanvas(dataDir, projectId);
    const page = canvas.nodes.find((node) => node.id === "node-page");
    assert.equal(page?.currentVersionId, completed.versionId);
    assert.equal(page?.state, "ready");
    const persisted = await getDesignJob(dataDir, projectId, completed.id);
    assert.equal(persisted.runnerId, "writing-fake");
    assert.equal(persisted.model, "runtime-fixture-model");
    assert.ok(persisted.activity.some((entry) => (
      entry.text === "Writing index.html" && entry.toolName === "write"
      && entry.toolCallId === "tool-write-index"
      && entry.toolInput === "{\"file_path\":\"index.html\"}"
      && entry.toolResult === "File written" && entry.toolResultError === false
      && entry.diff?.startsWith("--- /dev/null\n+++ b/index.html")
    )));
    assert.equal(persisted.activity.filter((entry) => entry.toolCallId === "tool-write-index").length, 1);
    const [version] = (await listDesignVersions(dataDir, projectId, "node-page"))
      .filter((candidate) => candidate.id === completed.versionId);
    assert.equal(version?.runnerId, persisted.runnerId);
    assert.equal(version?.model, persisted.model);
    const thread = await getDesignThread(dataDir, projectId, { type: "node", nodeId: "node-page" });
    assert.deepEqual(thread.messages.map((message) => message.role), ["user", "assistant"]);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("a live publication error after staging is recovered before the executor terminalizes the Job", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "dezin-design-node-live-publication-recovery-"));
  const projectId = "project-live-publication-recovery";
  const runner: AgentRunner = {
    id: "publication-recovery-fake",
    async runTurn(input) {
      const html = "<!doctype html><html><head><title>Recovered publication</title></head><body>Recover me</body></html>";
      await writeFile(join(input.projectDir, "index.html"), html);
      return { text: "generated", artifactHtml: html, artifactPath: "index.html" };
    },
  };
  try {
    await initializeDesignProject(dataDir, projectId);
    await mutateDesignCanvas(dataDir, projectId, {
      expectedRevision: 0,
      intents: [{ type: "add-node", node: { id: "node-page", kind: "page" } }],
    });
    const started = await startDesignNodeTurn({
      dataDir,
      projectId,
      nodeId: "node-page",
      message: "Generate with a recoverable live write failure",
      systemPrompt: "Write index.html",
      runner,
      publicationTestHooks: {
        simulateProcessCrash: true,
        afterPhase(phase) {
          if (phase === "pending") throw new Error("injected live publication failure");
        },
      },
    });

    const completed = await started.completion;
    assert.equal(completed.status, "ready");
    assert.ok(completed.versionId);
    assert.equal((await getDesignCanvas(dataDir, projectId)).nodes[0]?.currentVersionId, completed.versionId);
    assert.equal((await getDesignCanvas(dataDir, projectId)).nodes[0]?.name, "Recovered publication");
    assert.equal((await listDesignVersions(dataDir, projectId, "node-page")).length, 1);
    const thread = await getDesignThread(dataDir, projectId, { type: "node", nodeId: "node-page" });
    assert.equal(thread.messages.length, 2);
    assert.match(thread.messages[1]?.content ?? "", /Published version-/i);
    assert.doesNotMatch(thread.messages[1]?.content ?? "", /orchestration is queued/i);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("a live error during pending payload construction returns the recovered cancelled Job", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "dezin-design-node-live-partial-publication-"));
  const projectId = "project-live-partial-publication";
  const runner: AgentRunner = {
    id: "partial-publication-fake",
    async runTurn(input) {
      const html = "<!doctype html><html><head><title>Partial publication</title></head><body>Partial publish</body></html>";
      await writeFile(join(input.projectDir, "index.html"), html);
      return { text: "generated", artifactHtml: html, artifactPath: "index.html" };
    },
  };
  try {
    await initializeDesignProject(dataDir, projectId);
    await mutateDesignCanvas(dataDir, projectId, {
      expectedRevision: 0,
      intents: [{ type: "add-node", node: { id: "node-page", kind: "page" } }],
    });
    const started = await startDesignNodeTurn({
      dataDir,
      projectId,
      nodeId: "node-page",
      message: "Generate across a partial payload failure",
      systemPrompt: "Write index.html",
      runner,
      publicationTestHooks: {
        afterPendingIndex() {
          throw new Error("injected partial pending failure");
        },
      },
    });

    const completed = await started.completion;
    assert.equal(completed.status, "cancelled");
    assert.equal(completed.versionId, null);
    const canvas = await getDesignCanvas(dataDir, projectId);
    assert.equal(canvas.nodes[0]?.activeJobId, null);
    assert.equal(canvas.nodes[0]?.currentVersionId, null);
    assert.deepEqual(await listDesignVersions(dataDir, projectId, "node-page"), []);
    assert.deepEqual(
      await readdir(join(dataDir, "projects", projectId, "design", "transactions", "publications")),
      [],
    );
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("a live publication recovery failure preserves marker authority instead of marking the Job failed", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "dezin-design-node-live-publication-quarantine-"));
  const projectId = "project-live-publication-quarantine";
  const runner: AgentRunner = {
    id: "publication-quarantine-fake",
    async runTurn(input) {
      const html = "<!doctype html><html><head><title>Quarantined publication</title></head><body>Quarantine me</body></html>";
      await writeFile(join(input.projectDir, "index.html"), html);
      return { text: "generated", artifactHtml: html, artifactPath: "index.html" };
    },
  };
  try {
    await initializeDesignProject(dataDir, projectId);
    await mutateDesignCanvas(dataDir, projectId, {
      expectedRevision: 0,
      intents: [{ type: "add-node", node: { id: "node-page", kind: "page" } }],
    });
    const started = await startDesignNodeTurn({
      dataDir,
      projectId,
      nodeId: "node-page",
      message: "Generate with a corrupt durable target",
      systemPrompt: "Write index.html",
      runner,
      publicationTestHooks: {
        async afterPhase(phase) {
          if (phase !== "target") return;
          const versions = join(dataDir, "projects", projectId, "design", "nodes", "node-page", "versions");
          const [versionId] = await readdir(versions);
          assert.ok(versionId);
          await writeFile(join(versions, versionId, "index.html"), "tampered target");
          throw new Error("injected target corruption");
        },
      },
    });

    await assert.rejects(started.completion, /checksum|payload|publication/i);
    await assert.rejects(
      getDesignCanvas(dataDir, projectId),
      /publication recovery must complete/i,
    );
    const job = JSON.parse(await readFile(
      join(dataDir, "projects", projectId, "design", "jobs", `${started.job.id}.json`),
      "utf8",
    ));
    const project = JSON.parse(await readFile(
      join(dataDir, "projects", projectId, "design", "project.json"),
      "utf8",
    ));
    assert.equal(job.status, "validating");
    assert.equal(project.nodes[0]?.activeJobId, job.id);
    assert.equal(project.nodes[0]?.currentVersionId, null);
    assert.deepEqual(
      await readdir(join(dataDir, "projects", projectId, "design", "transactions", "publications")),
      [`${job.id}.json`],
    );
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("a repeated Node Agent idempotency key returns one durable Job without dispatching twice", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "dezin-design-node-idempotency-"));
  const projectId = "project-idempotency";
  let calls = 0;
  const runner: AgentRunner = {
    id: "counting-fake",
    async runTurn(input) {
      calls += 1;
      const html = "<!doctype html><html><head><title>Exactly once</title></head><body>Exactly once</body></html>";
      await writeFile(join(input.projectDir, "index.html"), html);
      return { text: "done", artifactHtml: html, artifactPath: "index.html" };
    },
  };
  try {
    await initializeDesignProject(dataDir, projectId);
    await mutateDesignCanvas(dataDir, projectId, {
      expectedRevision: 0,
      intents: [{ type: "add-node", node: { id: "node-page", kind: "page" } }],
    });
    const first = await startDesignNodeTurn({
      dataDir,
      projectId,
      nodeId: "node-page",
      message: "Generate once",
      systemPrompt: "Write index.html",
      runner,
      idempotencyKey: "turn-once",
    });
    const duplicate = await startDesignNodeTurn({
      dataDir,
      projectId,
      nodeId: "node-page",
      message: "Generate once",
      systemPrompt: "Write index.html",
      runner,
      idempotencyKey: "turn-once",
    });
    assert.equal(duplicate.reused, true);
    assert.equal(duplicate.job.id, first.job.id);
    await first.completion;
    assert.equal(calls, 1);
    const thread = await getDesignThread(dataDir, projectId, { type: "node", nodeId: "node-page" });
    assert.deepEqual(thread.messages.map((message) => message.role), ["user", "assistant"]);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("a Node Agent fails closed and records the observed model when runtime identity differs", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "dezin-design-node-identity-mismatch-"));
  const projectId = "project-identity-mismatch";
  const runner: AgentRunner = {
    id: "codebuddy",
    async runTurn() {
      throw new AgentExecutionIdentityError(
        "codebuddy reported a different runtime model",
        { providerId: "codebuddy", model: "hy3-ioa" },
        {
          providerId: "codebuddy",
          model: "claude-opus-4.8-1m",
          command: "codebuddy",
          cliVersion: null,
          apiKeySource: "copilot.tencent.com",
          protocol: "claude-stream-json-init-v1",
        },
      );
    },
  };
  try {
    await initializeDesignProject(dataDir, projectId);
    await mutateDesignCanvas(dataDir, projectId, {
      expectedRevision: 0,
      intents: [{ type: "add-node", node: { id: "node-page", kind: "page" } }],
    });
    const started = await startDesignNodeTurn({
      dataDir,
      projectId,
      nodeId: "node-page",
      message: "Generate with the requested model",
      systemPrompt: "Write index.html",
      runner,
      model: "hy3-ioa",
    });

    const completed = await started.completion;
    assert.equal(completed.status, "failed");
    assert.equal(completed.runnerId, "codebuddy");
    assert.equal(completed.model, "claude-opus-4.8-1m");
    assert.match(completed.error ?? "", /different runtime model/i);
    assert.deepEqual(await listDesignVersions(dataDir, projectId, "node-page"), []);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("a failed Node Agent records the runtime identity attested before a provider error", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "dezin-design-node-provider-error-"));
  const projectId = "project-provider-error";
  let calls = 0;
  const runner: AgentRunner = {
    id: "codebuddy",
    identityProtocol: "claude-stream-json-init-v1",
    async runTurn() {
      calls += 1;
      throw new AgentTurnError(
        "codebuddy returned an error result: authentication expired",
        {
          requested: { providerId: "codebuddy", model: null },
          observed: {
            providerId: "codebuddy",
            model: "hy3-ioa",
            command: "codebuddy",
            cliVersion: "2.132.0",
            apiKeySource: "copilot.tencent.com",
            protocol: "claude-stream-json-init-v1",
          },
        },
      );
    },
  };
  try {
    await initializeDesignProject(dataDir, projectId);
    await mutateDesignCanvas(dataDir, projectId, {
      expectedRevision: 0,
      intents: [{ type: "add-node", node: { id: "node-page", kind: "page" } }],
    });
    const started = await startDesignNodeTurn({
      dataDir,
      projectId,
      nodeId: "node-page",
      message: "Generate with the provider default model",
      systemPrompt: "Write index.html",
      runner,
    });

    const completed = await started.completion;
    assert.equal(completed.status, "failed");
    assert.equal(completed.runnerId, "codebuddy");
    assert.equal(completed.model, "hy3-ioa");
    assert.match(completed.error ?? "", /authentication expired/i);
    assert.equal(calls, 1, "provider/authentication failures must not be retried as artifact repair");
    assert.deepEqual(await listDesignVersions(dataDir, projectId, "node-page"), []);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("a failed Node Agent records the runtime identity attested before a nonzero CLI exit", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "dezin-design-node-cli-exit-"));
  const projectId = "project-cli-exit";
  const runner = new ClaudeCodeRunner({
    id: "codebuddy",
    command: "codebuddy",
    spawner: {
      run: async () => ({
        stdout: [
          JSON.stringify({
            type: "system",
            subtype: "init",
            model: "hy3-ioa",
            apiKeySource: "copilot.tencent.com",
            claude_code_version: "2.132.0",
          }),
          JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true }),
        ].join("\n"),
        stderr: "provider process crashed",
        exitCode: 1,
      }),
    },
  });
  try {
    await initializeDesignProject(dataDir, projectId);
    await mutateDesignCanvas(dataDir, projectId, {
      expectedRevision: 0,
      intents: [{ type: "add-node", node: { id: "node-page", kind: "page" } }],
    });
    const started = await startDesignNodeTurn({
      dataDir,
      projectId,
      nodeId: "node-page",
      message: "Generate with the provider default model",
      systemPrompt: "Write index.html",
      runner,
    });

    const completed = await started.completion;
    assert.equal(completed.status, "failed");
    assert.equal(completed.runnerId, "codebuddy");
    assert.equal(completed.model, "hy3-ioa");
    assert.match(completed.error ?? "", /exit code 1.*provider process crashed/i);
    assert.deepEqual(await listDesignVersions(dataDir, projectId, "node-page"), []);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("cancelling an active Node Agent aborts it and preserves the last good head", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "dezin-design-node-cancel-"));
  const projectId = "project-cancel";
  let releaseStarted!: () => void;
  const startedRunning = new Promise<void>((resolve) => { releaseStarted = resolve; });
  const runner: AgentRunner = {
    id: "blocking-fake",
    async runTurn(input) {
      releaseStarted();
      return new Promise<never>((_resolve, reject) => {
        const rejectAbort = () => reject(input.signal?.reason ?? new DOMException("cancelled", "AbortError"));
        input.signal?.addEventListener("abort", rejectAbort, { once: true });
        if (input.signal?.aborted) rejectAbort();
      });
    },
  };
  try {
    await initializeDesignProject(dataDir, projectId);
    await mutateDesignCanvas(dataDir, projectId, {
      expectedRevision: 0,
      intents: [{ type: "add-node", node: { id: "node-page", kind: "page" } }],
    });
    const previous = await publishDesignVersion(dataDir, projectId, {
      nodeId: "node-page",
      html: "<!doctype html><html><head></head><body>Last good</body></html>",
      contextHash: "a".repeat(64),
      canvasRevision: 1,
      expectedHeadVersionId: null,
      jobId: null,
      runnerId: "fixture",
      model: null,
    });
    const started = await startDesignNodeTurn({
      dataDir,
      projectId,
      nodeId: "node-page",
      message: "Replace this page",
      systemPrompt: "Write index.html",
      runner,
      model: "cancel-fixture-model",
    });
    await startedRunning;
    const cancelled = await cancelDesignNodeTurn(dataDir, projectId, started.job.id);
    assert.equal(cancelled.status, "cancelled");
    assert.equal(cancelled.runnerId, "blocking-fake");
    assert.equal(cancelled.model, "cancel-fixture-model");
    const completed = await started.completion;
    assert.equal(completed.status, "cancelled");
    assert.equal(completed.runnerId, cancelled.runnerId);
    assert.equal(completed.model, cancelled.model);
    const node = (await getDesignCanvas(dataDir, projectId)).nodes[0]!;
    assert.equal(node.currentVersionId, previous.manifest.id);
    assert.equal(node.selectedVersionId, previous.manifest.id);
    assert.equal(node.activeJobId, null);
    assert.equal(node.state, "cancelled");
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("a material Node Agent is analysis-only and cannot publish a Design version", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "dezin-design-material-agent-"));
  const projectId = "project-material-agent";
  const runner: AgentRunner = {
    id: "material-analysis-fake",
    async runTurn(input) {
      const context = JSON.parse(await readFile(join(input.projectDir, ".context", "canvas.json"), "utf8"));
      assert.equal(context.targetNodeId, "node-image");
      const placeholder = await readFile(join(input.projectDir, "index.html"), "utf8");
      return { text: "The image establishes a warm editorial direction.", artifactHtml: placeholder, artifactPath: "index.html" };
    },
  };
  try {
    await initializeDesignProject(dataDir, projectId);
    const bytes = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from("reference"),
    ]);
    const imported = await importDesignCanvasAssetBatch(dataDir, projectId, {
      expectedRevision: 0,
      items: [{
        asset: { name: "reference.png", mimeType: "image/png", base64: bytes.toString("base64") },
        binding: { type: "create-node", node: { id: "node-image", kind: "image" } },
      }],
    });
    const importedNode = imported.nodes[0]!;
    const started = await startDesignNodeTurn({
      dataDir,
      projectId,
      nodeId: "node-image",
      message: "What should the rest of the design learn from this?",
      systemPrompt: "Analyze only; do not generate design output.",
      runner,
      model: "analysis-fixture-model",
    });
    assert.equal(started.job.kind, "node-analysis");
    assert.equal(started.job.runnerId, "material-analysis-fake");
    assert.equal(started.job.model, "analysis-fixture-model");
    const completed = await started.completion;
    assert.equal(completed.status, "ready");
    assert.equal(completed.runnerId, started.job.runnerId);
    assert.equal(completed.model, started.job.model);
    const versions = await listDesignVersions(dataDir, projectId, "node-image");
    assert.equal(versions.length, 1);
    assert.equal(versions[0]?.contentKind, "asset");
    const node = (await getDesignCanvas(dataDir, projectId)).nodes[0]!;
    assert.equal(node.currentVersionId, importedNode.currentVersionId);
    assert.equal(node.versionCount, 1);
    assert.equal(node.state, "ready");
    const thread = await getDesignThread(dataDir, projectId, { type: "node", nodeId: "node-image" });
    assert.match(thread.messages.at(-1)?.content ?? "", /warm editorial/i);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("material Node analysis is single-flight, cancellable, and retains its Asset", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "dezin-design-material-single-flight-"));
  const projectId = "project-material-single-flight";
  let releaseStarted!: () => void;
  const runnerStarted = new Promise<void>((resolve) => { releaseStarted = resolve; });
  const runner: AgentRunner = {
    id: "blocking-analysis-fake",
    async runTurn(input) {
      releaseStarted();
      return new Promise<never>((_resolve, reject) => {
        const rejectAbort = () => reject(input.signal?.reason ?? new DOMException("cancelled", "AbortError"));
        input.signal?.addEventListener("abort", rejectAbort, { once: true });
        if (input.signal?.aborted) rejectAbort();
      });
    },
  };
  try {
    await initializeDesignProject(dataDir, projectId);
    const bytes = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from("single flight"),
    ]);
    const imported = await importDesignCanvasAssetBatch(dataDir, projectId, {
      expectedRevision: 0,
      items: [{
        asset: { name: "reference.png", mimeType: "image/png", base64: bytes.toString("base64") },
        binding: { type: "create-node", node: { id: "node-image", kind: "image" } },
      }],
    });
    const assetId = imported.nodes[0]!.assetId;
    const first = await startDesignNodeTurn({
      dataDir, projectId, nodeId: "node-image", message: "Analyze", systemPrompt: "Analyze only", runner,
    });
    await runnerStarted;
    await assert.rejects(startDesignNodeTurn({
      dataDir, projectId, nodeId: "node-image", message: "Analyze twice", systemPrompt: "Analyze only", runner,
    }), /active Job/i);
    assert.equal((await cancelDesignNodeTurn(dataDir, projectId, first.job.id)).status, "cancelled");
    assert.equal((await first.completion).status, "cancelled");
    const node = (await getDesignCanvas(dataDir, projectId)).nodes[0]!;
    assert.equal(node.assetId, assetId);
    assert.equal(node.activeJobId, null);
    assert.equal(node.state, "cancelled");
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("a Node Agent reserves a complete thread turn before creating a Job or taking ownership", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "dezin-design-thread-failure-"));
  const projectId = "project-thread-failure";
  let calls = 0;
  const runner: AgentRunner = {
    id: "must-not-run",
    async runTurn() {
      calls += 1;
      return { text: "unexpected", artifactHtml: "unexpected" };
    },
  };
  try {
    await initializeDesignProject(dataDir, projectId);
    await mutateDesignCanvas(dataDir, projectId, {
      expectedRevision: 0,
      intents: [{ type: "add-node", node: { id: "node-page", kind: "page" } }],
    });
    const thread = await getDesignThread(dataDir, projectId, { type: "node", nodeId: "node-page" });
    thread.messages = Array.from({ length: 1_999 }, (_, index) => ({
      id: `message-${index}`,
      role: "user" as const,
      content: "bounded",
      jobId: null,
      createdAt: index,
    }));
    await writeFile(
      join(dataDir, "projects", projectId, "design", "nodes", "node-page", "agent", "thread.json"),
      `${JSON.stringify(thread)}\n`,
    );
    const outcome = await startDesignNodeTurn({
      dataDir, projectId, nodeId: "node-page", message: "Cannot append", systemPrompt: "Generate", runner,
      model: "failed-fixture-model",
    }).then(async (started) => {
      await started.completion;
      return "started" as const;
    }, (error: unknown) => {
      assert.match(error instanceof Error ? error.message : String(error), /capacity for a complete turn/i);
      return "rejected" as const;
    });
    assert.equal(outcome, "rejected");
    assert.equal(calls, 0);
    const jobs = await listDesignJobs(dataDir, projectId);
    assert.deepEqual(jobs, []);
    const node = (await getDesignCanvas(dataDir, projectId)).nodes[0]!;
    assert.equal(node.activeJobId, null);
    assert.equal(node.state, "empty");
    assert.equal((await getDesignThread(dataDir, projectId, { type: "node", nodeId: "node-page" })).messages.length, 1_999);

    thread.messages.pop();
    await writeFile(
      join(dataDir, "projects", projectId, "design", "nodes", "node-page", "agent", "thread.json"),
      `${JSON.stringify(thread)}\n`,
    );
    const fitting = await startDesignNodeTurn({
      dataDir, projectId, nodeId: "node-page", message: "This complete turn fits", systemPrompt: "Generate", runner,
      model: "failed-fixture-model",
    });
    assert.equal((await fitting.completion).status, "failed");
    assert.equal(calls, 1);
    const completedThread = await getDesignThread(dataDir, projectId, { type: "node", nodeId: "node-page" });
    assert.equal(completedThread.messages.length, 2_000);
    assert.equal(completedThread.messages.at(-1)?.role, "assistant");
    assert.match(completedThread.messages.at(-1)?.content ?? "", /Generation failed/i);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
