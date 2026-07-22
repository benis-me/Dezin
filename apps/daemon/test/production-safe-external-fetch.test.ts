import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Store } from "../../../packages/core/src/index.ts";
import { createApp, createRuntimeSupervisor } from "../src/app.ts";
import { EXTERNAL_REFERENCE_FETCH_POLICY } from "../src/resource-revision-source.ts";
import {
  createProductionSafeBoundedExternalFetcher,
  productionSafeExternalFetchTestSeams,
  type ProductionExternalFetchHop,
} from "../src/production-safe-external-fetch.ts";

test("production external fetch resolves one public address and pins the HTTP hop to it", async () => {
  const hops: ProductionExternalFetchHop[] = [];
  const fetchExternal = createProductionSafeBoundedExternalFetcher({
    resolveAddresses: async (hostname) => {
      assert.equal(hostname, "evidence.dezin-design.dev");
      return [{ address: "93.184.216.34", family: 4 }];
    },
    requestHop: async (hop) => {
      hops.push(hop);
      return {
        status: 200,
        mimeType: "text/html; charset=utf-8",
        bytes: Buffer.from("verified public evidence", "utf8"),
        location: null,
        remoteAddress: "93.184.216.34",
      };
    },
  });
  const signal = new AbortController().signal;

  const result = await fetchExternal({
    url: "https://evidence.dezin-design.dev/design-systems?version=2",
    ...EXTERNAL_REFERENCE_FETCH_POLICY,
    signal,
  });

  assert.deepEqual(result, {
    finalUrl: "https://evidence.dezin-design.dev/design-systems?version=2",
    status: 200,
    mimeType: "text/html; charset=utf-8",
    bytes: Buffer.from("verified public evidence", "utf8"),
  });
  assert.equal(hops.length, 1);
  assert.equal(hops[0]!.url.hostname, "evidence.dezin-design.dev");
  assert.deepEqual(hops[0]!.pinnedAddress, { address: "93.184.216.34", family: 4 });
  assert.equal(hops[0]!.signal.aborted, false);
  assert.equal(hops[0]!.maxBytes, EXTERNAL_REFERENCE_FETCH_POLICY.maxBytes);
});

test("production external fetch rejects private and mixed DNS answers before opening a socket", async () => {
  for (const addresses of [
    [{ address: "127.0.0.1", family: 4 as const }],
    [
      { address: "93.184.216.34", family: 4 as const },
      { address: "10.0.0.8", family: 4 as const },
    ],
    [{ address: "::1", family: 6 as const }],
  ]) {
    let requests = 0;
    const fetchExternal = createProductionSafeBoundedExternalFetcher({
      resolveAddresses: async () => addresses,
      requestHop: async () => {
        requests += 1;
        throw new Error("unsafe transport must not run");
      },
    });

    await assert.rejects(() => fetchExternal({
      url: "https://private-target.dezin-design.dev/admin",
      ...EXTERNAL_REFERENCE_FETCH_POLICY,
      signal: new AbortController().signal,
    }), /private|special-purpose/i);
    assert.equal(requests, 0);
  }
});

test("production external fetch revalidates every redirect and blocks a public-to-private DNS bypass", async () => {
  const requestedHosts: string[] = [];
  const fetchExternal = createProductionSafeBoundedExternalFetcher({
    resolveAddresses: async (hostname) => hostname === "public.dezin-design.dev"
      ? [{ address: "93.184.216.34", family: 4 }]
      : [{ address: "169.254.169.254", family: 4 }],
    requestHop: async (hop) => {
      requestedHosts.push(hop.url.hostname);
      return {
        status: 302,
        mimeType: "text/plain",
        bytes: Buffer.alloc(0),
        location: "http://metadata.dezin-design.dev/latest/meta-data/",
        remoteAddress: hop.pinnedAddress.address,
      };
    },
  });

  await assert.rejects(() => fetchExternal({
    url: "https://public.dezin-design.dev/evidence",
    ...EXTERNAL_REFERENCE_FETCH_POLICY,
    signal: new AbortController().signal,
  }), /private|special-purpose/i);
  assert.deepEqual(requestedHosts, ["public.dezin-design.dev"]);
});

test("production external fetch rejects an oversized redirect body before following it", async () => {
  let requests = 0;
  const fetchExternal = createProductionSafeBoundedExternalFetcher({
    resolveAddresses: async () => [{ address: "93.184.216.34", family: 4 }],
    requestHop: async (hop) => {
      requests += 1;
      return {
        status: 302,
        mimeType: "text/plain",
        bytes: Buffer.alloc(hop.maxBytes + 1),
        location: "https://next.dezin-design.dev/evidence",
        remoteAddress: hop.pinnedAddress.address,
      };
    },
  });

  await assert.rejects(() => fetchExternal({
    url: "https://public.dezin-design.dev/evidence",
    ...EXTERNAL_REFERENCE_FETCH_POLICY,
    maxBytes: 32,
    signal: new AbortController().signal,
  }), /invalid|byte|budget/i);
  assert.equal(requests, 1);
});

