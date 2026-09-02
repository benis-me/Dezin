/**
 * At-rest encryption for the few secret settings (API keys) the daemon stores
 * in SQLite. AES-256-GCM with a per-value random nonce; the key comes from the
 * environment (`DEZIN_SECRETS_KEY`, 32 bytes base64url). The desktop shell
 * generates that key and keeps it in the OS keystore; a plain `pnpm dev` without
 * the variable keeps the previous plaintext behavior.
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export interface SecretCipher {
  encrypt(plain: string): string;
  decrypt(stored: string): string;
}

export class SecretCipherError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecretCipherError";
  }
}

const PREFIX = "enc:v1:";
const KEY_BYTES = 32;
const NONCE_BYTES = 12;

export function isEncryptedSecret(value: string): boolean {
  return value.startsWith(PREFIX);
}

export function createSecretCipher(key: Buffer): SecretCipher {
  if (key.length !== KEY_BYTES) throw new SecretCipherError(`secret key must be ${KEY_BYTES} bytes`);
  return {
    encrypt(plain) {
      if (plain === "") return "";
      const nonce = randomBytes(NONCE_BYTES);
      const cipher = createCipheriv("aes-256-gcm", key, nonce);
      const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
      const tag = cipher.getAuthTag();
      return `${PREFIX}${nonce.toString("base64url")}.${tag.toString("base64url")}.${body.toString("base64url")}`;
    },
    decrypt(stored) {
      if (!isEncryptedSecret(stored)) return stored;
      const parts = stored.slice(PREFIX.length).split(".");
      if (parts.length !== 3) throw new SecretCipherError("malformed encrypted secret");
      const [nonce, tag, body] = parts.map((part) => Buffer.from(part!, "base64url"));
      try {
        const decipher = createDecipheriv("aes-256-gcm", key, nonce!);
        decipher.setAuthTag(tag!);
        return Buffer.concat([decipher.update(body!), decipher.final()]).toString("utf8");
      } catch {
        throw new SecretCipherError("encrypted secret does not match the current key");
      }
    },
  };
}

/** Build the cipher from `DEZIN_SECRETS_KEY`; null when the variable is unset. */
export function secretCipherFromEnv(env: NodeJS.ProcessEnv = process.env): SecretCipher | null {
  const raw = env.DEZIN_SECRETS_KEY?.trim();
  if (!raw) return null;
  const key = Buffer.from(raw, "base64url");
  if (key.length !== KEY_BYTES) throw new SecretCipherError("DEZIN_SECRETS_KEY must decode to 32 bytes (base64url)");
  return createSecretCipher(key);
}
