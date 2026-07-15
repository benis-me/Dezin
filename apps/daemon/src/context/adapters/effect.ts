import {
  ContextIntegrityError,
  stableStringify,
  type ResourceContextAdapter,
} from "../context-types.ts";
import { resolveSnapshot, snapshotBytes } from "./file.ts";

export const effectResourceAdapter: ResourceContextAdapter = {
  kind: "effect",
  async snapshot(input) {
    if (input.kind !== "effect" || input.source.type !== "effect-definition") {
      throw new ContextIntegrityError("Effect Resource adapter requires a complete owned Effect definition");
    }
    if (!input.source.definition || typeof input.source.definition !== "object"
      || Array.isArray(input.source.definition)) {
      throw new ContextIntegrityError("Effect definition must be a plain object");
    }
    const definition = structuredClone(input.source.definition);
    if (!Object.keys(definition).length) throw new ContextIntegrityError("Effect definition cannot be empty");
    const payload = {
      format: "dezin-effect-resource",
      version: 1,
      definition,
    };
    return snapshotBytes(input, Buffer.from(`${stableStringify(payload)}\n`, "utf8"), "application/json");
  },
  resolve(input) {
    return resolveSnapshot(input, "effect");
  },
};
