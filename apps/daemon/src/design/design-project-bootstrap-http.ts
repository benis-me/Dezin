import type { IncomingMessage, ServerResponse } from "node:http";
import {
  DESIGN_NODE_KINDS,
  type DesignCanvasAssetImportItem,
  type DesignNodeGeometry,
  type DesignProjectBootstrapInput,
} from "@dezin/design-canvas-contracts";

import { HttpError, readJsonBody, sendJson } from "../http-util.ts";
import {
  bootstrapDesignProject,
  DesignProjectBootstrapError,
  type DesignProjectBootstrapPorts,
} from "./design-project-bootstrap.ts";
import {
  designProjectPayload,
  ensureDesignProjectAtId,
  getDesignProject,
} from "./design-project-store.ts";
import {
  MAX_DESIGN_ASSET_BATCH_BYTES,
  MAX_DESIGN_ASSET_BATCH_ITEMS,
  MAX_DESIGN_ASSET_BYTES,
} from "./design-storage.ts";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export type DesignProjectBootstrapExecutionPorts = Pick<
  DesignProjectBootstrapPorts,
  "ensureAssetBatch" | "ensureMainTurn"
>;

export interface DesignProjectBootstrapHttpDeps {
  dataDir: string;
  designProjectBootstrapPorts?: DesignProjectBootstrapExecutionPorts;
}

function exactRecord(value: unknown, label: string, fields: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, `${label} must be an object`);
  }
  const record = value as Record<string, unknown>;
  const unexpected = Object.keys(record).find((field) => !fields.includes(field));
  if (unexpected) throw new HttpError(400, `${label} contains unexpected field: ${unexpected}`);
  return record;
}

function string(value: unknown, label: string, maxBytes: number, allowEmpty = false): string {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > maxBytes
    || (!allowEmpty && !value.trim())) {
    throw new HttpError(400, `${label} is invalid`);
  }
  return value;
}

function identifier(value: unknown, label: string): string {
  const result = string(value, label, 128);
  if (!SAFE_ID.test(result)) throw new HttpError(400, `${label} is invalid`);
  return result;
}

function assetImportItem(value: unknown, index: number): DesignCanvasAssetImportItem {
  const label = `Design Project bootstrap item ${index}`;
  const item = exactRecord(value, label, ["asset", "binding"]);
  const asset = exactRecord(item.asset, `${label}.asset`, ["name", "mimeType", "base64", "sourceVersion"]);
  const hasBase64 = asset.base64 !== undefined;
  const hasSourceVersion = asset.sourceVersion !== undefined;
  if (Number(hasBase64) + Number(hasSourceVersion) !== 1) {
    throw new HttpError(400, `${label}.asset must have exactly one source`);
  }
  const name = string(asset.name, `${label}.asset.name`, 240);
  const mimeType = string(asset.mimeType, `${label}.asset.mimeType`, 120);
  let parsedAsset: DesignCanvasAssetImportItem["asset"];
  if (hasBase64) {
    parsedAsset = {
      name,
      mimeType,
      base64: string(
        asset.base64,
        `${label}.asset.base64`,
        Math.ceil(MAX_DESIGN_ASSET_BYTES * 4 / 3) + 4,
      ),
    };
  } else {
    const source = exactRecord(asset.sourceVersion, `${label}.asset.sourceVersion`, [
      "projectId", "nodeId", "versionId",
    ]);
    parsedAsset = {
      name,
      mimeType,
      sourceVersion: {
        projectId: identifier(source.projectId, `${label}.asset.sourceVersion.projectId`),
        nodeId: identifier(source.nodeId, `${label}.asset.sourceVersion.nodeId`),
        versionId: identifier(source.versionId, `${label}.asset.sourceVersion.versionId`),
      },
    };
  }

  const binding = exactRecord(item.binding, `${label}.binding`, ["type", "node", "nodeId"]);
  const type = string(binding.type, `${label}.binding.type`, 32);
  if (type === "append-version") {
    if (binding.node !== undefined) {
      throw new HttpError(400, `${label}.binding.node is only valid for create-node`);
    }
    return {
      asset: parsedAsset,
      binding: {
        type,
        nodeId: identifier(binding.nodeId, `${label}.binding.nodeId`),
      },
    };
  }
  if (type !== "create-node") throw new HttpError(400, `${label}.binding.type is unsupported`);
  if (binding.nodeId !== undefined) {
    throw new HttpError(400, `${label}.binding.nodeId is only valid for append-version`);
  }
  const node = exactRecord(binding.node, `${label}.binding.node`, ["id", "kind", "name", "geometry"]);
  const kind = string(node.kind, `${label}.binding.node.kind`, 64);
  if (!(DESIGN_NODE_KINDS as readonly string[]).includes(kind)) {
    throw new HttpError(400, `${label}.binding.node.kind is unsupported`);
  }
  let geometry: Partial<DesignNodeGeometry> | undefined;
  if (node.geometry !== undefined) {
    const raw = exactRecord(node.geometry, `${label}.binding.node.geometry`, ["x", "y", "width", "height"]);
    for (const [field, coordinate] of Object.entries(raw)) {
      if (typeof coordinate !== "number" || !Number.isFinite(coordinate)) {
        throw new HttpError(400, `${label}.binding.node.geometry.${field} is invalid`);
      }
    }
    geometry = raw as Partial<DesignNodeGeometry>;
  }
  return {
    asset: parsedAsset,
    binding: {
      type,
      node: {
        ...(node.id === undefined ? {} : { id: identifier(node.id, `${label}.binding.node.id`) }),
        kind: kind as (typeof DESIGN_NODE_KINDS)[number],
        ...(node.name === undefined ? {} : { name: string(node.name, `${label}.binding.node.name`, 240) }),
        ...(geometry === undefined ? {} : { geometry }),
      },
    },
  };
}

