import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { Store } from "../../../packages/core/src/index.ts";
import { FakeRunner, abortError } from "../../../packages/agent/src/index.ts";
import type { AgentRunner, AgentTurnInput } from "../../../packages/agent/src/index.ts";
import { createApp, createRuntimeSupervisor, type AppDeps } from "../src/index.ts";
import { removeStandardVariantWorktree, standardVersionArtifactDir, standardWorktreeDir } from "../src/variant-workspaces.ts";
import { standardRunBranchName, standardRunWorktreeDir } from "../src/standard-run-transaction.ts";

interface Ctx {
  base: string;
  dataDir: string;
  store: Store;
  runtimeSupervisor: ReturnType<typeof createRuntimeSupervisor>;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function withServer(
  fn: (ctx: Ctx) => Promise<void>,
  extraDeps: Partial<Omit<AppDeps, "store" | "dataDir">> = {},
): Promise<void> {
  const dataDir = mkdtempSync(join(tmpdir(), "dezin-variants-"));
  const store = new Store(":memory:");
  const runtimeSupervisor = extraDeps.runtimeSupervisor ?? createRuntimeSupervisor({ store, dataDir });
  const server = createApp({ store, dataDir, ...extraDeps, runtimeSupervisor });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  try {
    await fn({ base: `http://127.0.0.1:${port}`, dataDir, store, runtimeSupervisor });
  } finally {
    await runtimeSupervisor.shutdown();
    await new Promise<void>((r) => server.close(() => r()));
    store.close();
  }
}

test("variant deletion rejects same-variant activation without disturbing project-scoped work", async () => {
  await withServer(async ({ base, dataDir, store, runtimeSupervisor }) => {
    const project = store.createProject({ name: "Prototype deletion race" });
    const main = store.ensureMainVariant(project.id);
    const target = store.createVariant(project.id, "Target");
    store.setActiveVariant(project.id, main.id);

    const root = join(dataDir, "projects", project.id);
    const targetSnapshot = join(root, ".variants", target.id);
    mkdirSync(targetSnapshot, { recursive: true });
    writeFileSync(join(root, "index.html"), "<main>Main stays active</main>");
    writeFileSync(join(targetSnapshot, "index.html"), "<main>Deleted target</main>");

    const projectGate = deferred();
    const targetGate = deferred();
    const targetAborted = deferred();
    let projectOperationAborted = false;
    const projectOperation = runtimeSupervisor.trackOperation({ projectId: project.id }, async (signal) => {
      signal.addEventListener("abort", () => {
        projectOperationAborted = true;
      }, { once: true });
      await projectGate.promise;
    });
    const targetOperation = runtimeSupervisor.trackOperation(
      { projectId: project.id, variantId: target.id },
      async (signal) => {
        signal.addEventListener("abort", targetAborted.resolve, { once: true });
        await targetGate.promise;
      },
    );

    const deleting = fetch(`${base}/api/projects/${project.id}/variants/${target.id}`, { method: "DELETE" });
    await targetAborted.promise;

    const activation = await fetch(`${base}/api/projects/${project.id}/variants/${target.id}/activate`, { method: "POST" });
    const rootAfterActivation = readFileSync(join(root, "index.html"), "utf8");
    const activeAfterActivation = store.getActiveVariantId(project.id);

    targetGate.resolve();
    projectGate.resolve();
    const deleted = await deleting;
    await Promise.all([targetOperation, projectOperation]);

    assert.equal(activation.status, 409, "the deleting variant rejects new mutation admission");
    assert.match(rootAfterActivation, /Main stays active/, "activation never restores the deleting snapshot");
    assert.equal(activeAfterActivation, main.id, "activation never flips active variant state");
    assert.equal(projectOperationAborted, false, "variant deletion leaves project-scoped work alone");
    assert.equal(deleted.status, 200);
    assert.equal(store.getVariant(target.id), null);
  });
});

test("variant deletion rolls back an in-flight Prototype activation", async () => {
  const restored = deferred();
  await withServer(
    async ({ base, dataDir, store }) => {
      const project = store.createProject({ name: "Prototype activation rollback", mode: "prototype" });
      const main = store.ensureMainVariant(project.id);
      const target = store.createVariant(project.id, "Target");
      store.setActiveVariant(project.id, main.id);

      const root = join(dataDir, "projects", project.id);
      const targetSnapshot = join(root, ".variants", target.id);
      mkdirSync(targetSnapshot, { recursive: true });
      writeFileSync(join(root, "index.html"), "<main>Main remains active</main>");
      writeFileSync(join(targetSnapshot, "index.html"), "<main>Target is being deleted</main>");

      const activation = fetch(`${base}/api/projects/${project.id}/variants/${target.id}/activate`, { method: "POST" });
      await restored.promise;
      const deletion = fetch(`${base}/api/projects/${project.id}/variants/${target.id}`, { method: "DELETE" });
      const [activated, deleted] = await Promise.all([activation, deletion]);

      assert.equal(activated.status, 409, "cancellation is reported as a scope conflict");
      assert.equal(deleted.status, 200);
      assert.equal(store.getActiveVariantId(project.id), main.id);
      assert.match(readFileSync(join(root, "index.html"), "utf8"), /Main remains active/);
      assert.equal(store.getVariant(target.id), null);
      assert.equal(existsSync(join(root, ".variants", main.id)), false, "rollback does not leave a stale active snapshot");
    },
    {
      prototypeVariantRestored: async (_projectId, _variantId, signal) => {
        restored.resolve();
        if (signal?.aborted) return;
        await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));
      },
    },
  );
});

