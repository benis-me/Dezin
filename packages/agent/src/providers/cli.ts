/**
 * Shared spawn helpers for the agent providers: PATH augmentation, a bounded
 * capture, the default `--version` probe, and a model-id de-duper.
 */

import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { delimiter, dirname } from "node:path";

/** PATH augmented with well-known toolchain dirs so a minimal-env daemon (e.g. the desktop
 *  app launched from Finder, or a fresh machine) still finds CLIs. Critically this includes
 *  the running Node's own bin dir — npm-global CLIs like `codex`/`codebuddy` install next to
 *  `node`, so without it they vanish whenever the launch PATH lacks the toolchain dir. */
export function augmentedPath(): string {
  const home = homedir();
  const extra = [
    dirname(process.execPath), // the active node's bin dir — where npm-global agents live
    `${home}/.local/bin`,
    `${home}/.bun/bin`,
    `${home}/.deno/bin`,
    `${home}/.npm-global/bin`,
    `${home}/.cargo/bin`,
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
  ];
  return [process.env.PATH ?? "", ...extra].filter(Boolean).join(delimiter);
}

/** Environment shared by real agent/tool spawns, matching probe PATH and disabling host hooks. */
export function agentSpawnEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH: augmentedPath(),
    IMPECCABLE_HOOK_DISABLED: "1",
    IMPECCABLE_HOOK_QUIET: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    ...extra,
  };
}

/** Spawn `<command> <args>` on the augmented PATH and capture stdout+stderr (bounded). */
export function runCapture(command: string, args: string[], timeoutMs: number): Promise<{ code: number; out: string } | null> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], env: agentSpawnEnv(), shell: process.platform === "win32" });
    } catch {
      return resolve(null);
    }
    let out = "";
    const timer = setTimeout(() => {
      child.kill();
      resolve(null);
    }, timeoutMs);
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (d: string) => (out += d));
    child.stderr?.on("data", (d: string) => (out += d));
    child.on("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 0, out });
    });
  });
}

export interface VersionProbe {
  available: boolean;
  version?: string;
}

/** Default availability probe: `<command> --version` on the augmented PATH. */
export async function probeVersion(command: string): Promise<VersionProbe> {
  const r = await runCapture(command, ["--version"], 3000);
  if (!r || r.code !== 0) return { available: false };
  return { available: true, version: r.out.trim().split("\n")[0] || undefined };
}

/** Keep only well-formed, unique model ids. */
export const dedupModels = (ids: string[]): string[] => [...new Set(ids.filter((s) => /^[a-z0-9][a-z0-9._-]*$/i.test(s)))];