function bootstrapBody(value: unknown): DesignProjectBootstrapInput {
  const body = exactRecord(value, "Design Project bootstrap", [
    "schemaVersion", "idempotencyKey", "name", "prompt", "items", "agent",
  ]);
  if (body.schemaVersion !== 1 || !Array.isArray(body.items) || body.items.length > MAX_DESIGN_ASSET_BATCH_ITEMS) {
    throw new HttpError(400, "Design Project bootstrap is invalid");
  }
  let agent: DesignProjectBootstrapInput["agent"];
  if (body.agent !== undefined) {
    const selection = exactRecord(body.agent, "Design Project bootstrap agent", ["agentCommand", "model"]);
    const agentCommand = selection.agentCommand === undefined
      ? undefined
      : string(selection.agentCommand, "agentCommand", 512);
    const model = selection.model === null || selection.model === undefined
      ? selection.model
      : string(selection.model, "model", 512);
    agent = {
      ...(agentCommand === undefined ? {} : { agentCommand }),
      ...(model === undefined ? {} : { model }),
    };
  }
  return {
    schemaVersion: 1,
    idempotencyKey: string(body.idempotencyKey, "idempotencyKey", 160),
    name: string(body.name, "Design Project name", 1_024),
    prompt: string(body.prompt, "Design Project bootstrap prompt", 256 * 1024, true),
    items: body.items.map(assetImportItem),
    ...(agent === undefined ? {} : { agent }),
  };
}

export async function handleBootstrapDesignProject(
  req: IncomingMessage,
  res: ServerResponse,
  _params: Record<string, string>,
  deps: DesignProjectBootstrapHttpDeps,
): Promise<void> {
  const input = bootstrapBody(await readJsonBody(
    req,
    Math.ceil(MAX_DESIGN_ASSET_BATCH_BYTES * 4 / 3) + 2 * 1024 * 1024,
  ));
  if ((input.items.length > 0 || input.prompt.trim()) && !deps.designProjectBootstrapPorts) {
    throw new HttpError(503, "Design Project bootstrap execution is unavailable");
  }
  const unavailable = async (): Promise<never> => {
    throw new HttpError(503, "Design Project bootstrap execution is unavailable");
  };
  try {
    const bootstrap = await bootstrapDesignProject({
      dataDir: deps.dataDir,
      input,
      ports: {
        ensureProject: (project) => ensureDesignProjectAtId(deps.dataDir, project).then(() => undefined),
        ensureAssetBatch: deps.designProjectBootstrapPorts?.ensureAssetBatch ?? unavailable,
        ensureMainTurn: deps.designProjectBootstrapPorts?.ensureMainTurn ?? unavailable,
      },
    });
    const project = await getDesignProject(deps.dataDir, bootstrap.job.projectId);
    if (project === null) throw new HttpError(500, "Design Project bootstrap did not publish its Project");
    sendJson(res, bootstrap.reused ? 200 : 201, {
      project: designProjectPayload(deps.dataDir, project),
      bootstrap,
    });
  } catch (error) {
    if (error instanceof DesignProjectBootstrapError) {
      const status = error.code === "conflict" || error.code === "corrupt" ? 409
        : error.code === "invalid-input" ? 400
          : 503;
      throw new HttpError(status, error.message);
    }
    throw error;
  }
}