test("variant deletion aborts a partial-body mutation without deadlocking", async () => {
  await withServer(async ({ base, store }) => {
    const project = store.createProject({ name: "Partial variant mutation" });
    const main = store.ensureMainVariant(project.id);
    const target = store.createVariant(project.id, "Target");
    store.setActiveVariant(project.id, main.id);

    let renameRequest!: ReturnType<typeof request>;
    const renameOutcome = new Promise<"aborted" | "responded">((resolve) => {
      renameRequest = request(
        `${base}/api/projects/${project.id}/variants/${target.id}`,
        {
          method: "PATCH",
          headers: {
            "content-type": "application/json",
            "content-length": "128",
          },
        },
        (response) => {
          response.resume();
          response.once("end", () => resolve("responded"));
        },
      );
      renameRequest.once("error", () => resolve("aborted"));
      renameRequest.write('{"name":"still arriving');
    });

    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    const deletion = await Promise.race([
      fetch(`${base}/api/projects/${project.id}/variants/${target.id}`, { method: "DELETE" }),
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 500)),
    ]);
    const outcome = await Promise.race([
      renameOutcome,
      new Promise<"still-open">((resolve) => setTimeout(() => resolve("still-open"), 100)),
    ]);
    if (outcome === "still-open") renameRequest.destroy();

    assert.notEqual(deletion, "timeout", "variant deletion must not deadlock on an incomplete body");
    assert.equal((deletion as Response).status, 200);
    assert.equal(outcome, "aborted", "deletion aborts the exact-scope body reader");
    assert.equal(store.getVariant(target.id), null);
  });
});

function commitAll(dir: string, message = "base"): void {
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["-c", "user.name=Dezin", "-c", "user.email=dezin@local", "commit", "-q", "-m", message], {
    cwd: dir,
  });
}

function initStandardProject(dataDir: string, projectId: string): string {
  const dir = join(dataDir, "projects", projectId);
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "index.html"), "<main>Root main</main>");
  writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { dev: "vite" } }));
  writeFileSync(join(dir, "src", "App.jsx"), "export default function App(){ return <main>Root</main> }");
  execFileSync("git", ["init", "-q"], { cwd: dir });
  commitAll(dir);
  return dir;
}

test("single Standard variant deletion waits for its failed creation cleanup", async () => {
  const created = deferred();
  const rollbackStarted = deferred();
  const allowRollback = deferred();
  await withServer(
    async ({ base, dataDir, store }) => {
      const project = store.createProject({ name: "Single create cleanup", mode: "standard" });
      initStandardProject(dataDir, project.id);
      const main = store.ensureMainVariant(project.id);

      const creating = fetch(`${base}/api/projects/${project.id}/variants`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Delete while creating" }),
      });
      await created.promise;
      const target = store.listVariants(project.id).find((variant) => variant.id !== main.id)!;
      const worktree = standardWorktreeDir(dataDir, project.id, target.id);
      assert.ok(existsSync(worktree));

      const deleting = fetch(`${base}/api/projects/${project.id}/variants/${target.id}`, { method: "DELETE" });
      await rollbackStarted.promise;
      const deletionWhileRollbackBlocked = await Promise.race([
        deleting.then(() => "resolved" as const),
        new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 50)),
      ]);
      allowRollback.resolve();
      const [createResponse, deleteResponse] = await Promise.all([creating, deleting]);

      assert.equal(deletionWhileRollbackBlocked, "pending", "DELETE cannot outrun Git worktree cleanup");
      assert.equal(createResponse.status, 409);
      assert.equal(deleteResponse.status, 200);
      assert.equal(store.getVariant(target.id), null);
      assert.equal(existsSync(worktree), false);
    },
    {
      variantMutationCheckpoint: async (_projectId, _variantId, phase, signal) => {
        if (phase === "created") {
          created.resolve();
          if (!signal?.aborted) await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));
          return;
        }
        rollbackStarted.resolve();
        await allowRollback.promise;
      },
    },
  );
});

