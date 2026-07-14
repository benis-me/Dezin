import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Store } from "../../../packages/core/src/index.ts";
import { createApp, createRuntimeSupervisor, type AppDeps } from "../src/index.ts";
import { ensureStandardProjectWorkspace } from "../src/workspace-migration.ts";

interface WorkspaceServerContext {
  base: string;
  dataDir: string;
  store: Store;
}

async function withWorkspaceServer(
  run: (context: WorkspaceServerContext) => Promise<void>,
  extraDeps: Partial<AppDeps> = {},
): Promise<void> {
  const dataDir = mkdtempSync(join(tmpdir(), "dezin-workspace-http-"));
  const store = new Store(join(dataDir, "store.db"));
  const runtimeSupervisor = extraDeps.runtimeSupervisor ?? createRuntimeSupervisor({ dataDir, store });
  const server = createApp({ ...extraDeps, store, dataDir, runtimeSupervisor });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await run({ base: `http://127.0.0.1:${port}`, dataDir, store });
  } finally {
    await runtimeSupervisor.shutdown();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
  }
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function captureGit(root: string): Record<string, string> {
  return {
    head: readFileSync(join(root, ".git", "HEAD"), "utf8"),
    index: readFileSync(join(root, ".git", "index")).toString("base64"),
    branch: git(root, ["branch", "--show-current"]),
    refs: git(root, ["for-each-ref", "--format=%(refname) %(objectname)"]),
    status: git(root, ["status", "--porcelain=v2", "--untracked-files=all"]),
    worktrees: git(root, ["worktree", "list", "--porcelain"]),
    source: readFileSync(join(root, "index.html"), "utf8"),
  };
}

interface ReadyWorkspaceResponse {
  workspace: { id: string; projectId: string; graphRevision: number };
  graph: { revision: number; nodes: Array<{ id: string; artifactId?: string }> };
  activeSnapshot: { id: string };
  snapshots: Array<{ id: string }>;
  layout: {
    layoutId: string;
    checksum: string;
    objects: Array<{ id: string }>;
    viewport: { x: number; y: number; zoom: number };
  };
}

function emptyWorkspaceGenerationPayload() {
  return {
    kind: "workspace-generation" as const,
    resourceOperations: [],
    artifactPlans: [],
    dependencyPlans: [],
    prototypeIntents: [],
    capabilities: [],
    responsiveFrames: [],
    qualityProfile: {
      requiredFrameIds: [],
      blockingSeverities: [],
      requireRuntimeChecks: false,
      requireVisualReview: false,
    },
  };
}

function proposalPageCommand(suffix: string, name = `Page ${suffix}`) {
  return {
    id: `proposal-command-${suffix}`,
    type: "add-node" as const,
    node: {
      id: `proposal-node-${suffix}`,
      kind: "page" as const,
      name,
      artifactId: `proposal-artifact-${suffix}`,
      createIdentity: { initialTrackId: `proposal-track-${suffix}` },
    },
  };
}

function proposalCreateBody(
  ready: Pick<ReadyWorkspaceResponse, "graph" | "activeSnapshot" | "layout">,
  suffix: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    kind: "workspace-generation" as const,
    baseGraphRevision: ready.graph.revision,
    baseSnapshotId: ready.activeSnapshot.id,
    layoutId: ready.layout.layoutId,
    baseLayoutChecksum: ready.layout.checksum,
    operations: [proposalPageCommand(suffix)],
    layoutOperations: [],
    generation: emptyWorkspaceGenerationPayload(),
    rationale: `Add ${suffix}`,
    assumptions: [],
    ...overrides,
  };
}

async function readyWorkspace(base: string, projectId: string): Promise<ReadyWorkspaceResponse> {
  const response = await fetch(`${base}/api/projects/${projectId}/workspace`);
  assert.equal(response.status, 200);
  return await response.json() as ReadyWorkspaceResponse;
}

function workspaceProposalCounts(store: Store, workspaceId?: string) {
  const scoped = workspaceId === undefined ? "" : " WHERE workspace_id = ?";
  const args = workspaceId === undefined ? [] : [workspaceId];
  return {
    proposals: Number((store.db.prepare(
      `SELECT COUNT(*) AS count FROM workspace_proposals${scoped}`,
    ).get(...args) as { count: number }).count),
    audits: Number((store.db.prepare(
      workspaceId === undefined
        ? "SELECT COUNT(*) AS count FROM workspace_proposal_audit"
        : `SELECT COUNT(*) AS count FROM workspace_proposal_audit audit
           JOIN workspace_proposals proposal ON proposal.id = audit.proposal_id
           WHERE proposal.workspace_id = ?`,
    ).get(...args) as { count: number }).count),
    plans: Number((store.db.prepare(
      `SELECT COUNT(*) AS count FROM generation_plans${scoped}`,
    ).get(...args) as { count: number }).count),
  };
}

test("GET workspace lazily exposes a Standard project with its default layout", async () => {
  await withWorkspaceServer(async ({ base, store }) => {
    const project = store.createProject({ name: "HTTP Workspace", mode: "standard" });

    const response = await fetch(`${base}/api/projects/${project.id}/workspace`);

    assert.equal(response.status, 200);
    const body = await response.json() as {
      status: string;
      workspace: { id: string; projectId: string; graphRevision: number };
      graph: { revision: number };
      layout: { layoutId: string; workspaceId: string };
    };
    assert.equal(body.status, "ready");
    assert.equal(body.workspace.projectId, project.id);
    assert.equal(body.graph.revision, 1);
    assert.equal(body.layout.layoutId, "default");
    assert.equal(body.layout.workspaceId, body.workspace.id);
  });
});

test("concurrent HTTP workspace reads converge on one ready bundle", async () => {
  await withWorkspaceServer(async ({ base, store }) => {
    const project = store.createProject({ name: "Concurrent HTTP Workspace", mode: "standard" });
    const responses = await Promise.all(Array.from(
      { length: 6 },
      () => fetch(`${base}/api/projects/${project.id}/workspace`),
    ));
    assert.deepEqual(responses.map((response) => response.status), [200, 200, 200, 200, 200, 200]);
    const bodies = await Promise.all(responses.map((response) => response.json()));
    for (const body of bodies.slice(1)) assert.deepEqual(body, bodies[0]);
    assert.equal((store.db.prepare(
      "SELECT COUNT(*) AS count FROM workspace_artifacts WHERE legacy_wrapped = 1",
    ).get() as { count: number }).count, 1);
    assert.equal((store.db.prepare(
      "SELECT COUNT(*) AS count FROM workspace_snapshots",
    ).get() as { count: number }).count, 2);
  });
});

test("workspace routes reject missing projects and malformed path encodings without writing", async () => {
  await withWorkspaceServer(async ({ base, store }) => {
    const missing = await fetch(`${base}/api/projects/missing/workspace`);
    const malformed = await fetch(`${base}/api/projects/%ZZ/workspace`);
    const encodedSlash = await fetch(`${base}/api/projects/a%2Fb/workspace`);
    const wrongMethod = await fetch(`${base}/api/projects/missing/workspace`, { method: "DELETE" });

    assert.equal(missing.status, 404);
    assert.equal(malformed.status, 400);
    assert.equal(encodedSlash.status, 400);
    assert.equal(wrongMethod.status, 405);
    assert.equal((store.db.prepare(
      "SELECT COUNT(*) AS count FROM project_workspaces",
    ).get() as { count: number }).count, 0);

    const internalFailure = store.createProject({ name: "Internal URIError", mode: "standard" });
    const originalGetProject = store.getProject.bind(store);
    store.getProject = ((projectId: string) => {
      if (projectId === internalFailure.id) throw new URIError("internal URI failure");
      return originalGetProject(projectId);
    }) as typeof store.getProject;
    const internal = await fetch(`${base}/api/projects/${internalFailure.id}/workspace`);
    assert.equal(internal.status, 500, "internal URIError must not be mislabeled as a bad path");
    store.getProject = originalGetProject;

    const deleted = store.createProject({ name: "Deleted during migration", mode: "standard" });
    const originalReadFacts = store.workspace.readLegacyStandardWorkspaceFacts.bind(store.workspace);
    store.workspace.readLegacyStandardWorkspaceFacts = ((projectId: string) => {
      const facts = originalReadFacts(projectId);
      if (projectId === deleted.id) store.deleteProject(projectId);
      return facts;
    }) as typeof store.workspace.readLegacyStandardWorkspaceFacts;
    const deletionRace = await fetch(`${base}/api/projects/${deleted.id}/workspace`);
    assert.equal(deletionRace.status, 404);
    assert.equal(store.workspace.getWorkspace(deleted.id), null);
  });
});

test("malformed graph and layout bodies fail before Standard workspace migration", async () => {
  await withWorkspaceServer(async ({ base, store }) => {
    const cases: Array<{
      name: string;
      path: "graph" | "layout";
      expectedStatus: number;
      headers: Record<string, string>;
      body: string;
    }> = [
      {
        name: "invalid-json",
        path: "graph",
        expectedStatus: 400,
        headers: { "content-type": "application/json" },
        body: "{",
      },
      {
        name: "wrong-content-type",
        path: "graph",
        expectedStatus: 415,
        headers: { "content-type": "text/plain" },
        body: "{}",
      },
      {
        name: "empty-command-batch",
        path: "graph",
        expectedStatus: 400,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ baseGraphRevision: 0, expectedSnapshotId: "snapshot", commands: [] }),
      },
      {
        name: "unknown-envelope-field",
        path: "graph",
        expectedStatus: 400,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          baseGraphRevision: 0,
          expectedSnapshotId: "snapshot",
          commands: [{
            id: "command",
            type: "add-node",
            node: {
              id: "page-node",
              kind: "page",
              name: "Page",
              artifactId: "page-artifact",
              createIdentity: { initialTrackId: "page-track" },
            },
          }],
          unexpected: true,
        }),
      },
      {
        name: "empty-layout-patch",
        path: "layout",
        expectedStatus: 400,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          graphRevision: 0,
          baseLayoutChecksum: "unused-layout-checksum",
          commands: [],
        }),
      },
      {
        name: "non-finite-layout-number",
        path: "layout",
        expectedStatus: 400,
        headers: { "content-type": "application/json" },
        body: '{"graphRevision":0,"baseLayoutChecksum":"unused-layout-checksum","commands":[{"type":"set-viewport","viewport":{"x":0,"y":0,"zoom":1e999}}]}',
      },
      {
        name: "oversized-json-body",
        path: "graph",
        expectedStatus: 413,
        headers: { "content-type": "application/json" },
        body: `{"padding":"${"x".repeat(4 * 1024 * 1024)}"}`,
      },
    ];

    for (const fixture of cases) {
      const project = store.createProject({ name: fixture.name, mode: "standard" });
      const suffix = fixture.path === "graph" ? "workspace/graph/commands" : "workspace/layout";
      const response = await fetch(`${base}/api/projects/${project.id}/${suffix}`, {
        method: fixture.path === "graph" ? "POST" : "PUT",
        headers: fixture.headers,
        body: fixture.body,
      });
      assert.equal(response.status, fixture.expectedStatus, fixture.name);
      assert.equal(store.workspace.getWorkspace(project.id), null, `${fixture.name} migrated the Project`);
    }
    assert.equal((store.db.prepare(
      "SELECT COUNT(*) AS count FROM workspace_artifacts",
    ).get() as { count: number }).count, 0);
  });
});

