import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  getSetup,
  releaseProjectRuntime,
  resumeStandardProjectSetup,
} from "../src/project-runtime.ts";

test("daemon restart resumes an interrupted install without overwriting the existing Project", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "dezin-standard-setup-resume-"));
  const projectId = "project-restart-mid-install";
  const projectDir = join(root, "project");
  const packageBytes = Buffer.from(JSON.stringify({
    name: "user-owned-project",
    private: true,
    scripts: { dev: "vite" },
    dependencies: { react: "^19.0.0" },
  }, null, 2));
  await mkdir(join(projectDir, "node_modules", "partial-package"), { recursive: true });
  await writeFile(join(projectDir, "package.json"), packageBytes);
  await writeFile(join(projectDir, "user-design.tsx"), "export const userDesign = 'keep me';\n");
  await writeFile(join(projectDir, "node_modules", "partial-package", "broken"), "partial");
  t.after(async () => {
    await releaseProjectRuntime(projectId);
    await rm(root, { recursive: true, force: true });
  });

  assert.equal(getSetup(projectId, projectDir).phase, "installing");
  assert.equal(existsSync(join(projectDir, "index.html")), false);
  assert.equal(existsSync(join(projectDir, "vite.config.js")), false);
  assert.equal(existsSync(join(projectDir, "src", "main.jsx")), false);
  let installCalls = 0;
  await resumeStandardProjectSetup(projectId, projectDir, undefined, {
    async installDependencies(exactProjectDir) {
      installCalls += 1;
      assert.equal(exactProjectDir, projectDir);
      assert.deepEqual(await readFile(join(projectDir, "package.json")), packageBytes);
      assert.equal(
        await readFile(join(projectDir, "user-design.tsx"), "utf8"),
        "export const userDesign = 'keep me';\n",
      );
      assert.equal(existsSync(join(projectDir, "node_modules", "partial-package", "broken")), false);
      await mkdir(join(projectDir, "node_modules", "react"), { recursive: true });
      await writeFile(join(projectDir, "node_modules", "react", "package.json"), "{}\n");
      return 0;
    },
  });

  assert.equal(installCalls, 1);
  assert.equal(getSetup(projectId, projectDir).phase, "ready");
  assert.deepEqual(await readFile(join(projectDir, "package.json")), packageBytes);
  assert.equal(
    await readFile(join(projectDir, "user-design.tsx"), "utf8"),
    "export const userDesign = 'keep me';\n",
  );
  assert.equal(
    existsSync(join(projectDir, "node_modules", ".dezin-dependency-fingerprint")),
    true,
  );
  assert.equal(existsSync(join(projectDir, "index.html")), true);
  assert.equal(existsSync(join(projectDir, "vite.config.js")), true);
  assert.equal(existsSync(join(projectDir, "src", "main.jsx")), true);

  // A dependency stamp is not enough to prove setup is complete. Simulate a
  // later package-first crash that retained the valid install but lost scaffold
  // and Git entries; restart recovery must merge those entries without another
  // install or overwriting the existing Project.
  await releaseProjectRuntime(projectId);
  await rm(join(projectDir, "index.html"), { force: true });
  await rm(join(projectDir, "vite.config.js"), { force: true });
  await rm(join(projectDir, "src", "main.jsx"), { force: true });
  await rm(join(projectDir, ".git"), { recursive: true, force: true });
  assert.equal(getSetup(projectId, projectDir).phase, "installing");

  await resumeStandardProjectSetup(projectId, projectDir, undefined, {
    async installDependencies() {
      assert.fail("a valid dependency stamp must be reused after scaffold recovery");
    },
  });
  assert.equal(getSetup(projectId, projectDir).phase, "ready");
  assert.equal(existsSync(join(projectDir, ".git")), true);
  assert.equal(existsSync(join(projectDir, "index.html")), true);
  assert.equal(existsSync(join(projectDir, "vite.config.js")), true);
  assert.equal(existsSync(join(projectDir, "src", "main.jsx")), true);
  assert.deepEqual(await readFile(join(projectDir, "package.json")), packageBytes);
  assert.equal(
    await readFile(join(projectDir, "user-design.tsx"), "utf8"),
    "export const userDesign = 'keep me';\n",
  );

  await releaseProjectRuntime(projectId);
  await writeFile(join(projectDir, "package.json"), Buffer.concat([packageBytes, Buffer.from("\n")]));
  assert.equal(
    getSetup(projectId, projectDir).phase,
    "installing",
    "a stale dependency stamp must not make a changed package manifest look ready after restart",
  );
});