test("targeted deletion of blocked fan-out B preserves completed sibling A and waits for B rollback", async () => {
  const secondCreated = deferred();
  const secondRollbackStarted = deferred();
  const allowSecondRollback = deferred();
  let createdCount = 0;
  let blockedVariantId = "";
  await withServer(
    async ({ base, dataDir, store }) => {
      const project = store.createProject({ name: "Fan-out target cleanup", mode: "standard" });
      initStandardProject(dataDir, project.id);
      const main = store.ensureMainVariant(project.id);

      const fanningOut = fetch(`${base}/api/projects/${project.id}/variants/fanout`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ count: 2 }),
      });
      await secondCreated.promise;
      const siblings = store.listVariants(project.id).filter((variant) => variant.id !== main.id);
      const siblingA = siblings.find((variant) => variant.id !== blockedVariantId)!;
      const siblingB = siblings.find((variant) => variant.id === blockedVariantId)!;
      const worktreeA = standardWorktreeDir(dataDir, project.id, siblingA.id);
      const worktreeB = standardWorktreeDir(dataDir, project.id, siblingB.id);
      assert.ok(existsSync(worktreeA));
      assert.ok(existsSync(worktreeB));

      const deletingB = fetch(`${base}/api/projects/${project.id}/variants/${siblingB.id}`, { method: "DELETE" });
      await secondRollbackStarted.promise;
      const deletionWhileRollbackBlocked = await Promise.race([
        deletingB.then(() => "resolved" as const),
        new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 50)),
      ]);
      allowSecondRollback.resolve();
      const [fanoutResponse, deleteResponse] = await Promise.all([fanningOut, deletingB]);

      assert.equal(deletionWhileRollbackBlocked, "pending", "DELETE(B) waits for B rollback cleanup");
      assert.equal(fanoutResponse.status, 409);
      assert.equal(deleteResponse.status, 200);
      assert.ok(store.getVariant(siblingA.id), "completed sibling A row remains");
      assert.ok(existsSync(worktreeA), "completed sibling A worktree remains");
      assert.equal(store.getVariant(siblingB.id), null);
      assert.equal(existsSync(worktreeB), false);
    },
    {
      variantMutationCheckpoint: async (_projectId, variantId, phase, signal) => {
        if (phase === "created") {
          createdCount += 1;
          if (createdCount !== 2) return;
          blockedVariantId = variantId;
          secondCreated.resolve();
          if (!signal?.aborted) await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));
          return;
        }
        if (variantId !== blockedVariantId) return;
        secondRollbackStarted.resolve();
        await allowSecondRollback.promise;
      },
    },
  );
});

test("variant deletion unregisters a real Git version worktree before removing its directory", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "dezin-version-worktree-delete-"));
  const store = new Store(":memory:");
  const project = store.createProject({ name: "Git cleanup", mode: "standard" });
  const root = initStandardProject(dataDir, project.id);
  const variant = store.createVariant(project.id, "Branch");
  const conversation = store.createConversation(project.id);
  const run = store.createRun(project.id, conversation.id, variant.id);
  const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  const previewStopEntered = deferred();
  const allowPreviewStop = deferred();
  const previewLeaseManager: NonNullable<AppDeps["previewLeaseManager"]> = {
    acquire: async () => { throw new Error("not used"); },
    renew: async () => null,
    release: async () => false,
    stopScope: async (scope) => {
      if (scope.projectId === project.id && scope.runId === run.id) {
        previewStopEntered.resolve();
        await allowPreviewStop.promise;
      }
    },
    stopAll: async () => {},
    activeCount: () => 0,
  };
  const supervisor = createRuntimeSupervisor({ store, dataDir, previewLeaseManager });
  const deps = { store, dataDir, runtimeSupervisor: supervisor, previewLeaseManager } as AppDeps;

  const versionDir = await standardVersionArtifactDir(deps, project.id, run.id, commit);
  const before = execFileSync("git", ["worktree", "list", "--porcelain"], { cwd: root, encoding: "utf8" });
  assert.match(before, new RegExp(versionDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

  const releasing = supervisor.releaseVariant(project.id, variant.id);
  await previewStopEntered.promise;
  assert.equal(existsSync(versionDir), true, "version worktree remains until its preview teardown settles");
  allowPreviewStop.resolve();
  await releasing;

  const after = execFileSync("git", ["worktree", "list", "--porcelain"], { cwd: root, encoding: "utf8" });
  assert.doesNotMatch(after, new RegExp(versionDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.equal(existsSync(versionDir), false);
  await supervisor.shutdown();
  store.close();
});

test("Standard variant cleanup prunes stale worktree metadata and retries branch deletion", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "dezin-stale-variant-worktree-delete-"));
  const store = new Store(":memory:");
  const project = store.createProject({ name: "Stale Git cleanup", mode: "standard" });
  const root = initStandardProject(dataDir, project.id);
  const variant = store.createVariant(project.id, "Branch");
  const worktree = standardWorktreeDir(dataDir, project.id, variant.id);
  const branch = `dezin/variant/${variant.id}`;
  execFileSync("git", ["worktree", "add", "-b", branch, worktree, "HEAD"], { cwd: root });
  rmSync(worktree, { recursive: true, force: true });

  assert.match(execFileSync("git", ["branch", "--list", branch], { cwd: root, encoding: "utf8" }), /dezin\/variant\//);
  await removeStandardVariantWorktree({ store, dataDir } as AppDeps, project.id, variant.id);

  assert.equal(execFileSync("git", ["branch", "--list", branch], { cwd: root, encoding: "utf8" }).trim(), "");
  assert.doesNotMatch(execFileSync("git", ["worktree", "list", "--porcelain"], { cwd: root, encoding: "utf8" }), new RegExp(worktree));
  store.close();
});

