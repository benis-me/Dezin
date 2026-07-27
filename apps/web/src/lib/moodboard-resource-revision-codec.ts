import type {
  MoodboardDirectionContractView,
  MoodboardResourceRevisionContentView,
  MoodboardRevisionAssetView,
  MoodboardRevisionNodeView,
} from "./api.ts";

const DIRECTION_PROTOCOL = "dezin.moodboard-direction-contract.v1" as const;

function codecRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function codecExactRecord(
  value: unknown,
  allowedKeys: readonly string[],
  label: string,
): Record<string, unknown> {
  const record = codecRecord(value, label);
  const allowed = new Set(allowedKeys);
  const unsupported = Object.keys(record).find((key) => !allowed.has(key));
  if (unsupported) throw new TypeError(`${label} contains unsupported field ${unsupported}`);
  return record;
}

function codecString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value;
}

function codecNullableString(value: unknown, label: string): string | null {
  return value === null ? null : codecString(value, label);
}

function codecInteger(value: unknown, label: string, minimum = 0): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) {
    throw new TypeError(`${label} must be a safe integer >= ${minimum}`);
  }
  return value;
}

function codecFiniteNullable(value: unknown, label: string): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`${label} must be finite or null`);
  }
  return value;
}

function codecArray(value: unknown, label: string, maximum: number): unknown[] {
  if (!Array.isArray(value) || value.length > maximum) {
    throw new TypeError(`${label} must be a bounded array`);
  }
  return value;
}

function codecBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new TypeError(`${label} must be a boolean`);
  return value;
}

function codecSha256(value: unknown, label: string): string {
  const checksum = codecString(value, label);
  if (!/^[a-f0-9]{64}$/.test(checksum)) {
    throw new TypeError(`${label} must be a SHA-256 checksum`);
  }
  return checksum;
}

function codecApiPath(value: unknown, label: string): string {
  const path = codecString(value, label);
  if (!path.startsWith("/api/") || path.includes("\\") || /[\u0000-\u001f\u007f]/.test(path)) {
    throw new TypeError(`${label} must be a daemon API path`);
  }
  return path;
}

function decodeDirectionContract(
  value: unknown,
  assets: readonly MoodboardRevisionAssetView[],
): MoodboardDirectionContractView {
  const contract = codecExactRecord(
    value,
    ["protocol", "contextPackId", "checksum", "directions"],
    "Moodboard Revision direction contract",
  );
  if (contract.protocol !== DIRECTION_PROTOCOL) {
    throw new TypeError("Moodboard Revision direction contract protocol is unsupported");
  }

  const directionIds = new Set<string>();
  const directions = codecArray(
    contract.directions,
    "Moodboard Revision contract directions",
    1_024,
  ).map((raw, index) => {
    const label = `Moodboard Revision contract direction ${index}`;
    const direction = codecExactRecord(
      raw,
      ["resourceId", "revisionId", "id", "title", "checksum", "assetId"],
      label,
    );
    const id = codecString(direction.id, `${label} id`);
    if (directionIds.has(id)) {
      throw new TypeError(`Moodboard Revision contract direction ${id} is duplicated`);
    }
    directionIds.add(id);
    return {
      resourceId: codecString(direction.resourceId, `${label} Resource id`),
      revisionId: codecString(direction.revisionId, `${label} Revision id`),
      id,
      title: codecString(direction.title, `${label} title`),
      checksum: codecSha256(direction.checksum, `${label} checksum`),
      assetId: codecString(direction.assetId, `${label} Asset id`),
    };
  });
  if (directions.length === 0) {
    throw new TypeError("Moodboard Revision direction contract is empty");
  }

  const decoded: MoodboardDirectionContractView = {
    protocol: DIRECTION_PROTOCOL,
    contextPackId: codecString(
      contract.contextPackId,
      "Moodboard Revision direction contract Context Pack id",
    ),
    checksum: codecSha256(
      contract.checksum,
      "Moodboard Revision direction contract checksum",
    ),
    directions,
  };

  if (assets.length !== directions.length) {
    throw new TypeError("Moodboard Revision direction contract cardinality is inconsistent");
  }
  const directionsById = new Map(directions.map((direction) => [direction.id, direction]));
  const assetsById = new Map(assets.map((asset) => [asset.id, asset]));
  const assignedDirectionIds = new Set<string>();
  for (const asset of assets) {
    const directionId = asset.directionId;
    if (directionId === undefined
      || directionId === null
      || assignedDirectionIds.has(directionId)) {
      throw new TypeError("Moodboard Revision direction assignment is missing or duplicated");
    }
    const direction = directionsById.get(directionId);
    if (direction === undefined
      || asset.directionTitle !== direction.title
      || asset.directionChecksum !== direction.checksum) {
      throw new TypeError(`Moodboard Revision Asset ${asset.id} direction assignment is invalid`);
    }
    assignedDirectionIds.add(directionId);
  }

  const projectedAssetIds = new Set<string>();
  for (const direction of directions) {
    const asset = assetsById.get(direction.assetId);
    if (asset === undefined
      || projectedAssetIds.has(direction.assetId)
      || asset.url === null
      || asset.directionId !== direction.id
      || asset.directionTitle !== direction.title
      || asset.directionChecksum !== direction.checksum) {
      throw new TypeError(
        `Moodboard Revision contract direction ${direction.id} has no exact displayable Asset`,
      );
    }
    projectedAssetIds.add(direction.assetId);
  }

  return decoded;
}