test("workspace Proposal HTTP creates, lists, and gets an isolated draft", async () => {
  await withWorkspaceServer(async ({ base, store }) => {
    const project = store.createProject({ name: "Proposal HTTP draft", mode: "standard" });
    const ready = await readyWorkspace(base, project.id);
    const graphBefore = store.workspace.getGraph(project.id);
    const layoutBefore = store.workspace.getLayout(project.id);
    const snapshotsBefore = store.db.prepare(
      "SELECT id FROM workspace_snapshots WHERE workspace_id = ? ORDER BY id",
    ).all(ready.workspace.id);

    const createdResponse = await fetch(`${base}/api/projects/${project.id}/workspace/proposals`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(proposalCreateBody(ready, "http-draft")),
    });
    assert.equal(createdResponse.status, 201);
    const created = await createdResponse.json() as {
      id: string;
      workspaceId: string;
      revision: number;
      status: string;
    };
    assert.equal(created.workspaceId, ready.workspace.id);
    assert.equal(created.revision, 1);
    assert.equal(created.status, "draft");

    const listResponse = await fetch(`${base}/api/projects/${project.id}/workspace/proposals`);
    assert.equal(listResponse.status, 200);
    assert.deepEqual(await listResponse.json(), [created]);
    const getResponse = await fetch(
      `${base}/api/projects/${project.id}/workspace/proposals/${created.id}`,
    );
    assert.equal(getResponse.status, 200);
    assert.deepEqual(await getResponse.json(), created);

    assert.deepEqual(store.workspace.getGraph(project.id), graphBefore);
    assert.deepEqual(store.workspace.getLayout(project.id), layoutBefore);
    assert.deepEqual(store.db.prepare(
      "SELECT id FROM workspace_snapshots WHERE workspace_id = ? ORDER BY id",
    ).all(ready.workspace.id), snapshotsBefore);
    assert.deepEqual(workspaceProposalCounts(store, ready.workspace.id), {
      proposals: 1,
      audits: 1,
      plans: 0,
    });
  });
});

test("malformed Proposal bodies fail before Standard workspace migration", async () => {
  await withWorkspaceServer(async ({ base, store }) => {
    const createEnvelope = {
      kind: "workspace-generation",
      baseGraphRevision: 0,
      baseSnapshotId: "unused-snapshot",
      layoutId: "default",
      baseLayoutChecksum: "unused-layout-checksum",
      operations: [],
      layoutOperations: [],
      generation: emptyWorkspaceGenerationPayload(),
      rationale: "Never persisted",
      assumptions: [],
    };
    const updateEnvelope = {
      expectedProposalRevision: 1,
      operations: [],
      layoutOperations: [],
      generation: emptyWorkspaceGenerationPayload(),
      rationale: "Never persisted",
      assumptions: [],
    };
    const cases: Array<{
      name: string;
      suffix: string;
      method: "POST" | "PATCH";
      headers: Record<string, string>;
      body: string;
      expectedStatus: number;
    }> = [
      {
        name: "proposal-invalid-json",
        suffix: "workspace/proposals",
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{",
        expectedStatus: 400,
      },
      {
        name: "proposal-wrong-content-type",
        suffix: "workspace/proposals",
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: JSON.stringify(createEnvelope),
        expectedStatus: 415,
      },
      {
        name: "proposal-client-project-ownership",
        suffix: "workspace/proposals",
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...createEnvelope, projectId: "client-project" }),
        expectedStatus: 400,
      },
      {
        name: "proposal-client-workspace-ownership",
        suffix: "workspace/proposals",
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...createEnvelope, workspaceId: "client-workspace" }),
        expectedStatus: 400,
      },
      {
        name: "proposal-kind-payload-mismatch",
        suffix: "workspace/proposals",
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...createEnvelope, kind: "component-propagation" }),
        expectedStatus: 400,
      },
      {
        name: "proposal-update-unknown-field",
        suffix: "workspace/proposals/missing-proposal",
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...updateEnvelope, unexpected: true }),
        expectedStatus: 400,
      },
      {
        name: "proposal-invalid-approval-mode",
        suffix: "workspace/proposals/missing-proposal/approve",
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode: "retry-until-success" }),
        expectedStatus: 400,
      },
      {
        name: "proposal-approval-unknown-field",
        suffix: "workspace/proposals/missing-proposal/approve",
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode: "generate", queue: true }),
        expectedStatus: 400,
      },
      {
        name: "proposal-reject-unknown-field",
        suffix: "workspace/proposals/missing-proposal/reject",
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: "not part of the contract" }),
        expectedStatus: 400,
      },
      {
        name: "proposal-oversized-json",
        suffix: "workspace/proposals",
        method: "POST",
        headers: { "content-type": "application/json" },
        body: `{"padding":"${"x".repeat(4 * 1024 * 1024)}"}`,
        expectedStatus: 413,
      },
    ];

    for (const fixture of cases) {
      const project = store.createProject({ name: fixture.name, mode: "standard" });
      const response = await fetch(`${base}/api/projects/${project.id}/${fixture.suffix}`, {
        method: fixture.method,
        headers: fixture.headers,
        body: fixture.body,
      });
      assert.equal(response.status, fixture.expectedStatus, fixture.name);
      assert.equal(store.workspace.getWorkspace(project.id), null, `${fixture.name} migrated the Project`);
    }
    assert.deepEqual(workspaceProposalCounts(store), { proposals: 0, audits: 0, plans: 0 });
  });
});

test("workspace Proposal HTTP updates by revision and structure-only approval applies exactly once", async () => {
  await withWorkspaceServer(async ({ base, store }) => {
    const project = store.createProject({ name: "Proposal HTTP approval", mode: "standard" });
    const ready = await readyWorkspace(base, project.id);
    const graphBefore = store.workspace.getGraph(project.id);
    const layoutBefore = store.workspace.getLayout(project.id);
    const createdResponse = await fetch(`${base}/api/projects/${project.id}/workspace/proposals`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(proposalCreateBody(ready, "replace-me")),
    });
    const created = await createdResponse.json() as {
      id: string;
      revision: number;
      generation: ReturnType<typeof emptyWorkspaceGenerationPayload>;
    };
    const replacement = proposalPageCommand("approved-http");
    const updateBody = {
      expectedProposalRevision: created.revision,
      operations: [replacement],
      layoutOperations: [
        {
          type: "add-group",
          groupId: "approved-http-group",
          label: "Approved HTTP",
          bounds: { x: 0, y: 0, width: 500, height: 300 },
        },
        { type: "set-parent", objectId: replacement.node.id, parentGroupId: "approved-http-group" },
      ],
      generation: created.generation,
      rationale: "Use the complete replacement payload",
      assumptions: ["HTTP update is revision guarded"],
    };
    const updatedResponse = await fetch(
      `${base}/api/projects/${project.id}/workspace/proposals/${created.id}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(updateBody),
      },
    );
    assert.equal(updatedResponse.status, 200);
    const updated = await updatedResponse.json() as {
      revision: number;
      operations: unknown[];
      rationale: string;
      assumptions: string[];
    };
    assert.equal(updated.revision, 2);
    assert.deepEqual(updated.operations, [replacement]);
    assert.equal(updated.rationale, updateBody.rationale);
    assert.deepEqual(updated.assumptions, updateBody.assumptions);
    assert.deepEqual(store.workspace.getGraph(project.id), graphBefore);
    assert.deepEqual(store.workspace.getLayout(project.id), layoutBefore);
    assert.equal(workspaceProposalCounts(store, ready.workspace.id).audits, 2);

    const staleUpdate = await fetch(
      `${base}/api/projects/${project.id}/workspace/proposals/${created.id}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(updateBody),
      },
    );
    assert.equal(staleUpdate.status, 409);
    assert.deepEqual(await staleUpdate.json(), {
      error: `Workspace Proposal revision conflict for ${created.id}: expected 1, current 2`,
      code: "workspace_proposal_revision_conflict",
      proposalId: created.id,
      expectedProposalRevision: 1,
      actualProposalRevision: 2,
    });
    assert.equal(workspaceProposalCounts(store, ready.workspace.id).audits, 2);

    const snapshotsBefore = Number((store.db.prepare(
      "SELECT COUNT(*) AS count FROM workspace_snapshots WHERE workspace_id = ?",
    ).get(ready.workspace.id) as { count: number }).count);
    const approvalResponse = await fetch(
      `${base}/api/projects/${project.id}/workspace/proposals/${created.id}/approve`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode: "structure-only" }),
      },
    );
    assert.equal(approvalResponse.status, 200);
    const approval = await approvalResponse.json() as {
      proposal: {
        id: string;
        revision: number;
        status: string;
        review: { kind: string; mode?: string };
      };
      graph: { revision: number; nodes: Array<{ id: string }> };
      snapshot: { graphRevision: number };
      layout: ReadyWorkspaceResponse["layout"];
      plan: null;
    };
    assert.deepEqual(Object.keys(approval).sort(), ["graph", "layout", "plan", "proposal", "snapshot"]);
    const authoritativeProposal = store.workspace.getProposalForProject(project.id, created.id);
    assert.deepEqual(approval.proposal, authoritativeProposal);
    assert.equal(approval.proposal.id, created.id);
    assert.equal(approval.proposal.revision, updated.revision);
    assert.equal(approval.proposal.status, "approved");
    assert.deepEqual(approval.proposal.review, { kind: "approved", mode: "structure-only" });
    assert.equal(approval.graph.revision, graphBefore.revision + 1);
    assert.ok(approval.graph.nodes.some((node) => node.id === replacement.node.id));
    assert.equal(approval.snapshot.graphRevision, approval.graph.revision);
    assert.equal(approval.plan, null);
    assert.equal(Number((store.db.prepare(
      "SELECT COUNT(*) AS count FROM workspace_snapshots WHERE workspace_id = ?",
    ).get(ready.workspace.id) as { count: number }).count), snapshotsBefore + 1);
    assert.equal(store.workspace.getProposalForProject(project.id, created.id).status, "approved");
    const authoritativeLayout = store.workspace.getLayout(project.id);
    assert.deepEqual(approval.layout, authoritativeLayout);
    assert.notEqual(approval.layout.checksum, layoutBefore.checksum);
    assert.equal(approval.layout.objects.find(
      (object) => object.id === replacement.node.id,
    )?.parentGroupId, "approved-http-group");

    const secondApproval = await fetch(
      `${base}/api/projects/${project.id}/workspace/proposals/${created.id}/approve`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode: "structure-only" }),
      },
    );
    assert.equal(secondApproval.status, 409);
    assert.equal(
      (await secondApproval.json() as { code: string }).code,
      "workspace_proposal_state_conflict",
    );
  });
});

