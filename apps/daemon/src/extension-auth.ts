import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type {
  ExtensionCredential,
  ExtensionCredentialRecord,
  ExtensionScope,
  Store,
} from "../../../packages/core/src/index.ts";
import { HttpError } from "./http-util.ts";

const PAIR_CODE_TTL_MS = 5 * 60_000;

export type RequestPrincipal =
  | { kind: "daemon" }
  | { kind: "extension"; credentialId: string; extensionId: string; scopes: ExtensionScope[] };

export interface ExtensionPairingService {
  createCode(): { code: string; expiresAt: number };
  exchange(code: string, extensionId: string): { token: string; credential: ExtensionCredential };
  authorize(token: string, required: ExtensionScope, extensionId: string): RequestPrincipal;
  revoke(id: string): boolean;
}

export interface ExtensionPairingServiceOptions {
  now?: () => number;
  randomBytes?: (size: number) => Buffer;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function publicCredential(record: ExtensionCredentialRecord): ExtensionCredential {
  const { tokenHash: _tokenHash, ...credential } = record;
  return credential;
}

export class StoreExtensionPairingService implements ExtensionPairingService {
  private readonly codes = new Map<string, number>();
  private readonly store: Store;
  private readonly now: () => number;
  private readonly random: (size: number) => Buffer;

  constructor(store: Store, options: ExtensionPairingServiceOptions = {}) {
    this.store = store;
    this.now = options.now ?? (() => Date.now());
    this.random = options.randomBytes ?? randomBytes;
  }

  createCode(): { code: string; expiresAt: number } {
    const now = this.now();
    for (const [hash, expiresAt] of this.codes) {
      if (expiresAt <= now) this.codes.delete(hash);
    }
    for (;;) {
      const code = String(this.random(4).readUInt32BE(0) % 1_000_000).padStart(6, "0");
      const hash = sha256(code);
      if (this.codes.has(hash)) continue;
      const expiresAt = now + PAIR_CODE_TTL_MS;
      this.codes.set(hash, expiresAt);
      return { code, expiresAt };
    }
  }

  exchange(code: string, extensionId: string): { token: string; credential: ExtensionCredential } {
    const hash = sha256(code.trim());
    const expiresAt = this.codes.get(hash);
    if (expiresAt === undefined) throw new HttpError(400, "invalid or expired pairing code");
    this.codes.delete(hash);
    if (expiresAt <= this.now()) throw new HttpError(400, "invalid or expired pairing code");

    const token = `dezin_ext_${this.random(32).toString("base64url")}`;
    const credential = this.store.createExtensionCredential({
      tokenHash: sha256(token),
      extensionId,
      scopes: ["capture:write", "image:analyze"],
    });
    return { token, credential: publicCredential(credential) };
  }

  authorize(token: string, required: ExtensionScope, extensionId: string): RequestPrincipal {
    const suppliedHash = Buffer.from(sha256(token), "hex");
    const record = this.store.listExtensionCredentials().find((candidate) => {
      const storedHash = Buffer.from(candidate.tokenHash, "hex");
      return storedHash.length === suppliedHash.length && timingSafeEqual(storedHash, suppliedHash);
    });
    if (!record) throw new HttpError(401, "extension credential rejected");
    if (record.extensionId !== extensionId) throw new HttpError(403, "extension origin does not match credential");
    if (!record.scopes.includes(required)) throw new HttpError(403, "extension scope required");
    this.store.touchExtensionCredential(record.id);
    return {
      kind: "extension",
      credentialId: record.id,
      extensionId: record.extensionId,
      scopes: record.scopes,
    };
  }

  revoke(id: string): boolean {
    return this.store.revokeExtensionCredential(id);
  }
}