test("default production HTTP hop aborts a streaming redirect body at the byte limit", async (t) => {
  let requests = 0;
  const server = createServer((_request, response) => {
    requests += 1;
    response.writeHead(302, {
      location: "https://next.dezin-design.dev/evidence",
      "content-type": "text/plain",
    });
    response.write(Buffer.alloc(24, 0x61));
    response.write(Buffer.alloc(24, 0x62));
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  await assert.rejects(() => productionSafeExternalFetchTestSeams.requestHop({
    url: new URL(`http://public.dezin-design.dev:${port}/redirect`),
    pinnedAddress: { address: "127.0.0.1", family: 4 },
    maxBytes: 32,
    signal: new AbortController().signal,
  }), /byte budget/i);
  assert.equal(requests, 1);
});

test("production external fetch enforces the byte and wall-clock budgets around its transport", async () => {
  const oversized = createProductionSafeBoundedExternalFetcher({
    resolveAddresses: async () => [{ address: "93.184.216.34", family: 4 }],
    requestHop: async (hop) => ({
      status: 200,
      mimeType: "text/plain",
      bytes: Buffer.alloc(hop.maxBytes + 1),
      location: null,
      remoteAddress: hop.pinnedAddress.address,
    }),
  });
  await assert.rejects(() => oversized({
    url: "https://public.dezin-design.dev/evidence",
    ...EXTERNAL_REFERENCE_FETCH_POLICY,
    signal: new AbortController().signal,
  }), /invalid|byte|budget/i);

  const stalled = createProductionSafeBoundedExternalFetcher({
    resolveAddresses: async () => [{ address: "93.184.216.34", family: 4 }],
    requestHop: async () => await new Promise(() => {}),
  });
  await assert.rejects(() => stalled({
    url: "https://public.dezin-design.dev/evidence",
    ...EXTERNAL_REFERENCE_FETCH_POLICY,
    timeoutMs: 20,
    signal: new AbortController().signal,
  }), (error: unknown) => error instanceof DOMException && error.name === "TimeoutError");
});

test("Resource import HTTP consumes the shared production external fetch boundary", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "dezin-production-external-import-"));
  const store = new Store(join(root, "store.db"));
  const runtimeSupervisor = createRuntimeSupervisor({ store, dataDir: root });
  let requested = 0;
  const resourceExternalFetch = createProductionSafeBoundedExternalFetcher({
    resolveAddresses: async () => [{ address: "93.184.216.34", family: 4 }],
    requestHop: async (hop) => {
      requested += 1;
      return {
        status: 200,
        mimeType: "text/plain",
        bytes: Buffer.from("immutable imported evidence", "utf8"),
        location: null,
        remoteAddress: hop.pinnedAddress.address,
      };
    },
  });
  const server = createApp({ store, dataDir: root, runtimeSupervisor, resourceExternalFetch });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;
  t.after(async () => {
    await runtimeSupervisor.shutdown();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const project = store.createProject({ name: "External import composition", mode: "standard" });
  const workspaceResponse = await fetch(`${base}/api/projects/${project.id}/workspace`);
  assert.equal(workspaceResponse.status, 200);
  const workspace = await workspaceResponse.json() as {
    graph: { revision: number };
    activeSnapshot: { id: string };
  };
  const createResponse = await fetch(`${base}/api/projects/${project.id}/resources`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      kind: "external-reference",
      title: "Imported evidence",
      defaultPinPolicy: "pin-current",
      baseGraphRevision: workspace.graph.revision,
      expectedSnapshotId: workspace.activeSnapshot.id,
    }),
  });
  assert.equal(createResponse.status, 201);
  const created = await createResponse.json() as { resource: { id: string; headRevisionId: null } };

  const revisionResponse = await fetch(
    `${base}/api/projects/${project.id}/resources/${created.resource.id}/revisions`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        expectedHeadRevisionId: null,
        source: {
          type: "external-reference",
          url: "https://evidence.dezin-design.dev/reference.txt",
        },
      }),
    },
  );
  const revision = await revisionResponse.json() as {
    metadata: { byteSize: number; mimeType: string };
    provenance: { fetchBoundary: string; finalUrl: string };
    error?: string;
  };
  assert.equal(revisionResponse.status, 201, revision.error ?? "external Resource revision was not created");
  assert.equal(requested, 1);
  assert.equal(revision.metadata.byteSize, Buffer.byteLength("immutable imported evidence"));
  assert.equal(revision.metadata.mimeType, "text/plain");
  assert.equal(revision.provenance.fetchBoundary, "injected-bounded-representation");
  assert.equal(revision.provenance.finalUrl, "https://evidence.dezin-design.dev/reference.txt");
});