test("workspace Proposal approval HTTP returns authoritative layout for layout-only and no-op drafts", async () => {
  await withWorkspaceServer(async ({ base, store }) => {
    const layoutProject = store.createProject({ name: "Proposal layout-only HTTP", mode: "standard" });
    const layoutReady = await readyWorkspace(base, layoutProject.id);
    const layoutCreate = await fetch(`${base}/api/projects/${layoutProject.id}/workspace/proposals`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(proposalCreateBody(layoutReady, "layout-only-result", {
        operations: [],
        layoutOperations: [
          {
            type: "add-group",
            groupId: "layout-only-http-group",
            label: "Layout only HTTP",
            bounds: { x: 12, y: 24, width: 360, height: 240 },
          },
          { type: "set-viewport", viewport: { x: -40, y: 80, zoom: 0.75 } },
        ],
      })),
    });
    assert.equal(layoutCreate.status, 201);
    const layoutProposal = await layoutCreate.json() as { id: string };
    const layoutApprovalResponse = await fetch(
      `${base}/api/projects/${layoutProject.id}/workspace/proposals/${layoutProposal.id}/approve`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode: "structure-only" }),
      },
    );
    assert.equal(layoutApprovalResponse.status, 200);
    const layoutApproval = await layoutApprovalResponse.json() as {
      proposal: unknown;
      graph: ReadyWorkspaceResponse["graph"];
      snapshot: ReadyWorkspaceResponse["activeSnapshot"];
      layout: ReadyWorkspaceResponse["layout"];
      plan: null;
    };
    assert.deepEqual(Object.keys(layoutApproval).sort(), ["graph", "layout", "plan", "proposal", "snapshot"]);
    assert.deepEqual(
      layoutApproval.proposal,
      store.workspace.getProposalForProject(layoutProject.id, layoutProposal.id),
    );
    assert.deepEqual(layoutApproval.layout, store.workspace.getLayout(layoutProject.id));
    assert.notEqual(layoutApproval.layout.checksum, layoutReady.layout.checksum);
    assert.equal(layoutApproval.layout.objects.find(({ id }) => id === "layout-only-http-group")?.kind, "group");
    assert.deepEqual(layoutApproval.layout.viewport, { x: -40, y: 80, zoom: 0.75 });

    const noOpProject = store.createProject({ name: "Proposal no-op HTTP", mode: "standard" });
    const noOpReady = await readyWorkspace(base, noOpProject.id);
    const guardedLayout = store.workspace.getLayout(noOpProject.id);
    const noOpCreate = await fetch(`${base}/api/projects/${noOpProject.id}/workspace/proposals`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(proposalCreateBody(noOpReady, "no-op-result", {
        operations: [],
        layoutOperations: [],
      })),
    });
    assert.equal(noOpCreate.status, 201);
    const noOpProposal = await noOpCreate.json() as { id: string };
    const noOpApprovalResponse = await fetch(
      `${base}/api/projects/${noOpProject.id}/workspace/proposals/${noOpProposal.id}/approve`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode: "structure-only" }),
      },
    );
    assert.equal(noOpApprovalResponse.status, 200);
    const noOpApproval = await noOpApprovalResponse.json() as {
      proposal: unknown;
      graph: ReadyWorkspaceResponse["graph"];
      snapshot: ReadyWorkspaceResponse["activeSnapshot"];
      layout: ReadyWorkspaceResponse["layout"];
      plan: null;
    };
    assert.deepEqual(Object.keys(noOpApproval).sort(), ["graph", "layout", "plan", "proposal", "snapshot"]);
    assert.deepEqual(
      noOpApproval.proposal,
      store.workspace.getProposalForProject(noOpProject.id, noOpProposal.id),
    );
    assert.deepEqual(noOpApproval.layout, guardedLayout);
    assert.equal(noOpApproval.layout.checksum, noOpReady.layout.checksum);
    assert.deepEqual(noOpApproval.layout.objects, guardedLayout.objects);
  });
});

test("workspace Proposal HTTP generate approval returns an unqueued shell and reject changes only Proposal state", async () => {
  await withWorkspaceServer(async ({ base, store }) => {
    const project = store.createProject({ name: "Proposal generate and reject", mode: "standard" });
    const ready = await readyWorkspace(base, project.id);
    const generatedResponse = await fetch(`${base}/api/projects/${project.id}/workspace/proposals`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(proposalCreateBody(ready, "generate-shell")),
    });
    const generated = await generatedResponse.json() as { id: string; revision: number };
    const approvalResponse = await fetch(
      `${base}/api/projects/${project.id}/workspace/proposals/${generated.id}/approve`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode: "generate" }),
      },
    );
    assert.equal(approvalResponse.status, 200);
    const approval = await approvalResponse.json() as {
      proposal: { id: string; revision: number; status: string; review: unknown };
      graph: { revision: number };
      snapshot: { id: string };
      layout: ReadyWorkspaceResponse["layout"];
      plan: {
        id: string;
        proposalId: string;
        proposalRevision: number;
        baseSnapshotId: string;
        status: string;
      };
    };
    assert.deepEqual(Object.keys(approval).sort(), ["graph", "layout", "plan", "proposal", "snapshot"]);
    assert.deepEqual(approval.proposal, store.workspace.getProposalForProject(project.id, generated.id));
    assert.equal(approval.proposal.id, generated.id);
    assert.equal(approval.proposal.revision, generated.revision);
    assert.equal(approval.proposal.status, "approved");
    assert.deepEqual(approval.proposal.review, { kind: "approved", mode: "generate" });
    assert.deepEqual(approval.layout, store.workspace.getLayout(project.id));
    assert.equal(approval.plan.proposalId, generated.id);
    assert.equal(approval.plan.proposalRevision, generated.revision);
    assert.equal(approval.plan.baseSnapshotId, approval.snapshot.id);
    assert.equal(approval.plan.status, "approved");
    const planRow = store.db.prepare(
      `SELECT status, compile_error_json AS compileError, finished_at AS finishedAt
       FROM generation_plans WHERE id = ?`,
    ).get(approval.plan.id) as { status: string; compileError: string | null; finishedAt: number | null };
    assert.equal(planRow.status, "approved");
    assert.equal(planRow.compileError, null);
    assert.equal(planRow.finishedAt, null);

    const afterGenerate = await readyWorkspace(base, project.id);
    const rejectedCreate = await fetch(`${base}/api/projects/${project.id}/workspace/proposals`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(proposalCreateBody(afterGenerate, "reject-only")),
    });
    const rejectDraft = await rejectedCreate.json() as { id: string; status: string };
    const canonicalBeforeReject = {
      graph: store.workspace.getGraph(project.id),
      layout: store.workspace.getLayout(project.id),
      snapshots: store.db.prepare(
        "SELECT id FROM workspace_snapshots WHERE workspace_id = ? ORDER BY id",
      ).all(ready.workspace.id),
      plans: store.db.prepare(
        "SELECT id, status FROM generation_plans WHERE workspace_id = ? ORDER BY id",
      ).all(ready.workspace.id),
    };
    const rejectResponse = await fetch(
      `${base}/api/projects/${project.id}/workspace/proposals/${rejectDraft.id}/reject`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      },
    );
    assert.equal(rejectResponse.status, 200);
    assert.equal((await rejectResponse.json() as { status: string }).status, "rejected");
    assert.deepEqual({
      graph: store.workspace.getGraph(project.id),
      layout: store.workspace.getLayout(project.id),
      snapshots: store.db.prepare(
        "SELECT id FROM workspace_snapshots WHERE workspace_id = ? ORDER BY id",
      ).all(ready.workspace.id),
      plans: store.db.prepare(
        "SELECT id, status FROM generation_plans WHERE workspace_id = ? ORDER BY id",
      ).all(ready.workspace.id),
    }, canonicalBeforeReject);

    const secondReject = await fetch(
      `${base}/api/projects/${project.id}/workspace/proposals/${rejectDraft.id}/reject`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      },
    );
    assert.equal(secondReject.status, 409);
    assert.equal(
      (await secondReject.json() as { code: string }).code,
      "workspace_proposal_state_conflict",
    );
  });
});

test("stale Proposal approval returns complete conflict state without retrying or queuing", async () => {
  await withWorkspaceServer(async ({ base, store }) => {
    const project = store.createProject({ name: "Proposal stale HTTP", mode: "standard" });
    const ready = await readyWorkspace(base, project.id);
    const createResponse = await fetch(`${base}/api/projects/${project.id}/workspace/proposals`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(proposalCreateBody(ready, "stale-http")),
    });
    const proposal = await createResponse.json() as { id: string; revision: number };
    const intervening = store.workspace.applyGraphCommands(project.id, {
      baseGraphRevision: ready.graph.revision,
      expectedSnapshotId: ready.activeSnapshot.id,
      commands: [proposalPageCommand("intervening-user")],
    });
    const beforeApproval = {
      graphRevision: store.workspace.getGraph(project.id).revision,
      snapshotIds: store.db.prepare(
        "SELECT id FROM workspace_snapshots WHERE workspace_id = ? ORDER BY id",
      ).all(ready.workspace.id),
      counts: workspaceProposalCounts(store, ready.workspace.id),
    };

    const approvalResponse = await fetch(
      `${base}/api/projects/${project.id}/workspace/proposals/${proposal.id}/approve`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode: "generate" }),
      },
    );
    assert.equal(approvalResponse.status, 409);
    const conflict = await approvalResponse.json() as {
      code: string;
      expectedGraphRevision: number;
      actualGraphRevision: number;
      expectedSnapshotId: string;
      actualSnapshotId: string;
      expectedLayoutChecksum: string;
      actualLayoutChecksum: string;
      graphChanged: boolean;
      snapshotChanged: boolean;
      layoutChanged: boolean;
      proposal: { id: string; revision: number; status: string; review: { kind: string } };
      summary: Record<string, unknown>;
    };
    assert.equal(conflict.code, "workspace_revision_conflict");
    assert.equal(conflict.expectedGraphRevision, ready.graph.revision);
    assert.equal(conflict.actualGraphRevision, intervening.graph.revision);
    assert.equal(conflict.expectedSnapshotId, ready.activeSnapshot.id);
    assert.equal(conflict.actualSnapshotId, intervening.snapshot.id);
    assert.equal(conflict.graphChanged, true);
    assert.equal(conflict.snapshotChanged, true);
    assert.equal(typeof conflict.layoutChanged, "boolean");
    assert.equal(typeof conflict.expectedLayoutChecksum, "string");
    assert.equal(typeof conflict.actualLayoutChecksum, "string");
    assert.equal(conflict.proposal.id, proposal.id);
    assert.equal(conflict.proposal.status, "conflicted");
    assert.equal(conflict.proposal.review.kind, "conflict");
    assert.deepEqual(conflict.summary, {
      graphChanged: conflict.graphChanged,
      snapshotChanged: conflict.snapshotChanged,
      layoutChanged: conflict.layoutChanged,
      expectedGraphRevision: conflict.expectedGraphRevision,
      actualGraphRevision: conflict.actualGraphRevision,
      expectedSnapshotId: conflict.expectedSnapshotId,
      actualSnapshotId: conflict.actualSnapshotId,
      expectedLayoutChecksum: conflict.expectedLayoutChecksum,
      actualLayoutChecksum: conflict.actualLayoutChecksum,
    });
    const reloaded = await fetch(
      `${base}/api/projects/${project.id}/workspace/proposals/${proposal.id}`,
    );
    assert.equal(reloaded.status, 200);
    assert.deepEqual(await reloaded.json(), conflict.proposal);
    assert.deepEqual({
      graphRevision: store.workspace.getGraph(project.id).revision,
      snapshotIds: store.db.prepare(
        "SELECT id FROM workspace_snapshots WHERE workspace_id = ? ORDER BY id",
      ).all(ready.workspace.id),
      counts: workspaceProposalCounts(store, ready.workspace.id),
    }, beforeApproval);

    const retry = await fetch(
      `${base}/api/projects/${project.id}/workspace/proposals/${proposal.id}/approve`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode: "generate" }),
      },
    );
    assert.equal(retry.status, 409);
    assert.equal((await retry.json() as { code: string }).code, "workspace_proposal_state_conflict");

    const layoutProject = store.createProject({ name: "Proposal stale layout HTTP", mode: "standard" });
    const layoutReady = await readyWorkspace(base, layoutProject.id);
    const layoutCreate = await fetch(`${base}/api/projects/${layoutProject.id}/workspace/proposals`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(proposalCreateBody(layoutReady, "stale-layout-http")),
    });
    const layoutProposal = await layoutCreate.json() as { id: string };
    const layoutMutation = await fetch(`${base}/api/projects/${layoutProject.id}/workspace/layout`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        graphRevision: layoutReady.graph.revision,
        baseLayoutChecksum: layoutReady.layout.checksum,
        commands: [{ type: "set-viewport", viewport: { x: 25, y: 50, zoom: 0.8 } }],
      }),
    });
    assert.equal(layoutMutation.status, 200);
    const changedLayout = await layoutMutation.json() as { checksum: string };
    const staleLayoutApproval = await fetch(
      `${base}/api/projects/${layoutProject.id}/workspace/proposals/${layoutProposal.id}/approve`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode: "structure-only" }),
      },
    );
    assert.equal(staleLayoutApproval.status, 409);
    const layoutConflict = await staleLayoutApproval.json() as {
      code: string;
      graphChanged: boolean;
      snapshotChanged: boolean;
      layoutChanged: boolean;
      expectedLayoutChecksum: string;
      actualLayoutChecksum: string;
    };
    assert.equal(layoutConflict.code, "workspace_revision_conflict");
    assert.equal(layoutConflict.graphChanged, false);
    assert.equal(layoutConflict.snapshotChanged, false);
    assert.equal(layoutConflict.layoutChanged, true);
    assert.equal(layoutConflict.expectedLayoutChecksum, layoutReady.layout.checksum);
    assert.equal(layoutConflict.actualLayoutChecksum, changedLayout.checksum);

    const staleCreateProject = store.createProject({ name: "Proposal create layout CAS", mode: "standard" });
    const staleCreateReady = await readyWorkspace(base, staleCreateProject.id);
    const driftLayout = await fetch(`${base}/api/projects/${staleCreateProject.id}/workspace/layout`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        graphRevision: staleCreateReady.graph.revision,
        baseLayoutChecksum: staleCreateReady.layout.checksum,
        commands: [{ type: "set-viewport", viewport: { x: -10, y: 5, zoom: 1.2 } }],
      }),
    });
    assert.equal(driftLayout.status, 200);
    const staleCreate = await fetch(`${base}/api/projects/${staleCreateProject.id}/workspace/proposals`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(proposalCreateBody(staleCreateReady, "layout-cas")),
    });
    assert.equal(staleCreate.status, 409);
    const staleCreateBody = await staleCreate.json() as { code: string; expectedLayoutChecksum: string };
    assert.equal(staleCreateBody.code, "workspace_layout_conflict");
    assert.equal(staleCreateBody.expectedLayoutChecksum, staleCreateReady.layout.checksum);
  });
});

