/**
 * Shared spawn helpers for the agent providers: PATH augmentation, a bounded
 * capture, the default `--version` probe, and a model-id de-duper.
 */

import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { delimiter, dirname } from "node:path";
import { BoundedTextBuffer } from "../bounded-text-buffer.ts";

export const PROVIDER_CAPTURE_LIMIT_BYTES = 1024 * 1024;

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
      child = spawn(command, args, {
        stdio: ["ignore", "pipe", "pipe"],
        env: agentSpawnEnv(),
        shell: process.platform === "win32",
        detached: process.platform !== "win32",
        windowsHide: true,
      });
    } catch {
      return resolve(null);
    }
    const out = new BoundedTextBuffer(PROVIDER_CAPTURE_LIMIT_BYTES);
    let seenBytes = 0;
    let failed = false;
    let settled = false;
    let terminationPromise: Promise<void> | undefined;
    const kill = (signal: NodeJS.Signals): void => {
      try {
        if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch {
        // Process already exited.
      }
    };
    const groupAlive = (): boolean => {
      if (!child.pid || process.platform === "win32") return child.exitCode === null && child.signalCode === null;
      try {
        process.kill(-child.pid, 0);
        return true;
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === "EPERM";
      }
    };
    const waitForGroup = async (timeout: number): Promise<boolean> => {
      const deadline = Date.now() + timeout;
      while (groupAlive() && Date.now() < deadline) {
        await new Promise<void>((resolveDelay) => {
          const delay = setTimeout(resolveDelay, 10);
          delay.unref?.();
        });
      }
      return !groupAlive();
    };
    const terminate = (): Promise<void> => {
      if (terminationPromise) return terminationPromise;
      kill("SIGTERM");
      terminationPromise = (async () => {
        if (await waitForGroup(250)) return;
        kill("SIGKILL");
        await waitForGroup(1_000);
      })();
      return terminationPromise;
    };
    const timer = setTimeout(() => {
      failed = true;
      void terminate();
    }, timeoutMs);
    timer.unref?.();
    const append = (raw: Buffer | Uint8Array): void => {
      if (failed) return;
      const chunk = Buffer.from(raw);
      seenBytes += chunk.length;
      if (seenBytes > PROVIDER_CAPTURE_LIMIT_BYTES) {
        failed = true;
        void terminate();
        return;
      }
      out.append(chunk);
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    child.on("error", () => {
      if (settled) return;
      settled = true;
      void (async () => {
        await terminationPromise?.catch(() => {});
        clearTimeout(timer);
        resolve(null);
      })();
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      void (async () => {
        await terminationPromise?.catch(() => {});
        clearTimeout(timer);
        resolve(failed ? null : { code: code ?? 0, out: out.toString() });
      })();
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
