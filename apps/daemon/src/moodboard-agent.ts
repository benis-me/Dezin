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

const NODE_PROMPT_MAX_LINES = 28;
const NODE_PROMPT_MAX_CHARS = 6200;
const ASSET_PROMPT_MAX_LINES = 18;
const ASSET_PROMPT_MAX_CHARS = 2200;
const HISTORY_PROMPT_MAX_MESSAGES = 18;
const HISTORY_PROMPT_MAX_CHARS = 5200;

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

function nodeSearchText(node: MoodboardNode): string {
  return [
    node.type,
    nodeLabel(node),
    dataString(node.data, "prompt"),
    dataString(node.data, "generatorPrompt"),
    dataString(node.data, "content"),
    dataString(node.data, "title"),
    dataString(node.data, "fileName"),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function requestTerms(content: string): string[] {
  const unique = new Set<string>();
  for (const match of content.toLowerCase().matchAll(/[\p{L}\p{N}_-]{2,}/gu)) {
    if (unique.size >= 16) break;
    unique.add(match[0]);
  }
  return [...unique];
}

function rankNodesForRequest(nodes: MoodboardNode[], content: string): MoodboardNode[] {
  const terms = requestTerms(content);
  return [...nodes].sort((a, b) => {
    const score = (node: MoodboardNode) => {
      const text = nodeSearchText(node);
      const termScore = terms.reduce((total, term) => total + (text.includes(term) ? 8 : 0), 0);
      const generatorScore = node.type === "image-generator" ? 4 : 0;
      const mediaScore = node.type === "image" || node.type === "video" ? 3 : 0;
      const recentScore = Math.min(4, Math.max(0, Math.floor((node.updatedAt || node.createdAt || 0) / 1_000_000_000_000)));
      return termScore + generatorScore + mediaScore + recentScore + (node.zIndex ?? 0) / 1000;
    };
    return score(b) - score(a);
  });
}

function budgetLines(lines: string[], fallback: string, maxLines: number, maxChars: number, omittedLabel: string): string {
  if (!lines.length) return fallback;
  const kept: string[] = [];
  let used = 0;
  for (const line of lines) {
    const next = used + line.length + 1;
    if (kept.length >= maxLines || (kept.length > 0 && next > maxChars)) break;
    kept.push(line);
    used = next;
  }
  const omitted = Math.max(0, lines.length - kept.length);
  if (omitted > 0) kept.push(`- ${omitted} more ${omittedLabel} omitted from prompt. Read the structured context file if needed.`);
  return kept.join("\n");
}

function boardStats(nodes: MoodboardNode[], assets: MoodboardAsset[]): string {
  const nodeTypes = nodes.reduce<Record<string, number>>((acc, node) => {
    acc[node.type] = (acc[node.type] ?? 0) + 1;
    return acc;
  }, {});
  const assetSources = assets.reduce<Record<string, number>>((acc, asset) => {
    acc[asset.source] = (acc[asset.source] ?? 0) + 1;
    return acc;
  }, {});
  const typeText = Object.entries(nodeTypes)
    .map(([type, count]) => `${type}:${count}`)
    .join(", ");
  const assetText = Object.entries(assetSources)
    .map(([source, count]) => `${source}:${count}`)
    .join(", ");
  return `Nodes=${nodes.length}${typeText ? ` (${typeText})` : ""}; assets=${assets.length}${assetText ? ` (${assetText})` : ""}.`;
}

function assetSummary(asset: MoodboardAsset): string {
  const size = asset.width && asset.height ? `${asset.width}x${asset.height}` : "unknown size";
  return `- id=${asset.id}; ${asset.kind}; ${asset.fileName}; ${asset.source}; ${size}`;
}

function messageSummary(message: MoodboardMessage, index: number): string {
  return `[${index + 1}] ${message.role.toUpperCase()}: ${clipped(message.content, 900)}`;
}

function budgetHistory(messages: MoodboardMessage[]): string {
  const recent = messages.slice(-HISTORY_PROMPT_MAX_MESSAGES).map(messageSummary);
  if (!recent.length) return "Current conversation: no previous messages.";
  return `Current conversation (recent, budgeted):\n${budgetLines(
    recent,
    "- No previous messages.",
    HISTORY_PROMPT_MAX_MESSAGES,
    HISTORY_PROMPT_MAX_CHARS,
    "messages",
  )}`;
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
  const rankedNodes = rankNodesForRequest(input.nodes, input.content).map((node) => nodeSummary(node, assetsById));
  const nodes = budgetLines(rankedNodes, "- No canvas nodes yet.", NODE_PROMPT_MAX_LINES, NODE_PROMPT_MAX_CHARS, "canvas nodes");
  const assetLines = input.assets
    .slice()
    .sort((a, b) => b.createdAt - a.createdAt)
    .map(assetSummary);
  const assets = budgetLines(assetLines, "- No uploaded or generated assets yet.", ASSET_PROMPT_MAX_LINES, ASSET_PROMPT_MAX_CHARS, "assets");
  const history = budgetHistory(input.messages);
  return [
    "You are the Moodboard Agent inside Dezin.",
    "Understand the current canvas and answer the user's latest request with concrete design direction or canvas operation guidance.",
    "Do not create, edit, or write files. Return concise assistant text only.",
    "If the user asks for new image/video material, suggest using an image generator node with a specific prompt. Do not fake photographic assets with SVG or DOM.",
    "The prompt includes a budgeted working set, not the full canvas. If the shown summaries are insufficient, read the structured context file before answering.",
    `Board: ${input.board.name} (${input.board.id})`,
    `Board summary: ${boardStats(input.nodes, input.assets)}`,
    `Structured context file: ${input.contextPath}`,
    "",
    "Canvas working set:",
    nodes,
    "",
    "Assets working set:",
    assets,
    "",
    history,
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