test("Proposal semantic approval errors are atomic typed 422 responses", async () => {
  await withWorkspaceServer(async ({ base, store }) => {
    const project = store.createProject({ name: "Proposal semantic HTTP", mode: "standard" });
    const ready = await readyWorkspace(base, project.id);
    const createResponse = await fetch(`${base}/api/projects/${project.id}/workspace/proposals`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(proposalCreateBody(ready, "semantic", {
        operations: [
          proposalPageCommand("duplicate-a", "Duplicate page"),
          proposalPageCommand("duplicate-b", "Duplicate page"),
        ],
      })),
    });
    assert.equal(createResponse.status, 201);
    const proposal = await createResponse.json() as { id: string; status: string };
    const beforeApproval = {
      graph: store.workspace.getGraph(project.id),
      layout: store.workspace.getLayout(project.id),
      snapshots: store.db.prepare(
        "SELECT id FROM workspace_snapshots WHERE workspace_id = ? ORDER BY id",
      ).all(ready.workspace.id),
      counts: workspaceProposalCounts(store, ready.workspace.id),
    };
    const approval = await fetch(
      `${base}/api/projects/${project.id}/workspace/proposals/${proposal.id}/approve`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode: "generate" }),
      },
    );
    assert.equal(approval.status, 422);
    const body = await approval.json() as { code: string; details: unknown };
    assert.equal(body.code, "workspace_proposal_validation_error");
    assert.deepEqual(body.details, {});
    assert.equal(store.workspace.getProposalForProject(project.id, proposal.id).status, "draft");
    assert.deepEqual({
      graph: store.workspace.getGraph(project.id),
      layout: store.workspace.getLayout(project.id),
      snapshots: store.db.prepare(
        "SELECT id FROM workspace_snapshots WHERE workspace_id = ? ORDER BY id",
      ).all(ready.workspace.id),
      counts: workspaceProposalCounts(store, ready.workspace.id),
    }, beforeApproval);
  });
});

test("Proposal 422 revalidation rejects a stale existing active Snapshot", async () => {
  await withWorkspaceServer(async ({ base, store }) => {
    const project = store.createProject({ name: "Proposal stale active Snapshot", mode: "standard" });
    const initial = await readyWorkspace(base, project.id);
    const renamed = store.workspace.applyGraphCommands(project.id, {
      baseGraphRevision: initial.graph.revision,
      expectedSnapshotId: initial.activeSnapshot.id,
      commands: [{
        id: "rename-before-stale-active-snapshot",
        type: "rename-node",
        nodeId: initial.graph.nodes[0]!.id,
        name: "Renamed before corruption",
      }],
    });
    const ready = await readyWorkspace(base, project.id);
    assert.equal(ready.activeSnapshot.id, renamed.snapshot.id);
    const createResponse = await fetch(`${base}/api/projects/${project.id}/workspace/proposals`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(proposalCreateBody(ready, "stale-active", {
        operations: [
          proposalPageCommand("stale-active-a", "Duplicate page"),
          proposalPageCommand("stale-active-b", "Duplicate page"),
        ],
      })),
    });
    assert.equal(createResponse.status, 201);
    const proposal = await createResponse.json() as { id: string };
    const approve = store.workspace.approveProposalForProject.bind(store.workspace);
    store.workspace.approveProposalForProject = ((
      projectId: string,
      proposalId: string,
      mode: Parameters<typeof approve>[2],
    ) => {
      try {
        return approve(projectId, proposalId, mode);
      } catch (error) {
        store.db.exec("DROP TRIGGER IF EXISTS workspace_snapshot_update_immutable");
        store.db.prepare(
          "UPDATE workspace_snapshots SET graph_revision = ? WHERE id = ?",
        ).run(ready.graph.revision - 1, ready.activeSnapshot.id);
        throw error;
      }
    }) as typeof store.workspace.approveProposalForProject;

    const approval = await fetch(
      `${base}/api/projects/${project.id}/workspace/proposals/${proposal.id}/approve`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode: "generate" }),
      },
    );
    assert.equal(approval.status, 500);
  });
});

test("Proposal 422 revalidation rejects corrupted canonical Resource identities", async (t) => {
  for (const corruption of ["archived", "wrong-kind"] as const) {
    await t.test(corruption, async () => {
      await withWorkspaceServer(async ({ base, store }) => {
        const project = store.createProject({ name: `Proposal Resource ${corruption}`, mode: "standard" });
        const initial = await readyWorkspace(base, project.id);
        store.workspace.applyGraphCommands(project.id, {
          baseGraphRevision: initial.graph.revision,
          expectedSnapshotId: initial.activeSnapshot.id,
          commands: [{
            id: `add-${corruption}-proposal-resource`,
            type: "add-node",
            node: {
              id: `${corruption}-proposal-resource-node`,
              kind: "resource",
              name: `${corruption} Proposal resource`,
              resourceId: `${corruption}-proposal-resource`,
              createIdentity: { resourceKind: "research", defaultPinPolicy: "pin-current" },
            },
          }],
        });
        const ready = await readyWorkspace(base, project.id);
        const createResponse = await fetch(`${base}/api/projects/${project.id}/workspace/proposals`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(proposalCreateBody(ready, `resource-${corruption}`, {
            operations: [
              proposalPageCommand(`${corruption}-a`, "Duplicate page"),
              proposalPageCommand(`${corruption}-b`, "Duplicate page"),
            ],
          })),
        });
        assert.equal(createResponse.status, 201);
        const proposal = await createResponse.json() as { id: string };
        const approve = store.workspace.approveProposalForProject.bind(store.workspace);
        store.workspace.approveProposalForProject = ((
          projectId: string,
          proposalId: string,
          mode: Parameters<typeof approve>[2],
        ) => {
          try {
            return approve(projectId, proposalId, mode);
          } catch (error) {
            if (corruption === "archived") {
              store.db.prepare(
                "UPDATE resources SET archived_at = 999 WHERE id = ?",
              ).run(`${corruption}-proposal-resource`);
            } else {
              store.db.exec("DROP TRIGGER IF EXISTS resource_identity_update_immutable");
              store.db.prepare(
                "UPDATE resources SET kind = 'asset' WHERE id = ?",
              ).run(`${corruption}-proposal-resource`);
            }
            throw error;
          }
        }) as typeof store.workspace.approveProposalForProject;

        const approval = await fetch(
          `${base}/api/projects/${project.id}/workspace/proposals/${proposal.id}/approve`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ mode: "generate" }),
          },
        );
        assert.equal(approval.status, 500);
      });
    });
  }
});

