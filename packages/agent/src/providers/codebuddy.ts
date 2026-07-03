import { spawn } from "node:child_process";
import { writeFile, rm, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeCodeRunner } from "../claude-runner.ts";
import { runCapture, augmentedPath, dedupModels } from "./cli.ts";
import type { AgentProvider } from "./types.ts";

/** Older/region builds list models in `--help` ("Currently supported: (id, …)"). */
async function modelsFromHelp(command: string): Promise<string[]> {
  for (const args of [["--help"], ["-p", "--help"]]) {
    const r = await runCapture(command, args, 4000);
    const m = r && /Currently supported:\s*\(([^)]+)\)/i.exec(r.out);
    if (m && m[1]) {
      const ids = dedupModels(m[1].split(",").map((s) => s.trim()));
      if (ids.length) return ids;
    }
  }
  return [];
}

// Current CodeBuddy (2.109+) hides its account model list behind the interactive
// `/model list` TUI — no headless flag exposes it. The only way to read it is to drive a
// real PTY: shell out to `expect` in a throwaway dir, dismiss the trust prompt, type
// `/model list`, and scrape the rendered screen. (Adapted from the vibeos provider scanner.)
// Slow (~35s: session boot + render), so it only runs on an explicit rescan.
const EXPECT_SCRIPT = (bin: string, dir: string): string => `
set stty_init "rows 70 columns 220"
log_user 1
cd ${dir}
spawn ${bin}
set timeout 8
expect { timeout {} eof {} }
send "\\r"
set timeout 6
expect { timeout {} eof {} }
send "/model list"
set timeout 3
expect { timeout {} eof {} }
send "\\r"
set timeout 8
expect { timeout {} eof {} }
send "\\r"
set timeout 6
expect { timeout {} eof {} }
send "\\003"
set timeout 2
expect { timeout {} eof {} }
exit 0
`;

/** Pull model ids out of the de-ANSI'd `/model list` screen. Entries carry the id in
 *  parens; UI words like (escape)/(light) lack a version digit, so a digit is required. */
function parseModelScreen(raw: string): string[] {
  const text = raw
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "") // CSI escapes
    .replace(/\x1b\][^\x07]*\x07/g, "") // OSC sequences
    .replace(/\x1b[()][AB0]/g, "") // charset selects
    .replace(/\r/g, "\n")
    .replace(/[\x00-\x08\x0e-\x1f]/g, "");
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(/\(([a-z0-9][a-z0-9._-]*)\)/gi)) {
    const id = m[1]!.trim();
    if (/\d/.test(id) && !seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

async function scrapeModelList(command: string, timeoutMs = 55_000): Promise<string[]> {
  const dir = await mkdtemp(join(tmpdir(), "dezin-cb-models-"));
  const scriptPath = join(dir, "scrape.exp");
  await writeFile(scriptPath, EXPECT_SCRIPT(command, dir));
  try {
    const out = await new Promise<string>((resolve) => {
      let child;
      try {
        child = spawn("expect", [scriptPath], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, PATH: augmentedPath() } });
      } catch {
        return resolve("");
      }
      let buf = "";
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve(buf);
      }, timeoutMs);
      child.stdout?.setEncoding("utf8");
      child.stdout?.on("data", (d: string) => (buf += d));
      child.on("error", () => {
        clearTimeout(timer);
        resolve(buf);
      });
      child.on("close", () => {
        clearTimeout(timer);
        resolve(buf);
      });
    });
    // The trust prompt echoes the working-dir name in parens; drop it.
    const dirName = dir.split(/[\\/]/).pop() ?? "";
    return dedupModels(parseModelScreen(out)).filter((id) => id !== dirName);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** CodeBuddy — a Claude-Code fork (reuses ClaudeCodeRunner). Models come from `--help` when
 *  it lists them; otherwise, on an explicit rescan, from a PTY scrape of `/model list`. */
export const codebuddyProvider: AgentProvider = {
  id: "codebuddy",
  command: "codebuddy",
  label: "CodeBuddy",
  seedModels: ["claude-opus-4.8", "claude-sonnet-4.6", "claude-haiku-4.5"],
  fastModel: "claude-haiku-4.5",
  async discoverModels(command, deep) {
    const fromHelp = await modelsFromHelp(command);
    if (fromHelp.length) return fromHelp;
    if (deep) return scrapeModelList(command);
    return [];
  },
  createRunner: ({ command, model, enforceArtifactUpdate }) => new ClaudeCodeRunner({ command, model, enforceArtifactUpdate }),
  oneShotArgs: (model, prompt) => ["-p", prompt, "--permission-mode", "bypassPermissions", ...(model ? ["--model", model] : [])],
};