async function createVariant(base: string, projectId: string): Promise<{ id: string; active?: boolean }> {
  const res = await fetch(`${base}/api/projects/${projectId}/variants`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Exploration" }),
  });
  assert.equal(res.status, 200);
  const variants = (await res.json()) as Array<{ id: string; name: string; active?: boolean }>;
  const active = variants.find((v) => v.active);
  assert.equal(active?.name, "Exploration");
  return active!;
}

function parseSse(text: string): Array<Record<string, unknown>> {
  return text
    .split("\n\n")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((b) => JSON.parse(b.replace(/^data:\s?/, "")) as Record<string, unknown>);
}

async function runProject(base: string, body: Record<string, unknown>): Promise<Array<Record<string, unknown>>> {
  const res = await fetch(`${base}/api/runs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  assert.equal(res.status, 200);
  return parseSse(await res.text());
}

async function forkMessage(base: string, projectId: string, messageId: string, name = "Forked here"): Promise<{ conversationId: string; variantId: string }> {
  const res = await fetch(`${base}/api/projects/${projectId}/messages/${messageId}/fork`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name }),
  });
  assert.equal(res.status, 200);
  return (await res.json()) as { conversationId: string; variantId: string };
}

async function assertPrototypeMessageForkDeletionRace(
  checkpointPhase: "before-root-overwrite" | "after-root-overwrite",
): Promise<void> {
  const firstHtml = "<main><h1>First snapshot</h1><p>Fork target.</p></main>";
  const secondHtml = "<main><h1>Current snapshot</h1><p>Must survive cancellation.</p></main>";
  const checkpointReached = deferred();
  const rollbackReached = deferred();
  const allowRollback = deferred();
  const runner = new FakeRunner({ artifacts: [firstHtml, secondHtml], texts: ["first answer", "second answer"] });

  await withServer(
    async ({ base, dataDir, store }) => {
      const project = store.createProject({ name: `Prototype fork ${checkpointPhase}` });
      const main = store.ensureMainVariant(project.id);
      const firstEvents = await runProject(base, { projectId: project.id, brief: "first" });
      const conversationId = firstEvents.find((event) => event.type === "run-start")!.conversationId as string;
      await runProject(base, { projectId: project.id, conversationId, brief: "second" });
      const firstAssistant = store.listMessages(conversationId).filter((message) => message.role === "assistant")[0]!;

      const forkResponsePromise = fetch(`${base}/api/projects/${project.id}/messages/${firstAssistant.id}/fork`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Delete racing fork" }),
      });
      await checkpointReached.promise;
      const target = store.listVariants(project.id).find((variant) => variant.id !== main.id)!;
      assert.ok(target, "fork row is externally visible while the exact-scope operation owns it");

      const deleteResponsePromise = fetch(`${base}/api/projects/${project.id}/variants/${target.id}`, { method: "DELETE" });
      let deletionWhileRollbackBlocked: "pending" | "resolved" = "pending";
      if (checkpointPhase === "after-root-overwrite") {
        await rollbackReached.promise;
        deletionWhileRollbackBlocked = await Promise.race([
          deleteResponsePromise.then(() => "resolved" as const),
          new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 50)),
        ]);
        allowRollback.resolve();
      }
      const [forkResponse, deleteResponse] = await Promise.all([forkResponsePromise, deleteResponsePromise]);

      assert.equal(deletionWhileRollbackBlocked, "pending", "DELETE waits for exact-scope root rollback");
      assert.equal(forkResponse.status, 409, "the cancelled fork reports an ownership conflict");
      assert.equal(deleteResponse.status, 200, "target deletion finishes after fork rollback");
      assert.equal(store.getActiveVariantId(project.id), main.id, "the previous variant remains active");
      assert.equal(store.getVariant(target.id), null);
      assert.match(
        readFileSync(join(dataDir, "projects", project.id, "index.html"), "utf8"),
        /Current snapshot/,
        "root content is restored even when deletion aborts after the fork overwrite",
      );
      assert.equal(
        existsSync(join(dataDir, "projects", project.id, ".variants", main.id)),
        false,
        "rollback consumes the temporary active snapshot",
      );
    },
    {
      runner,
      visualQa: async () => [],
      prototypeMessageForkCheckpoint: async (_projectId, _variantId, phase, signal) => {
        if (phase === "before-rollback" && checkpointPhase === "after-root-overwrite") {
          rollbackReached.resolve();
          await allowRollback.promise;
          return;
        }
        if (phase !== checkpointPhase) return;
        checkpointReached.resolve();
        if (signal?.aborted) return;
        await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));
      },
    },
  );
}

test("Prototype message fork leaves root unchanged when deletion wins before overwrite", async () => {
  await assertPrototypeMessageForkDeletionRace("before-root-overwrite");
});

test("Prototype message fork restores root when target deletion aborts after overwrite", async () => {
  await assertPrototypeMessageForkDeletionRace("after-root-overwrite");
});

test("prototype branch can fork from a specific assistant message snapshot", async () => {
  const firstHtml = "<main><h1>First snapshot</h1><p>Keep this version.</p></main>";
  const secondHtml = "<main><h1>Second snapshot</h1><p>Do not fork this one.</p></main>";
  const runner = new FakeRunner({ artifacts: [firstHtml, secondHtml], texts: ["first answer", "second answer"] });

  await withServer(
    async ({ base, store }) => {
      const project = store.createProject({ name: "Proto" });
      const firstEvents = await runProject(base, { projectId: project.id, brief: "first" });
      const conversationId = firstEvents.find((e) => e.type === "run-start")!.conversationId as string;
      await runProject(base, { projectId: project.id, conversationId, brief: "second" });

      const firstAssistant = store.listMessages(conversationId).filter((m) => m.role === "assistant")[0]!;
      const fork = await forkMessage(base, project.id, firstAssistant.id, "Fork first");

      const active = store.listVariants(project.id).find((v) => v.active);
      assert.equal(active?.id, fork.variantId);
      const preview = await fetch(`${base}/projects/${project.id}/preview/`);
      assert.match(await preview.text(), /First snapshot/);

      const forkedTranscript = store.listMessages(fork.conversationId).map((m) => m.content);
      assert.ok(forkedTranscript.includes("first answer"));
      assert.ok(!forkedTranscript.includes("second"));
    },
    { runner, visualQa: async () => [] },
  );
});

test("standard branch can fork from a specific assistant message commit", async () => {
  const seen: AgentTurnInput[] = [];
  const runner: AgentRunner = {
    id: "standard-message-fork",
    async runTurn(input) {
      seen.push(input);
      const label = seen.length === 1 ? "first standard state" : "second standard state";
      writeFileSync(join(input.projectDir, "src", "state.txt"), label);
      return { text: `${label} answer`, artifactHtml: "", artifactPath: "index.html" };
    },
  };

  await withServer(
    async ({ base, dataDir, store }) => {
      const project = store.createProject({ name: "Std", mode: "standard" });
      initStandardProject(dataDir, project.id);
      const main = store.ensureMainVariant(project.id);

      const firstEvents = await runProject(base, { projectId: project.id, variantId: main.id, brief: "first" });
      assert.ok(firstEvents.some((event) => event.type === "run-done"), JSON.stringify(firstEvents));
      const conversationId = firstEvents.find((e) => e.type === "run-start")!.conversationId as string;
      const secondEvents = await runProject(base, { projectId: project.id, conversationId, variantId: main.id, brief: "second" });
      assert.ok(secondEvents.some((event) => event.type === "run-done"), JSON.stringify(secondEvents));

      const firstAssistant = store.listMessages(conversationId).filter((m) => m.role === "assistant")[0]!;
      const fork = await forkMessage(base, project.id, firstAssistant.id, "Fork first standard");
      const worktree = join(dataDir, "worktrees", project.id, fork.variantId);

      assert.equal(readFileSync(join(worktree, "src", "state.txt"), "utf8"), "first standard state");
      assert.equal(store.listVariants(project.id).find((v) => v.active)?.id, fork.variantId);
      assert.notEqual(fork.variantId, main.id);
    },
    {
      runner,
      visualQa: async () => [],
      ensureDevServer: async () => ({ url: "http://127.0.0.1:6210/" }),
      captureCoverUrl: async () => true,
    },
  );
});

test("standard variants use git worktrees for preview, files, and targeted runs", async () => {
  let runnerDir = "";
  const runner: AgentRunner = {
    id: "standard-worktree",
    async runTurn(input) {
      runnerDir = input.projectDir;
      writeFileSync(join(input.projectDir, "src", "run-marker.txt"), "wrote in variant worktree");
      return { text: "changed", artifactHtml: "", artifactPath: "index.html" };
    },
  };

  await withServer(
    async ({ base, dataDir, store }) => {
      const project = store.createProject({ name: "Std", mode: "standard" });
      const root = initStandardProject(dataDir, project.id);
      const main = store.ensureMainVariant(project.id);

      const variant = await createVariant(base, project.id);
      const worktree = join(dataDir, "worktrees", project.id, variant.id);
      assert.ok(existsSync(join(worktree, ".git")), "variant worktree exists");
      assert.ok(!existsSync(join(root, ".variants", main.id)), "standard mode does not snapshot into .variants");

      writeFileSync(join(worktree, "index.html"), "<main>Worktree active</main>");
      writeFileSync(join(worktree, "src", "variant-only.txt"), "only in the active variant");
      commitAll(worktree, "variant state before run");

      const activePreview = await fetch(`${base}/projects/${project.id}/preview/`);
      assert.equal(activePreview.status, 200);
      assert.match(await activePreview.text(), /Worktree active/);

      const files = (await (await fetch(`${base}/api/projects/${project.id}/files`)).json()) as Array<{ path: string }>;
      assert.ok(files.some((f) => f.path === "src/variant-only.txt"), "Files lists the active variant worktree");

      const mainActivate = await fetch(`${base}/api/projects/${project.id}/variants/${main.id}/activate`, { method: "POST" });
      assert.equal(mainActivate.status, 200);
      const mainPreview = await fetch(`${base}/projects/${project.id}/preview/`);
      assert.match(await mainPreview.text(), /Root main/);

      const variantPreview = await fetch(`${base}/api/projects/${project.id}/variants/${variant.id}/preview/`);
      assert.equal(variantPreview.status, 200);
      assert.match(await variantPreview.text(), /Worktree active/);

      const runRes = await fetch(`${base}/api/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId: project.id, variantId: variant.id, brief: "make it better" }),
      });
      assert.equal(runRes.status, 200);
      const runEvents = parseSse(await runRes.text());
      const done = runEvents.find((e) => e.type === "run-done");
      assert.ok(done, JSON.stringify(runEvents));
      assert.equal(store.getRun(done.runId as string)?.variantId, variant.id);
      assert.equal(runnerDir, standardRunWorktreeDir(dataDir, project.id, done.runId as string));
      assert.notEqual(runnerDir, worktree);
      assert.equal(readFileSync(join(worktree, "src", "run-marker.txt"), "utf8"), "wrote in variant worktree");
      assert.equal(existsSync(join(root, "src", "run-marker.txt")), false, "standard variant run did not write root");
      assert.equal(existsSync(runnerDir), false, "successful Run disposes its temporary worktree");
      assert.equal(execFileSync("git", ["branch", "--list", standardRunBranchName(done.runId as string)], { cwd: root, encoding: "utf8" }).trim(), "");

      const stillMainPreview = await fetch(`${base}/projects/${project.id}/preview/`);
      assert.match(await stillMainPreview.text(), /Root main/, "targeted run does not switch the active variant");
    },
    {
      runner,
      visualQa: async () => [],
      ensureDevServer: async () => ({ url: "http://127.0.0.1:6211/" }),
      captureCoverUrl: async () => true,
    },
  );
});