test("Prototype workspace reads stay typed and every Standard-only route is zero-write", async () => {
  await withWorkspaceServer(async ({ base, store }) => {
    const project = store.createProject({ name: "Prototype HTTP", mode: "prototype" });
    const workspace = await fetch(`${base}/api/projects/${project.id}/workspace`);
    assert.equal(workspace.status, 200);
    assert.deepEqual(await workspace.json(), {
      status: "unsupported",
      code: "workspace_requires_standard_project",
      projectId: project.id,
      projectMode: "prototype",
    });

    const readPaths = [
      "artifacts",
      "artifacts/missing-artifact",
      "artifacts/missing-artifact/tracks",
      "artifacts/missing-artifact/revisions",
      "artifacts/missing-artifact/revisions/missing-revision",
      "workspace/snapshots",
      "workspace/snapshots/missing-snapshot",
      "workspace/proposals",
      "workspace/proposals/missing-proposal",
    ];
    for (const path of readPaths) {
      const response = await fetch(`${base}/api/projects/${project.id}/${path}`);
      assert.equal(response.status, 409, path);
      assert.equal(
        (await response.json() as { code: string }).code,
        "workspace_requires_standard_project",
        path,
      );
    }

    const graph = await fetch(`${base}/api/projects/${project.id}/workspace/graph/commands`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        baseGraphRevision: 0,
        expectedSnapshotId: "unused-snapshot",
        commands: [{
          id: "prototype-command",
          type: "add-node",
          node: {
            id: "prototype-page-node",
            kind: "page",
            name: "Never created",
            artifactId: "prototype-page",
            createIdentity: { initialTrackId: "prototype-track" },
          },
        }],
      }),
    });
    assert.equal(graph.status, 409);
    assert.equal((await graph.json() as { code: string }).code, "workspace_requires_standard_project");

    const layout = await fetch(`${base}/api/projects/${project.id}/workspace/layout`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        graphRevision: 0,
        baseLayoutChecksum: "unused-layout-checksum",
        commands: [{ type: "set-viewport", viewport: { x: 1, y: 2, zoom: 1 } }],
      }),
    });
    assert.equal(layout.status, 409);
    const proposalMutations = [
      {
        path: "workspace/proposals",
        method: "POST",
        body: {
          kind: "workspace-generation",
          baseGraphRevision: 0,
          baseSnapshotId: "unused-snapshot",
          layoutId: "default",
          baseLayoutChecksum: "unused-layout-checksum",
          operations: [],
          layoutOperations: [],
          generation: emptyWorkspaceGenerationPayload(),
          rationale: "Unsupported",
          assumptions: [],
        },
      },
      {
        path: "workspace/proposals/missing-proposal",
        method: "PATCH",
        body: {
          expectedProposalRevision: 1,
          operations: [],
          layoutOperations: [],
          generation: emptyWorkspaceGenerationPayload(),
          rationale: "Unsupported",
          assumptions: [],
        },
      },
      {
        path: "workspace/proposals/missing-proposal/approve",
        method: "POST",
        body: { mode: "structure-only" },
      },
      {
        path: "workspace/proposals/missing-proposal/reject",
        method: "POST",
        body: {},
      },
    ] as const;
    for (const mutation of proposalMutations) {
      const response = await fetch(`${base}/api/projects/${project.id}/${mutation.path}`, {
        method: mutation.method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(mutation.body),
      });
      assert.equal(response.status, 409, mutation.path);
      assert.equal(
        (await response.json() as { code: string }).code,
        "workspace_requires_standard_project",
        mutation.path,
      );
    }
    assert.equal(store.workspace.getWorkspace(project.id), null);
    assert.equal((store.db.prepare(
      "SELECT COUNT(*) AS count FROM workspace_artifacts",
    ).get() as { count: number }).count, 0);
    assert.deepEqual(workspaceProposalCounts(store), { proposals: 0, audits: 0, plans: 0 });
  });
});

test("workspace graph HTTP commands preserve exact replay and expose typed conflicts", async () => {
  await withWorkspaceServer(async ({ base, store }) => {
    const project = store.createProject({ name: "Graph HTTP", mode: "standard" });
    const initialResponse = await fetch(`${base}/api/projects/${project.id}/workspace`);
    const initial = await initialResponse.json() as {
      graph: { revision: number };
      activeSnapshot: { id: string };
      workspace: { id: string };
    };
    const request = {
      baseGraphRevision: initial.graph.revision,
      expectedSnapshotId: initial.activeSnapshot.id,
      commands: [{
        id: "add-http-page",
        type: "add-node",
        node: {
          id: "http-page-node",
          kind: "page",
          name: "HTTP page",
          artifactId: "http-page",
          createIdentity: { initialTrackId: "http-page-track" },
        },
      }],
    };
    const apply = () => fetch(`${base}/api/projects/${project.id}/workspace/graph/commands`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    });

    const first = await apply();
    assert.equal(first.status, 200);
    const firstBody = await first.json() as { graph: { revision: number }; snapshot: { id: string } };
    const replay = await apply();
    assert.equal(replay.status, 200);
    assert.deepEqual(await replay.json(), firstBody);

    const reused = await fetch(`${base}/api/projects/${project.id}/workspace/graph/commands`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...request,
        commands: [{
          ...request.commands[0],
          node: { ...request.commands[0]!.node, name: "Conflicting page name" },
        }],
      }),
    });
    assert.equal(reused.status, 409);
    assert.equal((await reused.json() as { code: string }).code, "workspace_command_replay_conflict");

    const staleGraph = await fetch(`${base}/api/projects/${project.id}/workspace/graph/commands`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        baseGraphRevision: initial.graph.revision,
        expectedSnapshotId: initial.activeSnapshot.id,
        commands: [{ id: "stale-rename", type: "rename-node", nodeId: "http-page-node", name: "Stale" }],
      }),
    });
    assert.equal(staleGraph.status, 409);
    assert.equal((await staleGraph.json() as { code: string }).code, "workspace_revision_conflict");

    const staleSnapshot = await fetch(`${base}/api/projects/${project.id}/workspace/graph/commands`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        baseGraphRevision: firstBody.graph.revision,
        expectedSnapshotId: initial.activeSnapshot.id,
        commands: [{ id: "stale-snapshot", type: "rename-node", nodeId: "http-page-node", name: "Stale" }],
      }),
    });
    assert.equal(staleSnapshot.status, 409);

    const laterBatch = await fetch(`${base}/api/projects/${project.id}/workspace/graph/commands`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        baseGraphRevision: firstBody.graph.revision,
        expectedSnapshotId: firstBody.snapshot.id,
        commands: [{ id: "later-rename", type: "rename-node", nodeId: "http-page-node", name: "Later name" }],
      }),
    });
    assert.equal(laterBatch.status, 200);
    const historicalReplay = await apply();
    assert.equal(historicalReplay.status, 200);
    assert.deepEqual(await historicalReplay.json(), firstBody);

    const counts = {
      graphs: (store.db.prepare(
        "SELECT COUNT(*) AS count FROM workspace_graph_revisions WHERE workspace_id = ?",
      ).get(initial.workspace.id) as { count: number }).count,
      snapshots: (store.db.prepare(
        "SELECT COUNT(*) AS count FROM workspace_snapshots WHERE workspace_id = ?",
      ).get(initial.workspace.id) as { count: number }).count,
    };
    assert.deepEqual(counts, { graphs: 4, snapshots: 4 });
  });
});

test("workspace layout HTTP persistence stays outside semantic history and stale writes roll back", async () => {
  await withWorkspaceServer(async ({ base, store }) => {
    const project = store.createProject({ name: "Layout HTTP", mode: "standard" });
    const initial = await (await fetch(`${base}/api/projects/${project.id}/workspace`)).json() as {
      graph: { revision: number; nodes: Array<{ id: string }> };
      snapshots: unknown[];
      layout: { checksum: string };
    };
    const nodeId = initial.graph.nodes[0]!.id;
    const saved = await fetch(`${base}/api/projects/${project.id}/workspace/layout`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        graphRevision: initial.graph.revision,
        baseLayoutChecksum: initial.layout.checksum,
        commands: [
          { type: "move", objectId: nodeId, x: 42, y: 84 },
          { type: "set-viewport", viewport: { x: -20, y: 10, zoom: 0.75 } },
        ],
      }),
    });
    assert.equal(saved.status, 200);
    const savedLayout = await saved.json() as {
      checksum: string;
      objects: Array<{ id: string; x: number; y: number }>;
      viewport: { x: number; y: number; zoom: number };
    };
    assert.deepEqual(savedLayout.viewport, { x: -20, y: 10, zoom: 0.75 });
    assert.deepEqual(savedLayout.objects.find((object) => object.id === nodeId), {
      id: nodeId,
      kind: "node",
      x: 42,
      y: 84,
      parentGroupId: null,
    });

    const refreshed = await (await fetch(`${base}/api/projects/${project.id}/workspace`)).json() as {
      graph: { revision: number };
      snapshots: unknown[];
      layout: typeof savedLayout;
    };
    assert.equal(refreshed.graph.revision, initial.graph.revision);
    assert.equal(refreshed.snapshots.length, initial.snapshots.length);
    assert.deepEqual(refreshed.layout, savedLayout);

    const staleChecksum = await fetch(`${base}/api/projects/${project.id}/workspace/layout`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        graphRevision: initial.graph.revision,
        baseLayoutChecksum: initial.layout.checksum,
        commands: [{ type: "set-viewport", viewport: { x: 88, y: 88, zoom: 1.5 } }],
      }),
    });
    assert.equal(staleChecksum.status, 409);
    assert.deepEqual(await staleChecksum.json(), {
      error: `workspace layout conflict: expected ${initial.layout.checksum}, current ${savedLayout.checksum}`,
      code: "workspace_layout_conflict",
      expectedGraphRevision: initial.graph.revision,
      actualGraphRevision: initial.graph.revision,
      expectedLayoutChecksum: initial.layout.checksum,
      actualLayoutChecksum: savedLayout.checksum,
    });

    const stale = await fetch(`${base}/api/projects/${project.id}/workspace/layout`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        graphRevision: initial.graph.revision - 1,
        baseLayoutChecksum: savedLayout.checksum,
        commands: [{ type: "set-viewport", viewport: { x: 99, y: 99, zoom: 2 } }],
      }),
    });
    assert.equal(stale.status, 409);
    assert.deepEqual(store.workspace.getLayout(project.id).viewport, { x: -20, y: 10, zoom: 0.75 });
  });
});

