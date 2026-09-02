import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { adoptPlaceholderProjectName } from "../src/design/design-node-agent.ts";
import { createDesignProject, getDesignProject } from "../src/design/design-project-store.ts";

test("a placeholder project name is replaced once by the first Page title; explicit names are kept", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "dezin-name-adoption-"));
  try {
    const blank = await createDesignProject(dataDir, { name: "Untitled" });
    assert.equal(await adoptPlaceholderProjectName(dataDir, blank.projectId, "Pricing page"), true);
    assert.equal((await getDesignProject(dataDir, blank.projectId))?.name, "Pricing page");
    // A second Page in the same project must not rename it again.
    assert.equal(await adoptPlaceholderProjectName(dataDir, blank.projectId, "Checkout"), false);
    assert.equal((await getDesignProject(dataDir, blank.projectId))?.name, "Pricing page");

    const fresh = await createDesignProject(dataDir, { name: "New Design" });
    assert.equal(await adoptPlaceholderProjectName(dataDir, fresh.projectId, "Landing"), true);
    assert.equal((await getDesignProject(dataDir, fresh.projectId))?.name, "Landing");

    const named = await createDesignProject(dataDir, { name: "Acme redesign" });
    assert.equal(await adoptPlaceholderProjectName(dataDir, named.projectId, "Pricing page"), false);
    assert.equal((await getDesignProject(dataDir, named.projectId))?.name, "Acme redesign");

    assert.equal(await adoptPlaceholderProjectName(dataDir, "missing-project", "Anything"), false);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
