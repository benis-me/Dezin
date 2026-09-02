import type { IncomingMessage, ServerResponse } from "node:http";
import type { SecretCipher } from "@dezin/core";
import { finished } from "node:stream/promises";

import type {
  FigmaCredentialPutInput,
  FigmaImportInput,
} from "@dezin/design-canvas-contracts";

import { HttpError, readJsonBody, sendJson } from "../http-util.ts";
import {
  deleteLocalFigmaCredential,
  FigmaCredentialStoreError,
  getFigmaCredentialStatus,
  putLocalFigmaCredential,
  resolveFigmaCredential,
  type ResolvedFigmaCredential,
} from "./figma-credential-store.ts";
import {
  FigmaImportError,
  importFigmaDesignProject,
  type ImportFigmaDesignProjectOptions,
} from "./figma-import.ts";
import { createFigmaRestClient, FigmaRestError, type FigmaRestClient } from "./figma-rest-client.ts";
import { getDesignCanvas } from "./design-storage.ts";

const MAX_FIGMA_IMPORT_HTTP_BYTES = 64 * 1024;
const MAX_FIGMA_CREDENTIAL_HTTP_BYTES = 8 * 1024;

export type FigmaCredentialProvider = () => Promise<ResolvedFigmaCredential | null>;
export type FigmaProjectLease = NonNullable<ImportFigmaDesignProjectOptions["withProjectLease"]>;

export interface FigmaImportHttpDeps {
  dataDir: string;
  /** Seals the locally stored Figma token at rest (see @dezin/core SecretCipher). */
  secretCipher?: SecretCipher | null;
  figmaClient?: FigmaRestClient;
  figmaCredentialProvider?: FigmaCredentialProvider;
  withFigmaProjectLease?: FigmaProjectLease;
  /** Test-only deterministic pause immediately before the leased Canvas response projection. */
  beforeFigmaProjectResponse?: (projectId: string) => void | Promise<void>;
}

function exactRecord(value: unknown, label: string, fields: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, `${label} must be an object`);
  }
  const record = value as Record<string, unknown>;
  const unexpected = Object.keys(record).find((field) => !fields.includes(field));
  if (unexpected !== undefined) throw new HttpError(400, `${label} contains unexpected field: ${unexpected}`);
  return record;
}

function credentialInput(value: unknown): FigmaCredentialPutInput {
  const record = exactRecord(value, "Figma credential", ["token"]);
  if (typeof record.token !== "string") throw new HttpError(400, "Figma personal access token is invalid");
  return { token: record.token };
}

function upstreamStatus(error: FigmaImportError): number | null {
  const cause = error.cause;
  if (!(cause instanceof FigmaRestError)) return null;
  if (cause.status === 401 || cause.status === 403 || cause.status === 429) return cause.status;
  return null;
}

function importHttpError(error: FigmaImportError): HttpError {
  const upstream = upstreamStatus(error);
  if (upstream !== null) return new HttpError(upstream, error.message);
  const status = error.code === "invalid-input" ? 400
    : error.code === "conflict" || error.code === "corrupt" || error.code === "version-drift" ? 409
      : error.code === "credential" ? 503
        : 502;
  return new HttpError(status, error.message);
}

export async function handleGetFigmaCredential(
  _req: IncomingMessage,
  res: ServerResponse,
  _params: Record<string, string>,
  deps: FigmaImportHttpDeps,
): Promise<void> {
  try {
    sendJson(res, 200, await getFigmaCredentialStatus({ dataDir: deps.dataDir, secretCipher: deps.secretCipher ?? null }));
  } catch (error) {
    if (error instanceof FigmaCredentialStoreError) {
      throw new HttpError(error.code === "invalid-input" ? 400 : 409, error.message);
    }
    throw error;
  }
}

export async function handlePutFigmaCredential(
  req: IncomingMessage,
  res: ServerResponse,
  _params: Record<string, string>,
  deps: FigmaImportHttpDeps,
): Promise<void> {
  const input = credentialInput(await readJsonBody(req, MAX_FIGMA_CREDENTIAL_HTTP_BYTES));
  try {
    sendJson(res, 200, await putLocalFigmaCredential({ dataDir: deps.dataDir, token: input.token, secretCipher: deps.secretCipher ?? null }));
  } catch (error) {
    if (error instanceof FigmaCredentialStoreError) {
      throw new HttpError(error.code === "invalid-input" ? 400 : 409, error.message);
    }
    throw error;
  }
}

export async function handleDeleteFigmaCredential(
  _req: IncomingMessage,
  res: ServerResponse,
  _params: Record<string, string>,
  deps: FigmaImportHttpDeps,
): Promise<void> {
  try {
    sendJson(res, 200, await deleteLocalFigmaCredential({ dataDir: deps.dataDir, secretCipher: deps.secretCipher ?? null }));
  } catch (error) {
    if (error instanceof FigmaCredentialStoreError) {
      throw new HttpError(error.code === "invalid-input" ? 400 : 409, error.message);
    }
    throw error;
  }
}

export async function handleImportFigmaProject(
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  deps: FigmaImportHttpDeps,
  signal?: AbortSignal,
): Promise<void> {
  const decoded = await readJsonBody(req, MAX_FIGMA_IMPORT_HTTP_BYTES, signal);
  try {
    await importFigmaDesignProject({
      dataDir: deps.dataDir,
      projectId: params.id!,
      input: decoded as FigmaImportInput,
      client: deps.figmaClient ?? createFigmaRestClient(),
      credentialProvider: deps.figmaCredentialProvider
        ?? (() => resolveFigmaCredential({ dataDir: deps.dataDir, secretCipher: deps.secretCipher ?? null })),
      ...(deps.withFigmaProjectLease === undefined ? {} : { withProjectLease: deps.withFigmaProjectLease }),
      ...(signal === undefined ? {} : { signal }),
      finalizeUnderProjectLease: async (result) => {
        await deps.beforeFigmaProjectResponse?.(result.manifest.projectId);
        const canvas = await getDesignCanvas(deps.dataDir, result.manifest.projectId);
        sendJson(res, result.reused ? 200 : 201, {
          canvas,
          import: result,
        });
        await finished(res, { cleanup: true });
      },
    });
  } catch (error) {
    if (error instanceof FigmaImportError) throw importHttpError(error);
    throw error;
  }
}