test("workspace nested HTTP reads enforce Project and parent ownership without foreign decoding", async () => {
  await withWorkspaceServer(async ({ base, store }) => {
    const projectA = store.createProject({ name: "Owned A", mode: "standard" });
    const projectB = store.createProject({ name: "Owned B", mode: "standard" });
    const readyA = await (await fetch(`${base}/api/projects/${projectA.id}/workspace`)).json() as {
      workspace: { id: string; activeKernelRevisionId: string };
      graph: { revision: number };
      activeSnapshot: { id: string };
      artifacts: Array<{ id: string }>;
      tracks: Array<{ id: string; artifactId: string }>;
      snapshots: Array<{ id: string }>;
    };
    const readyB = await (await fetch(`${base}/api/projects/${projectB.id}/workspace`)).json() as {
      workspace: { id: string };
      graph: { revision: number };
      activeSnapshot: { id: string };
      artifacts: Array<{ id: string }>;
    };
    const artifactA = readyA.artifacts[0]!;
    const trackA = readyA.tracks.find((track) => track.artifactId === artifactA.id)!;
    const revisionA = store.workspace.createArtifactRevision({
      artifactId: artifactA.id,
      trackId: trackA.id,
      parentRevisionId: null,
      sourceCommitHash: "a".repeat(40),
      sourceTreeHash: "b".repeat(40),
      kernelRevisionId: readyA.workspace.activeKernelRevisionId,
      renderSpec: { frames: [] },
      quality: { state: "unassessed", score: null, findings: [] },
      dependencies: [],
      resourcePins: [],
    });

    const artifacts = await fetch(`${base}/api/projects/${projectA.id}/artifacts`);
    assert.equal(artifacts.status, 200);
    assert.equal((await artifacts.json() as Array<{ id: string }>)[0]?.id, artifactA.id);
    assert.equal((await fetch(`${base}/api/projects/${projectA.id}/artifacts/${artifactA.id}`)).status, 200);
    assert.equal((await fetch(`${base}/api/projects/${projectA.id}/artifacts/${artifactA.id}/tracks`)).status, 200);
    const revisions = await fetch(`${base}/api/projects/${projectA.id}/artifacts/${artifactA.id}/revisions`);
    assert.equal(revisions.status, 200);
    assert.equal((await revisions.json() as Array<{ id: string }>)[0]?.id, revisionA.id);
    assert.equal((await fetch(
      `${base}/api/projects/${projectA.id}/artifacts/${artifactA.id}/revisions/${revisionA.id}`,
    )).status, 200);
    const snapshots = await fetch(`${base}/api/projects/${projectA.id}/workspace/snapshots`);
    assert.equal(snapshots.status, 200);
    assert.equal((await snapshots.json() as Array<{ id: string }>).length, 2);
    assert.equal((await fetch(
      `${base}/api/projects/${projectA.id}/workspace/snapshots/${readyA.snapshots[1]!.id}`,
    )).status, 200);

    const foreignArtifact = await fetch(`${base}/api/projects/${projectB.id}/artifacts/${artifactA.id}`);
    const missingArtifact = await fetch(`${base}/api/projects/${projectB.id}/artifacts/missing-artifact`);
    assert.equal(foreignArtifact.status, 404);
    assert.equal(missingArtifact.status, 404);
    assert.deepEqual(await foreignArtifact.json(), await missingArtifact.json());
    assert.equal((await fetch(
      `${base}/api/projects/${projectB.id}/artifacts/${artifactA.id}/revisions/${revisionA.id}`,
    )).status, 404);
    assert.equal((await fetch(
      `${base}/api/projects/${projectB.id}/workspace/snapshots/${readyA.snapshots[1]!.id}`,
    )).status, 404);

    store.workspace.applyGraphCommands(projectA.id, {
      baseGraphRevision: readyA.graph.revision,
      expectedSnapshotId: readyA.activeSnapshot.id,
      commands: [{
        id: "add-second-owned-page",
        type: "add-node",
        node: {
          id: "owned-a-second-node",
          kind: "page",
          name: "Owned A second page",
          artifactId: "owned-a-second-artifact",
          createIdentity: { initialTrackId: "owned-a-second-track" },
        },
      }],
    });
    assert.equal((await fetch(
      `${base}/api/projects/${projectA.id}/artifacts/owned-a-second-artifact/revisions/${revisionA.id}`,
    )).status, 404, "a Revision must belong to the path Artifact even inside one Workspace");

    const crossIdentity = await fetch(`${base}/api/projects/${projectB.id}/workspace/graph/commands`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        baseGraphRevision: readyB.graph.revision,
        expectedSnapshotId: readyB.activeSnapshot.id,
        commands: [{
          id: "claim-foreign-artifact",
          type: "add-node",
          node: {
            id: "foreign-artifact-node",
            kind: "page",
            name: "Owned A",
            artifactId: artifactA.id,
          },
        }],
      }),
    });
    assert.equal(crossIdentity.status, 400);
    const afterB = await (await fetch(`${base}/api/projects/${projectB.id}/workspace`)).json() as {
      graph: { revision: number };
      activeSnapshot: { id: string };
    };
    assert.equal(afterB.graph.revision, readyB.graph.revision);
    assert.equal(afterB.activeSnapshot.id, readyB.activeSnapshot.id);

    store.db.prepare("UPDATE workspace_artifacts SET name = 'Raw foreign corruption' WHERE id = ?").run(artifactA.id);
    assert.equal((await fetch(`${base}/api/projects/${projectB.id}/artifacts/${artifactA.id}`)).status, 404);
    assert.equal((await fetch(`${base}/api/projects/${projectA.id}/workspace`)).status, 500);
    assert.deepEqual(store.db.prepare("PRAGMA foreign_key_check").all(), []);
  });
});

test("workspace Proposal nested HTTP routes hide foreign ownership and reject foreign semantic references", async () => {
  await withWorkspaceServer(async ({ base, store }) => {
    const projectA = store.createProject({ name: "Proposal owned A", mode: "standard" });
    const projectB = store.createProject({ name: "Proposal owned B", mode: "standard" });
    const readyA = await readyWorkspace(base, projectA.id);
    const readyB = await readyWorkspace(base, projectB.id);
    const createA = await fetch(`${base}/api/projects/${projectA.id}/workspace/proposals`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(proposalCreateBody(readyA, "owned-a")),
    });
    const createB = await fetch(`${base}/api/projects/${projectB.id}/workspace/proposals`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(proposalCreateBody(readyB, "owned-b")),
    });
    const proposalA = await createA.json() as {
      id: string;
      revision: number;
      operations: unknown[];
      layoutOperations: unknown[];
      generation: unknown;
      rationale: string;
      assumptions: string[];
    };
    const proposalB = await createB.json() as { id: string; revision: number; status: string };
    const missingId = "missing-proposal";
    const expectedNotFound = { error: "proposal not found" };

    const foreignGet = await fetch(
      `${base}/api/projects/${projectB.id}/workspace/proposals/${proposalA.id}`,
    );
    const missingGet = await fetch(
      `${base}/api/projects/${projectB.id}/workspace/proposals/${missingId}`,
    );
    assert.equal(foreignGet.status, 404);
    assert.equal(missingGet.status, 404);
    assert.deepEqual(await foreignGet.json(), expectedNotFound);
    assert.deepEqual(await missingGet.json(), expectedNotFound);

    const updateBody = {
      expectedProposalRevision: proposalA.revision,
      operations: proposalA.operations,
      layoutOperations: proposalA.layoutOperations,
      generation: proposalA.generation,
      rationale: proposalA.rationale,
      assumptions: proposalA.assumptions,
    };
    const mutationRequests = [
      {
        suffix: "",
        method: "PATCH",
        body: updateBody,
      },
      {
        suffix: "/approve",
        method: "POST",
        body: { mode: "structure-only" },
      },
      {
        suffix: "/reject",
        method: "POST",
        body: {},
      },
    ] as const;
    for (const mutation of mutationRequests) {
      for (const proposalId of [proposalA.id, missingId]) {
        const response = await fetch(
          `${base}/api/projects/${projectB.id}/workspace/proposals/${proposalId}${mutation.suffix}`,
          {
            method: mutation.method,
            headers: { "content-type": "application/json" },
            body: JSON.stringify(mutation.body),
          },
        );
        assert.equal(response.status, 404, `${mutation.method} ${mutation.suffix || "proposal"}`);
        assert.deepEqual(await response.json(), expectedNotFound);
      }
    }
    assert.equal(store.workspace.getProposalForProject(projectA.id, proposalA.id).status, "draft");
    assert.equal(store.workspace.getProposalForProject(projectB.id, proposalB.id).status, "draft");

    const conversationA = store.createConversation(projectA.id, "Foreign Proposal Run");
    const runA = store.createRun(projectA.id, conversationA.id);
    const beforeForeignReference = workspaceProposalCounts(store, readyB.workspace.id);
    const foreignReference = await fetch(`${base}/api/projects/${projectB.id}/workspace/proposals`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(proposalCreateBody(readyB, "foreign-run", { createdByRunId: runA.id })),
    });
    assert.equal(foreignReference.status, 422);
    assert.equal(
      (await foreignReference.json() as { code: string }).code,
      "workspace_proposal_validation_error",
    );
    assert.deepEqual(workspaceProposalCounts(store, readyB.workspace.id), beforeForeignReference);

    const foreignBase = await fetch(`${base}/api/projects/${projectB.id}/workspace/proposals`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(proposalCreateBody(readyB, "foreign-base", {
        baseSnapshotId: readyA.activeSnapshot.id,
      })),
    });
    assert.equal(foreignBase.status, 409);
    const foreignBaseBody = await foreignBase.json() as Record<string, unknown>;
    assert.equal(foreignBaseBody.code, "workspace_revision_conflict");
    assert.equal("foreignProjectId" in foreignBaseBody, false);
    assert.deepEqual(workspaceProposalCounts(store, readyB.workspace.id), beforeForeignReference);
  });
});

test("workspace mutations never relabel durable graph or layout corruption as client errors", async () => {
  await withWorkspaceServer(async ({ base, store }) => {
    const layoutProject = store.createProject({ name: "Layout corruption race", mode: "standard" });
    const layoutReady = await (await fetch(`${base}/api/projects/${layoutProject.id}/workspace`)).json() as {
      workspace: { id: string };
      graph: { revision: number };
      layout: { checksum: string };
    };
    const readViewport = (): { x: number; y: number; zoom: number } | null => {
      const row = store.db.prepare(`
        SELECT x, y, zoom FROM workspace_layout_viewports
        WHERE workspace_id = ? AND layout_id = 'default'
      `).get(layoutReady.workspace.id) as { x: number; y: number; zoom: number } | undefined;
      return row ? { x: row.x, y: row.y, zoom: row.zoom } : null;
    };
    const viewportBefore = readViewport();
    const originalSaveLayout = store.workspace.saveLayout.bind(store.workspace);
    let injectedLayoutCorruption = false;
    store.workspace.saveLayout = ((...args: Parameters<typeof originalSaveLayout>) => {
      if (!injectedLayoutCorruption) {
        injectedLayoutCorruption = true;
        const insert = store.db.prepare(`
          INSERT INTO workspace_layout_nodes (
            workspace_id, layout_id, object_id, object_kind, x, y, width, height,
            parent_group_id, label, collapsed, updated_at
          ) VALUES (?, 'default', ?, 'group', 0, 0, 100, 100, ?, ?, 0, ?)
        `);
        insert.run(layoutReady.workspace.id, "race-group-a", null, "A", 1);
        insert.run(layoutReady.workspace.id, "race-group-b", "race-group-a", "B", 1);
        store.db.prepare(`
          UPDATE workspace_layout_nodes
          SET parent_group_id = 'race-group-b'
          WHERE workspace_id = ? AND layout_id = 'default' AND object_id = 'race-group-a'
        `).run(layoutReady.workspace.id);
      }
      return originalSaveLayout(...args);
    }) as typeof store.workspace.saveLayout;

    const corruptLayout = await fetch(`${base}/api/projects/${layoutProject.id}/workspace/layout`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        graphRevision: layoutReady.graph.revision,
        baseLayoutChecksum: layoutReady.layout.checksum,
        commands: [{ type: "set-viewport", viewport: { x: 99, y: 88, zoom: 1.5 } }],
      }),
    });
    assert.equal(corruptLayout.status, 500);
    assert.deepEqual(readViewport(), viewportBefore);
    assert.equal((store.db.prepare(`
      SELECT COUNT(*) AS count FROM workspace_layout_nodes
      WHERE workspace_id = ? AND object_kind = 'group'
    `).get(layoutReady.workspace.id) as { count: number }).count, 2);

    const graphProject = store.createProject({ name: "Graph corruption race", mode: "standard" });
    const graphReady = await (await fetch(`${base}/api/projects/${graphProject.id}/workspace`)).json() as {
      workspace: { id: string };
      graph: { revision: number; nodes: Array<{ id: string; artifactId?: string }> };
      activeSnapshot: { id: string };
      artifacts: Array<{ id: string }>;
      snapshots: unknown[];
    };
    const graphArtifact = graphReady.artifacts[0]!;
    const graphNode = graphReady.graph.nodes.find((node) => node.artifactId === graphArtifact.id)!;
    const originalApplyGraphCommands = store.workspace.applyGraphCommands.bind(store.workspace);
    let injectedGraphCorruption = false;
    store.workspace.applyGraphCommands = ((...args: Parameters<typeof originalApplyGraphCommands>) => {
      if (!injectedGraphCorruption) {
        injectedGraphCorruption = true;
        store.db.prepare("UPDATE workspace_artifacts SET name = 'Raw graph drift' WHERE id = ?")
          .run(graphArtifact.id);
      }
      return originalApplyGraphCommands(...args);
    }) as typeof store.workspace.applyGraphCommands;

    const corruptGraph = await fetch(`${base}/api/projects/${graphProject.id}/workspace/graph/commands`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        baseGraphRevision: graphReady.graph.revision,
        expectedSnapshotId: graphReady.activeSnapshot.id,
        commands: [{ id: "rename-after-drift", type: "rename-node", nodeId: graphNode.id, name: "Renamed" }],
      }),
    });
    assert.equal(corruptGraph.status, 500);
    const graphState = store.db.prepare(`
      SELECT graph_revision AS graphRevision, active_snapshot_id AS activeSnapshotId
      FROM project_workspaces WHERE id = ?
    `).get(graphReady.workspace.id) as { graphRevision: number; activeSnapshotId: string };
    assert.equal(graphState.graphRevision, graphReady.graph.revision);
    assert.equal(graphState.activeSnapshotId, graphReady.activeSnapshot.id);
    assert.equal((store.db.prepare(`
      SELECT COUNT(*) AS count FROM workspace_snapshots WHERE workspace_id = ?
    `).get(graphReady.workspace.id) as { count: number }).count, graphReady.snapshots.length);
  });
});