test("targeted variant deletion aborts its Run and removes only variant-owned resources", async () => {
  let entered!: () => void;
  const runEntered = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let abortObserved = false;
  let runWorktree = "";
  const runner: AgentRunner = {
    id: "blocked-variant-delete",
    async runTurn(input) {
      runWorktree = input.projectDir;
      entered();
      return await new Promise((resolve, reject) => {
        const fallback = setTimeout(() => reject(new Error("blocked runner test fallback")), 500);
        input.signal?.addEventListener("abort", () => {
          abortObserved = true;
          clearTimeout(fallback);
          setTimeout(() => {
            if (existsSync(input.projectDir)) writeFileSync(join(input.projectDir, "post-abort.txt"), "late write");
          }, 5);
          setTimeout(() => reject(abortError()), 15);
        }, { once: true });
      });
    },
  };

  await withServer(
    async ({ base, dataDir, store }) => {
      const project = store.createProject({ name: "Std", mode: "standard" });
      const root = initStandardProject(dataDir, project.id);
      const main = store.ensureMainVariant(project.id);
      const target = await createVariant(base, project.id);
      const worktree = join(dataDir, "worktrees", project.id, target.id);
      assert.ok(existsSync(worktree));
      const activated = await fetch(`${base}/api/projects/${project.id}/variants/${main.id}/activate`, { method: "POST" });
      assert.equal(activated.status, 200);

      const runResponsePromise = fetch(`${base}/api/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId: project.id, variantId: target.id, brief: "stay blocked" }),
      });
      await runEntered;
      const run = store.listRuns(project.id).find((candidate) => candidate.variantId === target.id)!;
      assert.equal(runWorktree, standardRunWorktreeDir(dataDir, project.id, run.id));
      assert.ok(existsSync(runWorktree), "the transaction worktree exists while the Run is active");
      const ownedPaths = [
        join(dataDir, ".runs", `${run.id}.jsonl`),
        join(dataDir, ".runs", run.id, "bundle.txt"),
        worktree,
        join(dataDir, "version-worktrees", project.id, run.id, "artifact.txt"),
      ];
      for (const path of [ownedPaths[1]!, ownedPaths[3]!]) {
        mkdirSync(join(path, ".."), { recursive: true });
        writeFileSync(path, "owned");
      }

      const deleted = await fetch(`${base}/api/projects/${project.id}/variants/${target.id}`, { method: "DELETE" });
      const runResponse = await runResponsePromise;
      await runResponse.text();
      await new Promise((resolve) => setTimeout(resolve, 25));

      assert.equal(deleted.status, 200);
      assert.equal(abortObserved, true, "the targeted Run observes abort before DELETE resolves");
      assert.equal(store.getVariant(target.id), null);
      assert.equal(store.getRun(run.id), null);
      assert.ok(ownedPaths.every((path) => !existsSync(path)), "target Run logs and worktrees stay absent");
      assert.ok(store.getProject(project.id));
      assert.ok(store.getVariant(main.id));
      assert.ok(existsSync(root), "the project root remains");
      assert.equal(existsSync(join(worktree, "post-abort.txt")), false, "no write lands after deletion");
      assert.equal(existsSync(runWorktree), false, "variant deletion awaits transaction disposal");
      assert.equal(execFileSync("git", ["branch", "--list", standardRunBranchName(run.id)], { cwd: root, encoding: "utf8" }).trim(), "");
    },
    { runner, visualQa: async () => [] },
  );
});

test("devserver release endpoint targets the active standard variant runtime", async () => {
  const released: string[] = [];
  const releaseEntered = deferred();
  const allowRelease = deferred();
  await withServer(
    async ({ base, store }) => {
      const project = store.createProject({ name: "Std", mode: "standard" });
      store.ensureMainVariant(project.id);
      const branch = store.createVariant(project.id, "Exploration");
      store.setActiveVariant(project.id, branch.id);

      let responseSettled = false;
      const response = fetch(`${base}/api/projects/${project.id}/devserver`, { method: "DELETE" }).then((res) => {
        responseSettled = true;
        return res;
      });
      await releaseEntered.promise;
      await Promise.resolve();
      assert.equal(responseSettled, false, "DELETE waits for preview teardown");
      allowRelease.resolve();
      const res = await response;
      assert.equal(res.status, 200);
      assert.equal(((await res.json()) as { released: boolean }).released, true);
      assert.deepEqual(released, [`${project.id}:${branch.id}`]);
    },
    {
      releaseDevServer: async (runtimeKey) => {
        released.push(runtimeKey);
        releaseEntered.resolve();
        await allowRelease.promise;
        return true;
      },
    },
  );
});

test("standard cover capture endpoint backfills a missing project cover", async () => {
  let captured: { url: string; outPath: string } | null = null;
  const released: string[] = [];
  await withServer(
    async ({ base, dataDir, store }) => {
      const project = store.createProject({ name: "Std", mode: "standard" });
      const active = store.ensureMainVariant(project.id).id;
      const root = join(dataDir, "projects", project.id);
      mkdirSync(root, { recursive: true });

      const res = await fetch(`${base}/api/projects/${project.id}/cover/capture?release=1`, { method: "POST" });
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { captured: true });
      assert.deepEqual(captured, {
        url: "http://127.0.0.1:6001/",
        outPath: join(root, ".cover.png"),
      });
      assert.deepEqual(released, [`${project.id}:${active}`]);
    },
    {
      ensureDevServer: async () => ({ url: "http://127.0.0.1:6001/" }),
      captureCoverUrl: async (url, outPath) => {
        captured = { url, outPath };
        return true;
      },
      releaseDevServer: async (runtimeKey) => {
        released.push(runtimeKey);
        return true;
      },
    },
  );
});

test("standard cover capture releases its preview lease when capture throws", async () => {
  let releases = 0;
  await withServer(
    async ({ base, dataDir, store }) => {
      const project = store.createProject({ name: "Std", mode: "standard" });
      store.ensureMainVariant(project.id);
      mkdirSync(join(dataDir, "projects", project.id), { recursive: true });

      const res = await fetch(`${base}/api/projects/${project.id}/cover/capture`, { method: "POST" });
      assert.equal(res.status, 409);
      assert.equal(releases, 1);
    },
    {
      ensureDevServer: async () => ({
        url: "http://127.0.0.1:6002/",
        leaseId: "cover-lease",
        expiresAt: Date.now() + 60_000,
        release: async () => { releases += 1; },
      }),
      captureCoverUrl: async () => { throw new Error("capture failed"); },
    },
  );
});

test("standard cover capture endpoint skips projects that already have a cover", async () => {
  let captureCalls = 0;
  await withServer(
    async ({ base, dataDir, store }) => {
      const project = store.createProject({ name: "Std", mode: "standard" });
      const root = join(dataDir, "projects", project.id);
      mkdirSync(root, { recursive: true });
      writeFileSync(join(root, ".cover.png"), "png");

      const res = await fetch(`${base}/api/projects/${project.id}/cover/capture`, { method: "POST" });
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { captured: false, reason: "exists" });
      assert.equal(captureCalls, 0);
    },
    {
      captureCoverUrl: async () => {
        captureCalls++;
        return true;
      },
    },
  );
});

test("prototype variants keep root snapshot switching behavior", async () => {
  await withServer(async ({ base, dataDir, store }) => {
    const project = store.createProject({ name: "Proto" });
    const root = join(dataDir, "projects", project.id);
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "index.html"), "<main>Main prototype</main>");

    const main = store.ensureMainVariant(project.id);
    const variant = await createVariant(base, project.id);
    writeFileSync(join(root, "index.html"), "<main>Variant prototype</main>");

    const activateMain = await fetch(`${base}/api/projects/${project.id}/variants/${main.id}/activate`, { method: "POST" });
    assert.equal(activateMain.status, 200);

    const activePreview = await fetch(`${base}/projects/${project.id}/preview/`);
    assert.match(await activePreview.text(), /Main prototype/);

    const inactivePreview = await fetch(`${base}/api/projects/${project.id}/variants/${variant.id}/preview/`);
    assert.equal(inactivePreview.status, 200);
    assert.match(await inactivePreview.text(), /Variant prototype/);
    assert.ok(existsSync(join(root, ".variants", variant.id, "index.html")), "prototype keeps inactive snapshots");
  });
});

test("variant fan-out forks N seeded variations without stealing the active variant", async () => {
  await withServer(async ({ base, dataDir, store }) => {
    const project = store.createProject({ name: "Fanout" }); // prototype by default
    const dir = join(dataDir, "projects", project.id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "index.html"), "<main>base design here</main>");
    const main = store.ensureMainVariant(project.id);

    const res = await fetch(`${base}/api/projects/${project.id}/variants/fanout`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ count: 3 }),
    });
    assert.equal(res.status, 200);
    const out = (await res.json()) as { created: string[]; plan: { count: number }; variants: Array<{ id: string; name: string }> };
    assert.equal(out.plan.count, 3);
    assert.equal(out.created.length, 3);

    // each new variant is seeded with a copy of the current root artifact
    for (const vid of out.created) {
      const seeded = join(dir, ".variants", vid, "index.html");
      assert.ok(existsSync(seeded), `variant ${vid} should be seeded`);
      assert.match(readFileSync(seeded, "utf8"), /base design here/);
    }
    // the fan-out does not activate any of them — main stays active
    assert.equal(store.getActiveVariantId(project.id) ?? main.id, main.id);
  });
});
