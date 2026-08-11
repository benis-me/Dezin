import { render, screen, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vitest";

import type { DesignCanvasApi } from "./api.ts";
import {
  readExactVersionMetadata,
  useExactVersionMetadata,
} from "./exact-version-metadata.ts";
import type { DesignNodeVersion } from "./types.ts";

const PROJECT_ID = "metadata-cache-project";

function version(nodeId: string, versionId: string): DesignNodeVersion {
  return {
    id: versionId,
    nodeId,
    sequence: 1,
    contentKind: "html",
    assetId: null,
    mimeType: "text/html",
    fileName: "index.html",
    checksum: nodeId.padEnd(64, "0").slice(0, 64),
    bytes: 128,
    contextHash: versionId.padEnd(64, "0").slice(0, 64),
    jobId: null,
    runnerId: null,
    model: null,
    createdAt: 1,
  };
}

function MetadataProbe({ api, index }: { api: DesignCanvasApi; index: number }) {
  const nodeId = `node-${index}`;
  const versionId = `version-${index}`;
  const snapshot = useExactVersionMetadata({ api, projectId: PROJECT_ID, nodeId, versionId });
  return <output aria-label="metadata status">{snapshot.status}:{snapshot.metadata?.id ?? "none"}</output>;
}

test("exact Version metadata keeps a bounded least-recently-used history", async () => {
  const listNodeVersions = vi.fn(async (_projectId: string, nodeId: string) => {
    const index = nodeId.slice("node-".length);
    return [version(nodeId, `version-${index}`)];
  });
  const api = { listNodeVersions } as unknown as DesignCanvasApi;
  const rendered = render(<MetadataProbe api={api} index={0} />);

  for (let index = 0; index < 140; index += 1) {
    rendered.rerender(<MetadataProbe api={api} index={index} />);
    await waitFor(() => expect(screen.getByLabelText("metadata status")).toHaveTextContent(`ready:version-${index}`));
  }

  expect(listNodeVersions).toHaveBeenCalledTimes(140);
  expect(readExactVersionMetadata({
    api,
    projectId: PROJECT_ID,
    nodeId: "node-0",
    versionId: "version-0",
  })).toBeNull();
  expect(readExactVersionMetadata({
    api,
    projectId: PROJECT_ID,
    nodeId: "node-139",
    versionId: "version-139",
  })?.id).toBe("version-139");
});