test("Proposal validation-shaped failures never relabel durable corruption as 422", async () => {
  await withWorkspaceServer(async ({ base, store }) => {
    const project = store.createProject({ name: "Proposal corruption race", mode: "standard" });
    const ready = await readyWorkspace(base, project.id);
    const createResponse = await fetch(`${base}/api/projects/${project.id}/workspace/proposals`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(proposalCreateBody(ready, "corruption-race")),
    });
    const proposal = await createResponse.json() as { id: string };
    const artifact = store.workspace.getBundleByProjectId(project.id)!.artifacts[0]!;
    const originalApprove = store.workspace.approveProposalForProject.bind(store.workspace);
    let injected = false;
    store.workspace.approveProposalForProject = ((...args: Parameters<typeof originalApprove>) => {
      if (!injected) {
        injected = true;
        store.db.prepare("UPDATE workspace_artifacts SET name = 'Raw Proposal drift' WHERE id = ?")
          .run(artifact.id);
      }
      return originalApprove(...args);
    }) as typeof store.workspace.approveProposalForProject;

    const response = await fetch(
      `${base}/api/projects/${project.id}/workspace/proposals/${proposal.id}/approve`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode: "structure-only" }),
      },
    );
    assert.equal(response.status, 500);
    assert.notEqual((await response.json() as { code?: string }).code, "workspace_proposal_validation_error");
    assert.equal(store.workspace.getProposalForProject(project.id, proposal.id).status, "draft");
    assert.equal(workspaceProposalCounts(store, ready.workspace.id).plans, 0);
  });
});

test("Standard workspace migration verifies Git without changing Git or legacy rows", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "dezin-workspace-migration-"));
  const store = new Store(join(dataDir, "store.db"));
  const project = store.createProject({ name: "Legacy Standard", mode: "standard" });
  const conversation = store.createConversation(project.id, "Legacy");
  const variant = store.createVariant(project.id, "Main");
  store.setActiveVariant(project.id, variant.id);
  const root = join(dataDir, "projects", project.id);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "index.html"), "<main>Legacy</main>\n");
  git(root, ["init", "-b", "main"]);
  git(root, ["config", "user.name", "Dezin Test"]);
  git(root, ["config", "user.email", "dezin@example.test"]);
  git(root, ["add", "index.html"]);
  git(root, ["commit", "-m", "legacy snapshot"]);
  const commitHash = git(root, ["rev-parse", "HEAD"]);
  const run = store.createImportedRun(project.id, conversation.id, {
    variantId: variant.id,
    status: "succeeded",
    commitHash,
    createdAt: 100,
    finishedAt: 101,
    lintPassed: true,
    score: 100,
  });
  writeFileSync(join(root, "staged.txt"), "staged change\n");
  git(root, ["add", "staged.txt"]);
  writeFileSync(join(root, "index.html"), "<main>Unstaged legacy edit</main>\n");
  const legacyBefore = {
    project: store.db.prepare("SELECT * FROM projects WHERE id = ?").get(project.id),
    variants: store.db.prepare("SELECT * FROM variants WHERE project_id = ? ORDER BY id").all(project.id),
    runs: store.db.prepare("SELECT * FROM runs WHERE project_id = ? ORDER BY id").all(project.id),
  };
  const gitBefore = captureGit(root);

  const first = await ensureStandardProjectWorkspace({ store, dataDir }, project.id);
  const second = await ensureStandardProjectWorkspace({ store, dataDir }, project.id);

  assert.equal(first.status, "ready");
  assert.deepEqual(second, first);
  if (first.status !== "ready") assert.fail("expected ready Workspace");
  assert.deepEqual(first.artifacts.map((artifact) => [artifact.legacyWrapped, artifact.sourceRoot]), [[true, "."]]);
  assert.deepEqual(first.revisions.map((revision) => revision.legacyRunId), [run.id]);
  assert.deepEqual(captureGit(root), gitBefore);
  assert.deepEqual({
    project: store.db.prepare("SELECT * FROM projects WHERE id = ?").get(project.id),
    variants: store.db.prepare("SELECT * FROM variants WHERE project_id = ? ORDER BY id").all(project.id),
    runs: store.db.prepare("SELECT * FROM runs WHERE project_id = ? ORDER BY id").all(project.id),
  }, legacyBefore);
  assert.deepEqual(store.db.prepare("PRAGMA foreign_key_check").all(), []);
  store.close();
});

test("Prototype workspace migration is typed unsupported and changes no Workspace state", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "dezin-workspace-prototype-"));
  const store = new Store(join(dataDir, "store.db"));
  const project = store.createProject({ name: "Prototype", mode: "prototype" });
  store.workspace.ensureWorkspaceRecord(project.id);
  const before = {
    workspace: store.db.prepare("SELECT * FROM project_workspaces WHERE project_id = ?").get(project.id),
    graphs: store.db.prepare("SELECT * FROM workspace_graph_revisions ORDER BY revision").all(),
    snapshots: store.db.prepare("SELECT * FROM workspace_snapshots ORDER BY sequence").all(),
    artifacts: store.db.prepare("SELECT * FROM workspace_artifacts").all(),
  };
  let verified = 0;
  const result = await ensureStandardProjectWorkspace({ store, dataDir }, project.id, {
    afterVerification: () => { verified += 1; },
  });
  assert.deepEqual(result, {
    status: "unsupported",
    code: "workspace_requires_standard_project",
    projectId: project.id,
    projectMode: "prototype",
  });
  assert.equal(verified, 0);
  assert.deepEqual({
    workspace: store.db.prepare("SELECT * FROM project_workspaces WHERE project_id = ?").get(project.id),
    graphs: store.db.prepare("SELECT * FROM workspace_graph_revisions ORDER BY revision").all(),
    snapshots: store.db.prepare("SELECT * FROM workspace_snapshots ORDER BY sequence").all(),
    artifacts: store.db.prepare("SELECT * FROM workspace_artifacts").all(),
  }, before);
  store.close();
});

test("completed migration returns before Git verification even when the repository disappears", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "dezin-workspace-bypass-"));
  const store = new Store(join(dataDir, "store.db"));
  const project = store.createProject({ name: "Bypass", mode: "standard" });
  const root = join(dataDir, "projects", project.id);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "index.html"), "<main>Bypass</main>\n");
  git(root, ["init", "-b", "main"]);
  git(root, ["config", "user.name", "Dezin Test"]);
  git(root, ["config", "user.email", "dezin@example.test"]);
  git(root, ["add", "index.html"]);
  git(root, ["commit", "-m", "snapshot"]);
  const first = await ensureStandardProjectWorkspace({ store, dataDir }, project.id);
  renameSync(join(root, ".git"), join(root, ".git-gone"));
  const second = await ensureStandardProjectWorkspace({ store, dataDir }, project.id, {
    afterVerification: () => { throw new Error("Git verification was not bypassed"); },
  });
  assert.deepEqual(second, first);
  store.close();
});

test("a partial raw marker fails closed before Git verification", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "dezin-workspace-partial-marker-"));
  const store = new Store(join(dataDir, "store.db"));
  const project = store.createProject({ name: "Partial marker", mode: "standard" });
  const foundation = store.workspace.ensureWorkspaceRecord(project.id);
  store.db.prepare(
    `INSERT INTO workspace_artifacts (
       id, workspace_id, kind, name, source_root, legacy_wrapped,
       active_track_id, archived_at, created_at, updated_at
     ) VALUES ('partial-wrapper', ?, 'page', 'Partial', '.', 1, NULL, NULL, 10, 10)`,
  ).run(foundation.id);
  let verificationReached = false;

  await assert.rejects(
    ensureStandardProjectWorkspace({ store, dataDir }, project.id, {
      afterVerification: () => { verificationReached = true; },
    }),
    /completed legacy Workspace migration is invalid/i,
  );
  assert.equal(verificationReached, false);
  assert.equal(store.workspace.getWorkspace(project.id)?.graphRevision, 0);
  assert.equal(store.workspace.listArtifacts(project.id).length, 1);
  store.close();
});

test("migration retries a whole seed after verified legacy rows drift", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "dezin-workspace-drift-"));
  const store = new Store(join(dataDir, "store.db"));
  const project = store.createProject({ name: "Drift retry", mode: "standard" });
  const conversation = store.createConversation(project.id, "Drift");
  const variant = store.createVariant(project.id, "Before");
  const root = join(dataDir, "projects", project.id);
  mkdirSync(root, { recursive: true });
  git(root, ["init", "-b", "main"]);
  git(root, ["config", "user.name", "Dezin Test"]);
  git(root, ["config", "user.email", "dezin@example.test"]);
  writeFileSync(join(root, "index.html"), "commit A\n");
  git(root, ["add", "index.html"]);
  git(root, ["commit", "-m", "commit A"]);
  const commitA = git(root, ["rev-parse", "HEAD"]);
  writeFileSync(join(root, "index.html"), "commit B\n");
  git(root, ["add", "index.html"]);
  git(root, ["commit", "-m", "commit B"]);
  const commitB = git(root, ["rev-parse", "HEAD"]);
  const treeB = git(root, ["rev-parse", `${commitB}^{tree}`]);
  const run = store.createImportedRun(project.id, conversation.id, {
    variantId: variant.id,
    status: "succeeded",
    commitHash: commitA,
    createdAt: 10,
    finishedAt: 11,
  });
  let attempts = 0;
  const verifiedCommits: string[] = [];
  const result = await ensureStandardProjectWorkspace({ store, dataDir }, project.id, {
    afterVerification: (seed, attempt) => {
      attempts = attempt;
      const snapshot = seed.successfulRuns.find((candidate) => candidate.id === run.id)?.gitSnapshot;
      if (snapshot?.status === "verified") verifiedCommits.push(snapshot.sourceCommitHash);
      if (attempt === 1) {
        store.renameVariant(variant.id, "After");
        store.db.prepare("UPDATE runs SET commit_hash = ? WHERE id = ?").run(commitB, run.id);
      }
    },
  });
  assert.equal(result.status, "ready");
  assert.equal(attempts, 2);
  if (result.status !== "ready") assert.fail("expected ready Workspace");
  assert.deepEqual(verifiedCommits, [commitA, commitB]);
  assert.equal(result.tracks.find((track) => track.legacyVariantId === variant.id)?.name, "After");
  assert.equal(result.revisions[0]?.legacyRunId, run.id);
  assert.equal(result.revisions[0]?.sourceCommitHash, commitB);
  assert.equal(result.revisions[0]?.sourceTreeHash, treeB);
  assert.equal(result.snapshots.length, 2);
  assert.equal(result.artifacts.length, 1);
  store.close();
});

