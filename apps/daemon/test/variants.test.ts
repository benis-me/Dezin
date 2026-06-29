import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import type { AddressInfo } from "node:net";
import { Store } from "../../../packages/core/src/index.ts";
import type { AgentRunner } from "../../../packages/agent/src/index.ts";
import { createApp, type AppDeps } from "../src/index.ts";

interface Ctx {
  base: string;
  dataDir: string;
  store: Store;
}

async function withServer(
  fn: (ctx: Ctx) => Promise<void>,
  extraDeps: Partial<Omit<AppDeps, "store" | "dataDir">> = {},
): Promise<void> {
  const dataDir = mkdtempSync(join(tmpdir(), "dezin-variants-"));
  const store = new Store(":memory:");
  const server = createApp({ store, dataDir, ...extraDeps });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  try {
    await fn({ base: `http://127.0.0.1:${port}`, dataDir, store });
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    store.close();
  }
}

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
      const done = parseSse(await runRes.text()).find((e) => e.type === "run-done")!;
      assert.equal(store.getRun(done.runId as string)?.variantId, variant.id);
      assert.equal(runnerDir, worktree);
      assert.equal(readFileSync(join(worktree, "src", "run-marker.txt"), "utf8"), "wrote in variant worktree");
      assert.equal(existsSync(join(root, "src", "run-marker.txt")), false, "standard variant run did not write root");

      const stillMainPreview = await fetch(`${base}/projects/${project.id}/preview/`);
      assert.match(await stillMainPreview.text(), /Root main/, "targeted run does not switch the active variant");
    },
    { runner, visualQa: async () => [] },
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
