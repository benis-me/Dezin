import { spawn } from "node:child_process";
import type { Moodboard, MoodboardAsset, MoodboardMessage, MoodboardNode } from "../../../packages/core/src/index.ts";
import { agentSpawnEnv, getProvider } from "../../../packages/agent/src/index.ts";

export interface MoodboardAgentTextInput {
  board: Moodboard;
  nodes: MoodboardNode[];
  assets: MoodboardAsset[];
  messages: MoodboardMessage[];
  content: string;
  agentCommand: string;
  model?: string;
  prompt: string;
  cwd: string;
}

export type MoodboardAgentTextRunner = (input: MoodboardAgentTextInput) => Promise<string>;

function clipped(value: string, max = 700): string {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}...` : text;
}

export function clippedBlock(value: string, max = 8000): string {
  const text = value.trim();
  return text.length > max ? `${text.slice(0, max - 1)}...` : text;
}

function dataString(data: Record<string, unknown>, key: string): string {
  const value = data[key];
  return typeof value === "string" ? value.trim() : "";
}

function nodeLabel(node: MoodboardNode): string {
  return (
    dataString(node.data, "name") ||
    dataString(node.data, "title") ||
    dataString(node.data, "fileName") ||
    dataString(node.data, "generatorPrompt") ||
    dataString(node.data, "content") ||
    node.type
  );
}

function nodeSummary(node: MoodboardNode, assetsById: Map<string, MoodboardAsset>): string {
  const assetId = dataString(node.data, "assetId") || dataString(node.data, "resultAssetId");
  const asset = assetId ? assetsById.get(assetId) : undefined;
  const details = [
    `id=${node.id}`,
    `type=${node.type}`,
    `label="${clipped(nodeLabel(node), 120)}"`,
    `frame=${Math.round(node.x)},${Math.round(node.y)} ${Math.round(node.width)}x${Math.round(node.height)}`,
    asset ? `asset=${asset.fileName} (${asset.source})` : "",
    dataString(node.data, "generatorStatus") ? `status=${dataString(node.data, "generatorStatus")}` : "",
    dataString(node.data, "prompt") ? `prompt="${clipped(dataString(node.data, "prompt"), 180)}"` : "",
    dataString(node.data, "generatorPrompt") ? `generatorPrompt="${clipped(dataString(node.data, "generatorPrompt"), 180)}"` : "",
  ].filter(Boolean);
  return `- ${details.join("; ")}`;
}

function assetSummary(asset: MoodboardAsset): string {
  const size = asset.width && asset.height ? `${asset.width}x${asset.height}` : "unknown size";
  return `- id=${asset.id}; ${asset.kind}; ${asset.fileName}; ${asset.source}; ${size}`;
}

function messageSummary(message: MoodboardMessage, index: number): string {
  return `[${index + 1}] ${message.role.toUpperCase()}: ${clipped(message.content, 900)}`;
}

export function localMoodboardReply(nodes: MoodboardNode[], assets: MoodboardAsset[]): string {
  const typeCounts = nodes.reduce<Record<string, number>>((acc, node) => {
    acc[node.type] = (acc[node.type] ?? 0) + 1;
    return acc;
  }, {});
  const typeText = Object.entries(typeCounts)
    .map(([type, count]) => `${count} ${type}`)
    .join(", ");
  const generators = nodes.filter((node) => node.type === "image-generator");
  const generatorText = generators
    .map((node) => dataString(node.data, "generatorPrompt"))
    .filter(Boolean)
    .slice(0, 3)
    .map((prompt) => `"${clipped(prompt, 100)}"`)
    .join(", ");
  return [
    `Canvas context: ${nodes.length} item${nodes.length === 1 ? "" : "s"}${typeText ? ` (${typeText})` : ""}.`,
    assets.length ? `Assets: ${assets.length} file${assets.length === 1 ? "" : "s"}, including ${assets.slice(0, 3).map((asset) => asset.fileName).join(", ")}.` : "",
    generatorText ? `Image generator prompts on the board: ${generatorText}.` : "",
    "Use an image generator node to place new visual material on the board, or select an existing node to refine its content.",
  ]
    .filter(Boolean)
    .join(" ");
}

export function buildMoodboardAgentPrompt(input: {
  board: Moodboard;
  nodes: MoodboardNode[];
  assets: MoodboardAsset[];
  messages: MoodboardMessage[];
  content: string;
  contextPath: string;
}): string {
  const assetsById = new Map(input.assets.map((asset) => [asset.id, asset]));
  const nodes = input.nodes.length ? input.nodes.map((node) => nodeSummary(node, assetsById)).join("\n") : "- No canvas nodes yet.";
  const assets = input.assets.length ? input.assets.map(assetSummary).join("\n") : "- No uploaded or generated assets yet.";
  const history = input.messages.slice(-18).map(messageSummary).join("\n\n");
  return [
    "You are the Moodboard Agent inside Dezin.",
    "Understand the current canvas and answer the user's latest request with concrete design direction or canvas operation guidance.",
    "Do not create, edit, or write files. Return concise assistant text only.",
    "If the user asks for new image/video material, suggest using an image generator node with a specific prompt. Do not fake photographic assets with SVG or DOM.",
    `Board: ${input.board.name} (${input.board.id})`,
    `Structured context file: ${input.contextPath}`,
    "",
    "Current canvas nodes:",
    nodes,
    "",
    "Assets:",
    assets,
    "",
    history ? `Current conversation:\n${history}` : "Current conversation: no previous messages.",
    "",
    `Latest user request:\n${input.content}`,
  ].join("\n");
}

function spawnMoodboardAgentText(command: string, args: string[], cwd: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"], env: agentSpawnEnv() });
    } catch (e) {
      return reject(e instanceof Error ? e : new Error(String(e)));
    }
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("moodboard agent timed out"));
    }, timeoutMs);
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (d: string) => (stdout += d));
    child.stderr?.on("data", (d: string) => (stderr += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (stdout.trim()) resolve(stdout.trim());
      else reject(new Error(stderr.trim().slice(0, 240) || `${command} exited with ${code}`));
    });
  });
}

export async function runMoodboardAgentText(input: MoodboardAgentTextInput, runner?: MoodboardAgentTextRunner): Promise<string> {
  if (runner) return runner(input);
  const provider = getProvider(input.agentCommand);
  const args = provider ? provider.oneShotArgs(input.model, input.prompt) : ["-p", input.prompt];
  return spawnMoodboardAgentText(input.agentCommand, args, input.cwd, 120_000);
}