test("migration publishes valid successful Runs and omits only Runs whose Git objects are missing", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "dezin-workspace-mixed-runs-"));
  const store = new Store(join(dataDir, "store.db"));
  const project = store.createProject({ name: "Mixed Git objects", mode: "standard" });
  const conversation = store.createConversation(project.id, "Mixed");
  const variant = store.createVariant(project.id, "Main");
  const root = join(dataDir, "projects", project.id);
  mkdirSync(root, { recursive: true });
  git(root, ["init", "-b", "main"]);
  git(root, ["config", "user.name", "Dezin Test"]);
  git(root, ["config", "user.email", "dezin@example.test"]);
  writeFileSync(join(root, "index.html"), "available\n");
  git(root, ["add", "index.html"]);
  git(root, ["commit", "-m", "available"]);
  const availableCommit = git(root, ["rev-parse", "HEAD"]);
  const availableRun = store.createImportedRun(project.id, conversation.id, {
    variantId: variant.id,
    status: "succeeded",
    commitHash: availableCommit,
    createdAt: 10,
    finishedAt: 11,
  });
  const missingRun = store.createImportedRun(project.id, conversation.id, {
    variantId: variant.id,
    status: "succeeded",
    commitHash: "f".repeat(40),
    createdAt: 12,
    finishedAt: 13,
  });

  const result = await ensureStandardProjectWorkspace({ store, dataDir }, project.id);

  assert.equal(result.status, "ready");
  if (result.status !== "ready") assert.fail("expected ready Workspace");
  assert.deepEqual(result.revisions.map((revision) => revision.legacyRunId), [availableRun.id]);
  assert.equal(result.revisions[0]?.sourceCommitHash, availableCommit);
  assert.ok(!result.revisions.some((revision) => revision.legacyRunId === missingRun.id));
  store.close();
});

test("two Store connections converge on one legacy wrapper and one set of aliases", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "dezin-workspace-concurrent-"));
  const database = join(dataDir, "store.db");
  const firstStore = new Store(database);
  const project = firstStore.createProject({ name: "Concurrent", mode: "standard" });
  const conversation = firstStore.createConversation(project.id, "Concurrent");
  const variant = firstStore.createVariant(project.id, "Main");
  const root = join(dataDir, "projects", project.id);
  mkdirSync(root, { recursive: true });
  git(root, ["init", "-b", "main"]);
  git(root, ["config", "user.name", "Dezin Test"]);
  git(root, ["config", "user.email", "dezin@example.test"]);
  writeFileSync(join(root, "index.html"), "concurrent\n");
  git(root, ["add", "index.html"]);
  git(root, ["commit", "-m", "concurrent"]);
  const run = firstStore.createImportedRun(project.id, conversation.id, {
    variantId: variant.id,
    status: "succeeded",
    commitHash: git(root, ["rev-parse", "HEAD"]),
    createdAt: 10,
    finishedAt: 11,
  });
  const secondStore = new Store(database);

  const [first, second] = await Promise.all([
    ensureStandardProjectWorkspace({ store: firstStore, dataDir }, project.id),
    ensureStandardProjectWorkspace({ store: secondStore, dataDir }, project.id),
  ]);

  assert.equal(first.status, "ready");
  assert.equal(second.status, "ready");
  assert.deepEqual(second, first);
  assert.equal((firstStore.db.prepare(
    "SELECT COUNT(*) AS count FROM workspace_artifacts WHERE legacy_wrapped = 1",
  ).get() as { count: number }).count, 1);
  assert.deepEqual((firstStore.db.prepare(
    `SELECT legacy_variant_id, COUNT(*) AS count
     FROM artifact_tracks WHERE legacy_variant_id IS NOT NULL
     GROUP BY legacy_variant_id`,
  ).all() as Array<{ legacy_variant_id: string; count: number }>).map((row) => [row.legacy_variant_id, row.count]), [
    [variant.id, 1],
  ]);
  assert.deepEqual((firstStore.db.prepare(
    `SELECT legacy_run_id, COUNT(*) AS count
     FROM artifact_revisions WHERE legacy_run_id IS NOT NULL
     GROUP BY legacy_run_id`,
  ).all() as Array<{ legacy_run_id: string; count: number }>).map((row) => [row.legacy_run_id, row.count]), [
    [run.id, 1],
  ]);
  assert.deepEqual(firstStore.db.prepare("PRAGMA foreign_key_check").all(), []);
  secondStore.close();
  firstStore.close();
});

test("migration retries SQLITE_BUSY raised before seed capture", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "dezin-workspace-busy-"));
  const store = new Store(join(dataDir, "store.db"));
  const project = store.createProject({ name: "Busy retry", mode: "standard" });
  const original = store.workspace.getBundleByProjectId.bind(store.workspace);
  let reads = 0;
  store.workspace.getBundleByProjectId = ((projectId: string) => {
    reads += 1;
    if (reads === 1) throw Object.assign(new Error("busy"), { code: "ERR_SQLITE_ERROR", errcode: 5 });
    return original(projectId);
  }) as typeof store.workspace.getBundleByProjectId;
  const result = await ensureStandardProjectWorkspace({ store, dataDir }, project.id);
  assert.equal(result.status, "ready");
  assert.ok(reads >= 2);
  store.close();
});

test("Git verification ignores replace refs and hostile inherited Git selectors", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "dezin-workspace-replace-"));
  const store = new Store(join(dataDir, "store.db"));
  const project = store.createProject({ name: "Replace immunity", mode: "standard" });
  const conversation = store.createConversation(project.id, "Git");
  const variant = store.createVariant(project.id, "Main");
  const root = join(dataDir, "projects", project.id);
  mkdirSync(root, { recursive: true });
  git(root, ["init", "-b", "main"]);
  git(root, ["config", "user.name", "Dezin Test"]);
  git(root, ["config", "user.email", "dezin@example.test"]);
  writeFileSync(join(root, "index.html"), "first\n");
  git(root, ["add", "index.html"]);
  git(root, ["commit", "-m", "first"]);
  const originalCommit = git(root, ["rev-parse", "HEAD"]);
  const originalTree = git(root, ["--no-replace-objects", "rev-parse", `${originalCommit}^{tree}`]);
  writeFileSync(join(root, "index.html"), "replacement\n");
  git(root, ["add", "index.html"]);
  git(root, ["commit", "-m", "replacement"]);
  const replacementCommit = git(root, ["rev-parse", "HEAD"]);
  git(root, ["replace", originalCommit, replacementCommit]);
  store.createImportedRun(project.id, conversation.id, {
    variantId: variant.id,
    status: "succeeded",
    commitHash: originalCommit.slice(0, 12),
    createdAt: 10,
    finishedAt: 11,
  });
  const other = mkdtempSync(join(tmpdir(), "dezin-hostile-git-dir-"));
  git(other, ["init", "-b", "main"]);
  const oldGitDir = process.env.GIT_DIR;
  const oldConfigCount = process.env.GIT_CONFIG_COUNT;
  const oldConfigKey0 = process.env.GIT_CONFIG_KEY_0;
  const oldConfigValue0 = process.env.GIT_CONFIG_VALUE_0;
  process.env.GIT_DIR = join(other, ".git");
  process.env.GIT_CONFIG_COUNT = "1";
  process.env.GIT_CONFIG_KEY_0 = "core.worktree";
  process.env.GIT_CONFIG_VALUE_0 = other;
  try {
    const result = await ensureStandardProjectWorkspace({ store, dataDir }, project.id);
    assert.equal(result.status, "ready");
    if (result.status !== "ready") assert.fail("expected ready Workspace");
    assert.equal(result.revisions[0]?.sourceCommitHash, originalCommit);
    assert.equal(result.revisions[0]?.sourceTreeHash, originalTree);
  } finally {
    if (oldGitDir === undefined) delete process.env.GIT_DIR;
    else process.env.GIT_DIR = oldGitDir;
    if (oldConfigCount === undefined) delete process.env.GIT_CONFIG_COUNT;
    else process.env.GIT_CONFIG_COUNT = oldConfigCount;
    if (oldConfigKey0 === undefined) delete process.env.GIT_CONFIG_KEY_0;
    else process.env.GIT_CONFIG_KEY_0 = oldConfigKey0;
    if (oldConfigValue0 === undefined) delete process.env.GIT_CONFIG_VALUE_0;
    else process.env.GIT_CONFIG_VALUE_0 = oldConfigValue0;
    store.close();
  }
});

test("a project directory nested in a parent repository is not treated as its own Git snapshot", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "dezin-workspace-parent-git-"));
  git(dataDir, ["init", "-b", "main"]);
  git(dataDir, ["config", "user.name", "Dezin Test"]);
  git(dataDir, ["config", "user.email", "dezin@example.test"]);
  writeFileSync(join(dataDir, "parent.txt"), "parent\n");
  git(dataDir, ["add", "parent.txt"]);
  git(dataDir, ["commit", "-m", "parent"]);
  const parentCommit = git(dataDir, ["rev-parse", "HEAD"]);
  const store = new Store(join(dataDir, "store.db"));
  const project = store.createProject({ name: "Nested", mode: "standard" });
  const conversation = store.createConversation(project.id, "Nested");
  const variant = store.createVariant(project.id, "Main");
  mkdirSync(join(dataDir, "projects", project.id), { recursive: true });
  store.createImportedRun(project.id, conversation.id, {
    variantId: variant.id,
    status: "succeeded",
    commitHash: parentCommit,
    createdAt: 10,
    finishedAt: 11,
  });
  const result = await ensureStandardProjectWorkspace({ store, dataDir }, project.id);
  assert.equal(result.status, "ready");
  if (result.status !== "ready") assert.fail("expected ready Workspace");
  assert.equal(result.revisions.length, 0);
  store.close();
});

test("a project .git symlink cannot disguise a parent repository as an owned Git root", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "dezin-workspace-symlink-git-"));
  git(dataDir, ["init", "-b", "main"]);
  git(dataDir, ["config", "user.name", "Dezin Test"]);
  git(dataDir, ["config", "user.email", "dezin@example.test"]);
  writeFileSync(join(dataDir, "parent.txt"), "parent\n");
  git(dataDir, ["add", "parent.txt"]);
  git(dataDir, ["commit", "-m", "parent"]);
  const parentCommit = git(dataDir, ["rev-parse", "HEAD"]);
  const store = new Store(join(dataDir, "store.db"));
  const project = store.createProject({ name: "Symlinked parent", mode: "standard" });
  const conversation = store.createConversation(project.id, "Nested");
  const variant = store.createVariant(project.id, "Main");
  const root = join(dataDir, "projects", project.id);
  mkdirSync(root, { recursive: true });
  symlinkSync(join(dataDir, ".git"), join(root, ".git"), "dir");
  store.createImportedRun(project.id, conversation.id, {
    variantId: variant.id,
    status: "succeeded",
    commitHash: parentCommit,
    createdAt: 10,
    finishedAt: 11,
  });

  const result = await ensureStandardProjectWorkspace({ store, dataDir }, project.id);

  assert.equal(result.status, "ready");
  if (result.status !== "ready") assert.fail("expected ready Workspace");
  assert.equal(result.revisions.length, 0);
  store.close();
});
