import assert from "node:assert/strict";
import test from "node:test";

import {
  createProductionPublicAddressResolver,
} from "../src/production-public-address-resolver.ts";
import {
  createProductionSafeBoundedExternalFetcher,
  type ProductionExternalFetchHop,
} from "../src/production-safe-external-fetch.ts";
import { EXTERNAL_REFERENCE_FETCH_POLICY } from "../src/resource-revision-source.ts";

function dohResponse(name: string, type: 1 | 28, answers: string[]): Response {
  return new Response(JSON.stringify({
    Status: 0,
    Question: [{ name, type }],
    Answer: answers.map((data) => ({ name, type, TTL: 300, data })),
  }), {
    status: 200,
    headers: { "content-type": "application/dns-json" },
  });
}

test("production external fetch replaces an all-Fake-IP DNS answer with bounded verified public DNS before pinning", async () => {
  const dohRequests: Array<{
    name: string;
    type: string;
    redirect: "follow" | "error" | "manual" | undefined;
  }> = [];
  const resolveAddresses = createProductionPublicAddressResolver({
    systemResolve: async () => [{ address: "198.18.2.90", family: 4 }],
    fetchDoh: async (input, init) => {
      const url = new URL(String(input));
      const name = url.searchParams.get("name")!;
      const type = url.searchParams.get("type")!;
      dohRequests.push({ name, type, redirect: init?.redirect });
      return type === "A"
        ? dohResponse(name, 1, ["23.32.13.191"])
        : dohResponse(name, 28, []);
    },
  });
  const hops: ProductionExternalFetchHop[] = [];
  const fetchExternal = createProductionSafeBoundedExternalFetcher({
    resolveAddresses,
    requestHop: async (hop) => {
      hops.push(hop);
      return {
        status: 200,
        mimeType: "text/html; charset=utf-8",
        bytes: Buffer.from("verified evidence", "utf8"),
        location: null,
        remoteAddress: hop.pinnedAddress.address,
      };
    },
  });

  const result = await fetchExternal({
    url: "https://design.cms.gov/",
    ...EXTERNAL_REFERENCE_FETCH_POLICY,
    signal: new AbortController().signal,
  });

  assert.equal(result.status, 200);
  assert.deepEqual(dohRequests, [
    { name: "design.cms.gov", type: "A", redirect: "error" },
    { name: "design.cms.gov", type: "AAAA", redirect: "error" },
  ]);
  assert.equal(hops.length, 1);
  assert.deepEqual(hops[0]!.pinnedAddress, { address: "23.32.13.191", family: 4 });
});

test("production public DNS accepts only addresses reached through the bounded question CNAME chain", async () => {
  const resolver = createProductionPublicAddressResolver({
    systemResolve: async () => [{ address: "198.18.4.20", family: 4 }],
    fetchDoh: async (input) => {
      const url = new URL(String(input));
      const name = url.searchParams.get("name")!;
      const type = url.searchParams.get("type")!;
      return new Response(JSON.stringify({
        Status: 0,
        Question: [{ name, type: type === "A" ? 1 : 28 }],
        Answer: type === "A"
          ? [
              { name, type: 5, TTL: 300, data: "edge.cdn.example.net." },
              { name: "edge.cdn.example.net.", type: 1, TTL: 300, data: "93.184.216.34" },
            ]
          : [],
      }), {
        status: 200,
        headers: { "content-type": "application/dns-json" },
      });
    },
  });

  assert.deepEqual(
    await resolver("assets.dezin-design.dev", new AbortController().signal),
    [{ address: "93.184.216.34", family: 4 }],
  );
});

test("production Fake-IP fallback never returns private DoH answers or bypasses non-Fake private DNS", async () => {
  for (const [systemAddress, dohAddress, expectedDohCalls] of [
    ["198.18.9.1", "127.0.0.1", 2],
    ["10.0.0.8", "93.184.216.34", 0],
  ] as const) {
    let dohCalls = 0;
    let socketCalls = 0;
    const resolver = createProductionPublicAddressResolver({
      systemResolve: async () => [{ address: systemAddress, family: 4 }],
      fetchDoh: async (input) => {
        dohCalls += 1;
        const url = new URL(String(input));
        const name = url.searchParams.get("name")!;
        const type = url.searchParams.get("type")!;
        return type === "A"
          ? dohResponse(name, 1, [dohAddress])
          : dohResponse(name, 28, []);
      },
    });
    const fetchExternal = createProductionSafeBoundedExternalFetcher({
      resolveAddresses: resolver,
      requestHop: async () => {
        socketCalls += 1;
        throw new Error("private target must not open a socket");
      },
    });

    await assert.rejects(() => fetchExternal({
      url: "https://private-target.dezin-design.dev/admin",
      ...EXTERNAL_REFERENCE_FETCH_POLICY,
      signal: new AbortController().signal,
    }), /private|special-purpose/i);
    assert.equal(dohCalls, expectedDohCalls);
    assert.equal(socketCalls, 0);
  }
});