export function decodeMoodboardResourceRevisionContent(
  value: unknown,
): MoodboardResourceRevisionContentView {
  const input = codecExactRecord(value, [
    "board",
    "nodes",
    "assets",
    "totalNodeCount",
    "totalAssetCount",
    "nodesTruncated",
    "assetsTruncated",
  ], "Moodboard Revision content");
  const board = codecExactRecord(
    input.board,
    ["id", "name", "coverAssetId", "directionContract"],
    "Moodboard Revision board",
  );
  const nodes = codecArray(input.nodes, "Moodboard Revision nodes", 256)
    .map((raw, index): MoodboardRevisionNodeView => {
      const node = codecExactRecord(raw, [
        "id",
        "type",
        "label",
        "text",
        "x",
        "y",
        "width",
        "height",
        "assetId",
      ], `Moodboard Revision node ${index}`);
      return {
        id: codecString(node.id, `Moodboard Revision node ${index} id`),
        type: codecString(node.type, `Moodboard Revision node ${index} type`),
        label: typeof node.label === "string"
          ? node.label
          : (() => {
              throw new TypeError(`Moodboard Revision node ${index} label must be a string`);
            })(),
        text: typeof node.text === "string"
          ? node.text
          : (() => {
              throw new TypeError(`Moodboard Revision node ${index} text must be a string`);
            })(),
        x: codecFiniteNullable(node.x, `Moodboard Revision node ${index} x`),
        y: codecFiniteNullable(node.y, `Moodboard Revision node ${index} y`),
        width: codecFiniteNullable(node.width, `Moodboard Revision node ${index} width`),
        height: codecFiniteNullable(node.height, `Moodboard Revision node ${index} height`),
        assetId: codecNullableString(node.assetId, `Moodboard Revision node ${index} assetId`),
      };
    });
  const assets = codecArray(input.assets, "Moodboard Revision Assets", 128)
    .map((raw, index): MoodboardRevisionAssetView => {
      const asset = codecExactRecord(raw, [
        "id",
        "kind",
        "fileName",
        "mimeType",
        "width",
        "height",
        "byteLength",
        "checksum",
        "url",
        "downloadUrl",
        "directionId",
        "directionTitle",
        "directionChecksum",
      ], `Moodboard Revision Asset ${index}`);
      const hasDirectionId = asset.directionId !== undefined && asset.directionId !== null;
      const hasDirectionTitle = asset.directionTitle !== undefined && asset.directionTitle !== null;
      const hasDirectionChecksum = asset.directionChecksum !== undefined
        && asset.directionChecksum !== null;
      if (hasDirectionId !== hasDirectionTitle || hasDirectionId !== hasDirectionChecksum) {
        throw new TypeError(`Moodboard Revision Asset ${index} direction assignment is incomplete`);
      }
      return {
        id: codecString(asset.id, `Moodboard Revision Asset ${index} id`),
        kind: codecString(asset.kind, `Moodboard Revision Asset ${index} kind`),
        fileName: codecString(asset.fileName, `Moodboard Revision Asset ${index} fileName`),
        mimeType: codecString(asset.mimeType, `Moodboard Revision Asset ${index} MIME`),
        width: codecFiniteNullable(asset.width, `Moodboard Revision Asset ${index} width`),
        height: codecFiniteNullable(asset.height, `Moodboard Revision Asset ${index} height`),
        byteLength: codecInteger(asset.byteLength, `Moodboard Revision Asset ${index} byteLength`),
        checksum: codecSha256(asset.checksum, `Moodboard Revision Asset ${index} checksum`),
        url: asset.url === null
          ? null
          : codecApiPath(asset.url, `Moodboard Revision Asset ${index} URL`),
        downloadUrl: codecApiPath(
          asset.downloadUrl,
          `Moodboard Revision Asset ${index} download URL`,
        ),
        directionId: hasDirectionId
          ? codecString(asset.directionId, `Moodboard Revision Asset ${index} direction id`)
          : null,
        directionTitle: hasDirectionTitle
          ? codecString(asset.directionTitle, `Moodboard Revision Asset ${index} direction title`)
          : null,
        directionChecksum: hasDirectionChecksum
          ? codecSha256(
              asset.directionChecksum,
              `Moodboard Revision Asset ${index} direction checksum`,
            )
          : null,
      };
    });
  const directionContract = board.directionContract === undefined || board.directionContract === null
    ? null
    : decodeDirectionContract(board.directionContract, assets);
  if (directionContract === null && assets.some((asset) => asset.directionId !== null)) {
    throw new TypeError("Moodboard Revision Assets cannot declare directions without a contract");
  }

  const totalNodeCount = codecInteger(input.totalNodeCount, "Moodboard Revision totalNodeCount");
  const totalAssetCount = codecInteger(input.totalAssetCount, "Moodboard Revision totalAssetCount");
  const nodesTruncated = codecBoolean(input.nodesTruncated, "Moodboard Revision nodesTruncated");
  const assetsTruncated = codecBoolean(input.assetsTruncated, "Moodboard Revision assetsTruncated");
  if (totalNodeCount < nodes.length || totalAssetCount < assets.length
    || nodesTruncated !== (totalNodeCount > nodes.length)
    || assetsTruncated !== (totalAssetCount > assets.length)) {
    throw new TypeError("Moodboard Revision projection counts are inconsistent");
  }

  return {
    board: {
      id: codecString(board.id, "Moodboard Revision board id"),
      name: codecString(board.name, "Moodboard Revision board name"),
      coverAssetId: codecNullableString(
        board.coverAssetId,
        "Moodboard Revision board coverAssetId",
      ),
      directionContract,
    },
    nodes,
    assets,
    totalNodeCount,
    totalAssetCount,
    nodesTruncated,
    assetsTruncated,
  };
}
